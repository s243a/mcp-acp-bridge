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
      if (runtime) gateway.closeSession(runtime.token);
      runtimes.delete(sessionId);
    },

    runTurn: async ({ sessionId, prompt, signal, emitText }) => {
      const runtime = runtimes.get(sessionId);
      if (!runtime) throw new Error(`no runtime for session ${sessionId}`);

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
      const text = await runProcess(adapter, args, { cwd, signal, onText: emitText });
      runtime.started = true;
      return { stopReason: "end_turn", text };
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

function runProcess(adapter, args, { cwd, signal, onText }) {
  return new Promise((resolve, reject) => {
    const child = spawn(adapter.command, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let out = "";
    let err = "";

    const onAbort = () => child.kill("SIGTERM");
    signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      out += chunk;
      // Stream as it arrives so the client sees progress mid-turn.
      onText?.(adapter.readText(chunk));
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
      resolve(out);
    });
  });
}
