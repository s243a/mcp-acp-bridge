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
import { createPtySession } from "./ptySession.js";
import { createTaskChannel } from "./taskChannel.js";
import { prepareAgentHome } from "./agentHome.js";
import { prepareWorkspace } from "./workspaceConfig.js";
import { getAdapter } from "./agents.js";
import { makeGate } from "./gate.js";
import { makePolicy, withPolicy } from "./policy.js";

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

  // Policy first, human second: allow and deny never reach a person, so a
  // subagent's forty reads do not become forty prompts.
  const defaultPolicy = makePolicy(options.policy, { log });
  const gate = makeGate(
    withPolicy((call) => runtimes.get(call.sessionId)?.policy ?? defaultPolicy, (call) => acp.decide(call), {
      onDecision: ({ tool, verdict, reason }) => log(`[policy] ${verdict} ${tool} (${reason})`),
    }),
    { timeoutMs: options.timeoutMs },
  );

  // Present when the agent receives its turn over MCP rather than by typing.
  const taskChannel = adapter.turnsOverMcp ? createTaskChannel({ log }) : null;

  const gateway = createGateway({
    tools: [...(options.tools ?? []), ...(taskChannel?.toolDefinitions() ?? [])],
    gate,
    onToolCall: (event) => log(`[tool] ${event.phase} ${event.tool}`),
  });

  const server = await gateway.listen();

  acp = createAcpServer({
    input: options.input,
    output: options.output,
    onError: (error, method) => log(`[acp] ${method} failed: ${error?.message}`),

    createSession: () => {
      const session = gateway.openSession();
      const url = server.url(session.token);
      const runtime = { token: session.token, url, started: false, policy: defaultPolicy, cwd };
      // Agents without an MCP flag find the endpoint through the workspace.
      if (adapter.mcpViaWorkspaceFile) {
        const prepared = prepareWorkspace({
          mode: options.workspaceMode ?? adapter.defaultWorkspaceMode ?? "project",
          projectDir: cwd,
          url,
          toolNames: (options.tools ?? []).map((tool) => tool.name),
          log,
        });
        runtime.workspace = prepared;
        // Deny rules survive the permission skip, so protect the paths that
        // would hurt most even though this is a denylist, not a jail.
        if (adapter.deniesViaAgentHome && options.denyPaths !== false) {
          runtime.home = prepareAgentHome({
            ...(Array.isArray(options.denyPaths) ? { denyPaths: options.denyPaths } : {}),
            // Without trust, the workspace's MCP registration is ignored.
            trustedWorkspaces: [runtime.cwd ?? cwd],
            // Interactive agy reads MCP servers from the shared config, not the
            // workspace file, so a PTY session needs it registered there too.
            // Interactive agy reads the shared config, and wants `serverUrl` —
            // the legacy `url`/`type` pair registers as a server with no tools.
            ...(adapter.pty ? { mcpServers: { "mcp-acp-bridge": { serverUrl: url } } } : {}),
            // The task channel is transport, not work: prompting for it would
            // stall the turn before the agent ever sees its instructions.
            ...(adapter.turnsOverMcp ? { allowRules: ["mcp(mcp-acp-bridge/*)"] } : {}),
            log,
          });
        }
        // The agent runs where its tools can reach, which is not always the
        // caller's directory.
        runtime.cwd = prepared.dir;
      }
      runtimes.set(session.sessionId, runtime);
      return { sessionId: session.sessionId };
    },

    onConfigOption: ({ sessionId, configId, value }) => {
      const runtime = runtimes.get(sessionId);
      if (!runtime || configId !== "review") return;
      runtime.policy = makePolicy(String(value), { log });
      log(`[policy] session ${sessionId} review set to ${value}`);
    },

    onSessionEnd: (sessionId) => {
      const runtime = runtimes.get(sessionId);
      if (runtime) {
        runtime.agent?.stop();
        runtime.workspace?.release();
        runtime.home?.release();
        gateway.closeSession(runtime.token);
      }
      runtimes.delete(sessionId);
    },

    onSetModel: async ({ sessionId, modelId }) => {
      // A terminal agent changes model the way a user would. Agents driven any
      // other way have no equivalent, so this is quietly a no-op for them.
      const runtime = runtimes.get(sessionId);
      if (!runtime?.agent?.selectModel || typeof modelId !== "string" || !modelId) return;
      log(`[agent] switching model to ${modelId}`);
      // Best-effort: a model that cannot be selected should not fail the
      // session, and the name is the user's to correct.
      await runtime.agent.selectModel(modelId).catch((error) => {
        log(`[agent] could not switch model: ${error?.message ?? error}`);
      });
    },
    runTurn: async ({ sessionId, prompt, signal, emitText, emitTool }) => {
      const runtime = runtimes.get(sessionId);
      if (!runtime) throw new Error(`no runtime for session ${sessionId}`);

      // A terminal-driven agent: steerable, at the cost of prose arriving as a
      // redrawing screen rather than as deltas.
      if (adapter.pty) {
        // Queue the turn before the agent exists: the first nudge rides in argv,
        // so the agent can ask for its task moments after spawn.
        const answered = taskChannel ? taskChannel.runTurn(sessionId, prompt, { signal }) : null;
        const launching = !runtime.agent;
        runtime.agent ??= createPtySession({
          command: adapter.command,
          args: adapter.buildSessionArgs({
            cwd: runtime.cwd ?? cwd,
            ...(taskChannel ? { initialPrompt: adapter.nudge } : {}),
          }),
          cwd: runtime.cwd ?? cwd,
          ...(runtime.home ? { env: { HOME: runtime.home.dir } } : {}),
          // When answers come over MCP the terminal carries only the echoed
          // nudge and spinner frames, which a redrawing screen shreds. The
          // submitted result is the answer, so the screen stays out of the
          // transcript.
          ...(taskChannel ? {} : { onText: emitText }),
          log,
        });
        if (answered) {
          // A launching session already carries the nudge; only later turns have
          // to be typed, which is also the only time readiness has to be right.
          if (launching) {
            runtime.agent.start();
          } else {
            await runtime.agent.prompt(adapter.nudge, { signal }).catch((error) => {
              // The nudge completing is not the turn completing; a terminal that
              // misreads its own screen must not fail a turn the agent may still
              // be working on.
              log(`[agent] nudge returned: ${error?.message ?? "ok"}`);
            });
          }
          const outcome = await answered;
          if (outcome.text) emitText(outcome.text);
          runtime.started = true;
          return { stopReason: "end_turn", text: outcome.text };
        }

        const outcome = await runtime.agent.prompt(prompt, { signal });
        runtime.started = true;
        return { stopReason: "end_turn", text: outcome.text };
      }

      // A persistent agent keeps one conversation for the whole ACP session,
      // so startup and context are paid once rather than per turn.
      if (adapter.persistent) {
        runtime.agent ??= createAgentSession({
          adapter,
          cwd: runtime.cwd ?? cwd,
          ...(runtime.home ? { env: { HOME: runtime.home.dir } } : {}),
          onText: emitText,
          onTool: emitTool,
          skipAgentPermissions: options.skipAgentPermissions === true,
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
    policy: defaultPolicy,
    async close() {
      // Sessions may still hold a workspace registration; leaving one behind
      // would put a stale endpoint in someone's project.
      for (const runtime of runtimes.values()) {
        runtime.agent?.stop();
        runtime.workspace?.release();
        runtime.home?.release();
      }
      runtimes.clear();
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
