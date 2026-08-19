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

export function createAgentSession({ adapter, cwd, env, onText, onTool, log = () => {} }) {
  let child = null;
  let pending = "";
  /** Resolver for the turn currently in flight. */
  let active = null;
  /** Turns waiting for the agent to finish the current one. */
  const queue = [];
  let exitInfo = null;

  function start() {
    if (child) return;
    const args = adapter.buildSessionArgs({ cwd });
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
      // An agent that dies mid-turn must not leave the caller waiting.
      failAll(new Error(`${adapter.command} exited (${code}) with a turn in flight`));
    });
  }

  function handleRecord(record) {
    if (!record || !active) return;
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
          turn.reject(new Error(`${adapter.command} reported ${record.agentStatus ?? "a failure"}`));
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

  /** Hand the next queued turn to the agent, if it is idle. */
  function pump() {
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
            // Interrupting the agent is not expressible on this channel, so a
            // cancelled turn stops the process rather than pretending to steer
            // it. A steerable transport is what the dual-channel profile is for.
            if (active === turn) stop();
            reject(new Error("cancelled"));
          },
          { once: true },
        );
        queue.push(turn);
        pump();
      });
    },
    running: () => child !== null,
    stop() {
      queue.length = 0;
      active = null;
      if (!child) return;
      try {
        child.stdin.end();
      } catch {
        /* already closed */
      }
      child.kill("SIGTERM");
      child = null;
    },
  };
}
