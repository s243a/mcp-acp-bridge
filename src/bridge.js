/**
 * The bridge: ACP in, MCP out, an agent subprocess in the middle.
 *
 * Wires the three pieces that already exist separately —
 *   acpServer  speaks ACP to the client and decides permissions,
 *   mcpGateway hosts the agent's MCP endpoint and holds each tool call,
 *   agents     knows how to launch and feed one CLI —
 * so a tool call the agent makes arrives at the client as an approval card.
 */
import { spawn } from "node:child_process";

import { createAcpServer } from "./acpServer.js";
import { createGateway } from "./mcpGateway.js";
import { createAgentSession } from "./agentSession.js";
import { getAdapter } from "./agents.js";
import { makeGate } from "./gate.js";

/**
 * @param {{
 *   agent?: string,
 *   cwd?: string,
 *   tools?: Array<object>,
 *   timeoutMs?: number,
 *   input?: NodeJS.ReadableStream,
 *   output?: NodeJS.WritableStream,
 *   log?: (msg: string) => void,
 * }} [options]
 */
export async function startBridge(options = {}) {
  const adapter = getAdapter(options.agent ?? "claude");
  const cwd = options.cwd ?? process.cwd();
  const log = options.log ?? (() => {});

  /** sessionId -> { token, url, started } */
  const runtimes = new Map();

  // Declared first so the gateway can reach the ACP decider; assigned below.
  let acp;

  const gateway = createGateway({
    tools: options.tools ?? [],
    gate: makeGate((call) => acp.decide(call), { timeoutMs: options.timeoutMs }),
    onToolCall: (event) => log(`[tool] ${event.phase} ${event.tool}`),
  });

  const server = await gateway.listen();

  acp = createAcpServer({
    input: options.input,
    output: options.output,
    onError: (error, method) => log(`[acp] ${method} failed: ${error?.message}`),

    createSession: () => {
      const session = gateway.openSession();
      runtimes.set(session.sessionId, {
        token: session.token,
        url: server.url(session.token),
        started: false,
      });
      return { sessionId: session.sessionId };
    },

    onSessionEnd: (sessionId) => {
      const runtime = runtimes.get(sessionId);
      if (runtime) {
        runtime.agent?.stop();
        gateway.closeSession(runtime.token);
      }
      runtimes.delete(sessionId);
    },

    runTurn: async ({ sessionId, prompt, signal, emitText, emitTool }) => {
      const runtime = runtimes.get(sessionId);
      if (!runtime) throw new Error(`no runtime for session ${sessionId}`);

      // A persistent agent keeps one conversation for the whole ACP session,
      // so startup and context are paid once rather than per turn.
      if (adapter.persistent) {
        runtime.agent ??= createAgentSession({
          adapter,
          cwd,
          onText: emitText,
          onTool: emitTool,
          log,
        });
        const outcome = await runtime.agent.prompt(prompt, { signal });
        runtime.started = true;
        return { stopReason: "end_turn", text: outcome.text };
      }

      const mcpConfig = JSON.stringify({
        mcpServers: { bridge: { type: "http", url: runtime.url } },
      });
      const allowedTools = (options.tools ?? []).map((t) => `mcp__bridge__${t.name}`);

      const args = adapter.buildArgs({
        prompt,
        cwd,
        mcpConfig,
        allowedTools,
        resume: runtime.started,
      });

      log(`[agent] ${adapter.command} turn (resume=${runtime.started})`);
      const outcome = await runProcess(adapter, args, {
        cwd,
        signal,
        onText: emitText,
        onTool: emitTool,
      });
      runtime.started = true;
      // ACP defines the stop-reason vocabulary; a completed run is end_turn
      // regardless of what the agent calls it.
      return { stopReason: "end_turn", text: outcome.text };
    },
  });

  return {
    acp,
    gateway,
    port: server.port,
    async close() {
      await server.close();
      acp.peer.close();
    },
  };
}

function runProcess(adapter, args, { cwd, signal, onText, onTool }) {
  return new Promise((resolve, reject) => {
    const child = spawn(adapter.command, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let out = "";
    let err = "";
    let pending = "";
    let agentStatus;
    let ok = true;

    const onAbort = () => child.kill("SIGTERM");
    signal?.addEventListener("abort", onAbort, { once: true });

    /** Dispatch one structured record from a line-oriented agent. */
    const handleRecord = (record) => {
      if (!record) return;
      if (record.kind === "text") {
        out += record.text;
        onText?.(record.text);
        return;
      }
      if (record.kind === "tool") {
        onTool?.(record);
        return;
      }
      if (record.kind === "result") {
        // The result carries the whole answer; text deltas already streamed it,
        // so keep it only when nothing streamed.
        if (!out) out = record.text ?? "";
        agentStatus = record.agentStatus;
        ok = record.ok !== false;
      }
    };

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      if (!adapter.parseLine) {
        out += chunk;
        // Stream as it arrives so the client sees progress mid-turn.
        onText?.(adapter.readText(chunk));
        return;
      }
      // Line-oriented agents: a partial trailing line waits for its newline.
      pending += chunk;
      let index;
      while ((index = pending.indexOf("\n")) !== -1) {
        const line = pending.slice(0, index).trim();
        pending = pending.slice(index + 1);
        if (line) handleRecord(adapter.parseLine(line));
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => (err += chunk));

    child.on("error", (error) => {
      signal?.removeEventListener("abort", onAbort);
      reject(new Error(`failed to launch '${adapter.command}': ${error.message}`));
    });

    child.on("close", (code) => {
      signal?.removeEventListener("abort", onAbort);
      if (signal?.aborted) return reject(new Error("cancelled"));
      if (code !== 0) {
        return reject(new Error(`${adapter.command} exited ${code}${err ? `: ${err.trim()}` : ""}`));
      }
      if (adapter.parseLine && pending.trim()) {
        handleRecord(adapter.parseLine(pending.trim()));
      }
      if (!ok) {
        return reject(
          new Error(`${adapter.command} reported ${agentStatus ?? "a failure"}`),
        );
      }
      resolve({ text: out, agentStatus });
    });
  });
}
