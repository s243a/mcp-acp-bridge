/**
 * Drive `codex mcp-server` as an MCP client over stdio.
 *
 * Unlike the other adapters, here codex is the MCP *server* and the bridge is
 * its client: the turn is delivered as a `codex` / `codex-reply` tool call, the
 * message streams back as `codex/event` deltas, and codex asks *us* to approve
 * its own shell and patches via `elicitation/create`. That last part is the
 * point — it is a native gate on codex's real actions, with the command text in
 * hand, rather than the coarse `-s read-only` the `codex exec` adapter settles
 * for.
 *
 * The stdio pipe is local to codex's machine; nothing here crosses the network.
 * What travels the fabric is ACP, spoken by the bridge to its client.
 */
import { spawn } from "node:child_process";
import { createPeer } from "./jsonRpc.js";

export function createCodexMcpSession({
  cwd,
  env,
  sandbox = "workspace-write",
  approvalPolicy = "untrusted",
  model,
  onElicit,
  log,
  // Overridable so tests can point at a fake mcp-server; production is codex.
  command = "codex",
  args = ["mcp-server"],
} = {}) {
  const child = spawn(command, args, {
    cwd,
    env: env ? { ...process.env, ...env } : process.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    if (process.env.BRIDGE_CODEX_LOG) log?.(`[codex] ${chunk.trim()}`);
  });

  const peer = createPeer({
    input: child.stdout,
    output: child.stdin,
    onError: (error, where) => log?.(`[codex-mcp] ${where}: ${error.message}`),
  });

  let threadId;
  let ready;
  // Set for the duration of a single prompt() so the event stream knows where
  // to send deltas; cleared when the turn resolves.
  let sink;

  peer.on("codex/event", (params) => {
    const msg = params?.msg;
    if (!msg) return;
    if (msg.type === "agent_message_content_delta" && typeof msg.delta === "string") {
      sink?.(msg.delta);
    }
    const tid = params?._meta?.threadId ?? msg.thread_id;
    if (tid && !threadId) threadId = tid;
  });

  // codex's own exec / patch approvals arrive here as MCP elicitations. The
  // decision is the caller's (it routes to the bridge's gate); the wire form is
  // MCP's accept/decline. A missing handler declines — fail closed.
  peer.on("elicitation/create", async (params) => {
    const allow = onElicit ? await onElicit(params) : false;
    // codex reads a top-level `decision` (not just MCP's `action`): approving
    // needs both, and either alone leaves the command rejected.
    return allow
      ? { action: "accept", decision: "approved" }
      : { action: "decline", decision: "denied" };
  });

  async function init() {
    ready ??= (async () => {
      await peer.request("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: { elicitation: {} },
        clientInfo: { name: "mcp-acp-bridge", version: "0" },
      });
      peer.notify("notifications/initialized", {});
    })();
    return ready;
  }

  return {
    /** Run one turn; resumes the same codex thread after the first. */
    async prompt(text, { signal, onText } = {}) {
      await init();
      let streamed = false;
      sink = (delta) => {
        streamed = true;
        onText?.(delta);
      };
      const onAbort = () => child.kill("SIGTERM");
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        const call = threadId
          ? { name: "codex-reply", arguments: { threadId, prompt: text } }
          : {
              name: "codex",
              arguments: {
                prompt: text,
                cwd,
                sandbox,
                "approval-policy": approvalPolicy,
                ...(model ? { model } : {}),
              },
            };
        const result = await peer.request("tools/call", { name: call.name, arguments: call.arguments });
        const structured = result?.structuredContent ?? {};
        if (structured.threadId) threadId = structured.threadId;
        const content = structured.content ?? textFromContent(result?.content) ?? "";
        // Older codex builds may not stream deltas; if nothing streamed, the
        // final content is the whole answer and the client saw nothing yet.
        if (!streamed && content) onText?.(content);
        return { text: content, threadId };
      } finally {
        signal?.removeEventListener("abort", onAbort);
        sink = undefined;
      }
    },
    get threadId() {
      return threadId;
    },
    stop() {
      peer.close();
      try {
        child.kill("SIGTERM");
      } catch {}
    },
  };
}

function textFromContent(content) {
  if (!Array.isArray(content)) return undefined;
  return content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("");
}
