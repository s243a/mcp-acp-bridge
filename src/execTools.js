/**
 * Execution offered as MCP tools, so it can be gated.
 *
 * An agent's built-in shell tool runs before anything here can see it, and the
 * agent decides for itself whether to ask. Routing execution through MCP moves
 * that decision to the gate, which is the point: a held call carries the actual
 * command, so a policy or a person reviews *what will run* rather than the fact
 * that something will.
 *
 * This closes the gap that makes tool-name review insufficient. An agent that
 * cannot run a command directly can still write a script and ask for the script
 * to be run — the write is harmless and the run is not, so the run is where the
 * decision belongs, with the command in hand.
 *
 * Offering these does not by itself stop an agent using its own tools instead.
 * A deny rule does that; this is the path left open once the other is closed.
 *
 * @module execTools
 */
import { spawn } from "node:child_process";
import { resolve } from "node:path";

/** Beyond this, output is the agent's problem to narrow, not ours to stream. */
const MAX_OUTPUT = 60_000;
const DEFAULT_TIMEOUT_MS = 120_000;

const truncate = (text) =>
  text.length > MAX_OUTPUT ? `${text.slice(0, MAX_OUTPUT)}\n…[truncated]` : text;

/**
 * Run one command and describe what happened.
 *
 * Failure is reported, not thrown: a non-zero exit is information the agent
 * asked for, and hiding it behind an error loses the output that explains it.
 */
function runCommand({ command, cwd, timeoutMs }) {
  return new Promise((resolvePromise) => {
    const child = spawn(command, {
      shell: true,
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.on("error", (error) => {
      clearTimeout(timer);
      resolvePromise({ ok: false, detail: `could not run: ${error?.message ?? error}` });
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      const parts = [];
      if (stdout.trim()) parts.push(truncate(stdout.trimEnd()));
      if (stderr.trim()) parts.push(`[stderr]\n${truncate(stderr.trimEnd())}`);
      if (timedOut) parts.push(`[killed after ${timeoutMs}ms]`);
      if (code !== 0 && !timedOut) parts.push(`[exit ${code}]`);
      resolvePromise({
        ok: code === 0 && !timedOut,
        detail: parts.join("\n") || "[no output]",
      });
    });
  });
}

/**
 * Execution tools, resolving their workspace per session.
 *
 * `resolveCwd` is asked where a session's commands run, since the tool list is
 * built once and sessions arrive later with workspaces of their own. A relative
 * directory is resolved against that root; an absolute one is honoured, because
 * the gate — not this module — decides whether a path is acceptable.
 */
export function createExecTools({ resolveCwd, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  return [
    {
      name: "run_command",
      description:
        "Run a shell command and return its output. Use this instead of any built-in command or terminal tool, including for running a file you have just written. Commands are reviewed before they run, so state the command exactly as it should execute. When you show the output to the user, put it in a fenced code block: it is rendered as Markdown, so unfenced column-aligned output collapses into one unreadable line.",
      inputSchema: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "The exact shell command to run, e.g. `node build.js --watch`.",
          },
          cwd: {
            type: "string",
            description:
              "Directory to run in. Relative paths resolve against the workspace. Defaults to the workspace root.",
          },
        },
        required: ["command"],
      },
      handler: async (args, context) => {
        const command = typeof args?.command === "string" ? args.command.trim() : "";
        if (!command) return "Error: a command is required.";
        const root = resolveCwd?.(context?.sessionId) ?? process.cwd();
        const where =
          typeof args?.cwd === "string" && args.cwd ? resolve(root, args.cwd) : root;
        const { detail } = await runCommand({ command, cwd: where, timeoutMs });
        return detail;
      },
    },
  ];
}
