/**
 * A long-lived agent process that takes one turn at a time.
 *
 * Print mode spawns a process per turn, so every turn pays startup and re-reads
 * its context. An agent that accepts turns on stdin and answers on stdout keeps
 * one conversation alive instead, which is both faster and the only way a
 * follow-up turn can mean anything.
 *
 * Turns are serialised. The agent has one conversation, so a second prompt
 * arriving mid-turn queues rather than interleaving — interleaved turns would
 * produce output no client could attribute.
 */
import { spawn } from "node:child_process";

export function createAgentSession({
  adapter,
  cwd,
  env,
  onText,
  onTool,
  skipAgentPermissions = false,
  log = () => {},
}) {
  let child = null;
  let pending = "";
  /** Resolver for the turn currently in flight. */
  let active = null;
  /** Turns waiting for the agent to finish the current one. */
  const queue = [];
  let exitInfo = null;
  /** Set from the agent's own events; what makes a cancelled turn recoverable. */
  let conversationId = null;
  /** Resolves when a killed process has fully exited. */
  let exited = null;
  /** True while a stop we asked for is in progress. */
  let stopping = false;

  let resolveExited = null;

  function start() {
    if (child) return;
    const args = adapter.buildSessionArgs({
      cwd,
      skipAgentPermissions,
      ...(conversationId ? { resumeConversationId: conversationId } : {}),
    });
    if (conversationId) log(`[agent] resuming conversation ${conversationId}`);
    log(`[agent] starting persistent ${adapter.command}`);
    child = spawn(adapter.command, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      pending += chunk;
      let index;
      while ((index = pending.indexOf("\n")) !== -1) {
        const line = pending.slice(0, index).trim();
        pending = pending.slice(index + 1);
        if (line) handleRecord(adapter.parseLine(line));
      }
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => log(`[agent stderr] ${String(chunk).trim().slice(0, 300)}`));

    child.on("error", (error) => failAll(new Error(`failed to launch '${adapter.command}': ${error.message}`)));
    child.on("close", (code) => {
      exitInfo = code;
      child = null;
      resolveExited?.();
      if (stopping) {
        // We asked for this. Queued turns are waiting to resume, not to fail.
        stopping = false;
        return;
      }
      // An agent that dies on its own must not leave the caller waiting.
      failAll(new Error(`${adapter.command} exited (${code}) with a turn in flight`));
    });
  }

  function handleRecord(record) {
    if (!record) return;
    // Session identity arrives before any turn and must be kept regardless of
    // whether one is in flight — it is the handle a cancelled session comes
    // back on.
    if (record.kind === "session") {
      conversationId = record.conversationId;
      return;
    }
    if (record.conversationId) conversationId = record.conversationId;
    if (!active) return;
    switch (record.kind) {
      case "text":
        active.text += record.text;
        onText?.(record.text);
        return;
      case "tool":
        onTool?.(record);
        return;
      case "result": {
        const turn = active;
        active = null;
        if (record.ok === false) {
          // Carry whatever the agent said with the failure; a bare status
          // tells a user nothing about what went wrong.
          const detail = (record.text ?? "").trim();
          turn.reject(
            new Error(
              `${adapter.command} reported ${record.agentStatus ?? "a failure"}` +
                (detail ? `: ${detail.slice(0, 300)}` : ""),
            ),
          );
        } else {
          turn.resolve({ text: turn.text || record.text || "", agentStatus: record.agentStatus });
        }
        pump();
        return;
      }
      default:
        return;
    }
  }

  function failAll(error) {
    const waiting = active ? [active, ...queue] : [...queue];
    active = null;
    queue.length = 0;
    for (const turn of waiting) turn.reject(error);
  }

  /** Stop the process but keep the conversation id, so a turn can resume it. */
  function stopProcess() {
    queue.length = 0;
    active = null;
    if (!child) return;
    // Deliberately no stdin.end(): for a stream-json agent that is "no more
    // turns". Signal alone is what a resumable stop looks like.
    stopping = true;
    exited = new Promise((resolve) => {
      resolveExited = resolve;
    });
    child.kill("SIGTERM");
    child = null;
  }

  /**
   * Hand the next queued turn to the agent, if it is idle.
   *
   * Waits for a previous process to finish exiting first: agy holds its
   * conversation state while shutting down, and resuming into it before the old
   * process is gone fails the turn outright.
   */
  async function pump() {
    if (active || queue.length === 0) return;
    if (exited) {
      await exited;
      exited = null;
    }
    if (active || queue.length === 0) return;
    start();
    if (!child) return;
    active = queue.shift();
    child.stdin.write(`${adapter.encodeTurn(active.prompt)}\n`);
  }

  return {
    /** Run one turn, waiting behind any already in flight. */
    prompt(text, { signal } = {}) {
      if (exitInfo !== null && !child) exitInfo = null;
      return new Promise((resolve, reject) => {
        const turn = { prompt: text, text: "", resolve, reject };
        signal?.addEventListener(
          "abort",
          () => {
            // SIGINT ends agy outright rather than interrupting a turn, so
            // stopping means killing the process. The conversation id is kept,
            // so the next turn resumes rather than starting over — "stop this
            // turn", not "lose the conversation".
            if (active === turn) stopProcess();
            reject(new Error("cancelled"));
          },
          { once: true },
        );
        queue.push(turn);
        pump();
      });
    },
    running: () => child !== null,
    /** The conversation a resumed process would rejoin. */
    conversationId: () => conversationId,
    /** End the session for good; a later turn starts a fresh conversation. */
    stop() {
      conversationId = null;
      stopProcess();
    },
  };
}
