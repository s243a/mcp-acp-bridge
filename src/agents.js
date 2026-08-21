/**
 * Agent adapters — the only place agent-specific knowledge lives.
 *
 * An adapter answers four questions: how to launch it, how to point it at an
 * MCP endpoint, how to feed it one turn, and how to read its output back.
 * Everything else in the bridge is agent-agnostic.
 *
 * Output comes in two shapes. A `readText` adapter runs in plain print mode and
 * its stdout *is* the answer. A `parseLine` adapter emits one structured record
 * per line, which is strictly better: tool calls, their arguments, and turn
 * completion arrive as data instead of prose to be guessed at.
 *
 * `restrictToMcp` records whether the agent can be confined to bridge-provided
 * tools. When it can, the gate sees every action the agent takes; when it
 * cannot, the gate still sees every MCP call and the agent's own tools run
 * under its own permission config. Both are supported — the restriction is a
 * security upgrade, not a requirement.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Assistant text arrives on stdout for CLIs run in one-shot print mode. */
const textFromStdout = (chunk) => chunk;

/** One line, because the real instruction arrives over MCP. */
const DUAL_NUDGE =
  "Call the next_task tool to get your task, carry it out, then call submit_result with your full answer.";

/** Where a workspace states its rules, most specific first. */
export const RULES_FILES = ["GEMINI.md", "AGENTS.md"];

/** Big enough for real rules, small enough to sit in argv without comment. */
export const MAX_RULES_CHARS = 4000;

/**
 * The workspace's own rules, read from disk.
 *
 * Agents load these hierarchically by themselves, so this is belt and braces —
 * but the alternative, telling the agent to go and read the file, spends a tool
 * call to learn something the bridge can read for free. Under a gate that tool
 * call is an approval card raised before the user has typed anything, which is
 * a poor way to open a session.
 *
 * @param {string} cwd
 * @param {{readFile?: (path: string) => string}} [io]
 */
export function workspaceRules(cwd, { readFile = defaultReadFile } = {}) {
  for (const name of RULES_FILES) {
    let text;
    try {
      text = readFile(join(cwd, name)).trim();
    } catch {
      continue; // Absent or unreadable: the next candidate, then none at all.
    }
    if (!text) continue;
    return text.length > MAX_RULES_CHARS
      ? { name, text: `${text.slice(0, MAX_RULES_CHARS)}\n…[truncated]`, truncated: true }
      : { name, text, truncated: false };
  }
  return null;
}

function defaultReadFile(path) {
  return readFileSync(path, "utf8");
}

/**
 * The `-i` argument: the workspace's rules, then what to do first.
 *
 * @param {string} nudge
 * @param {string} cwd
 * @param {{readFile?: (path: string) => string}} [io]
 */
export function buildInitialPrompt(nudge, cwd, io) {
  const rules = cwd ? workspaceRules(cwd, io ?? {}) : null;
  if (!rules) return nudge;
  return `${rules.name} for this workspace:\n\n${rules.text}\n\nFollow it. ${nudge}`;
}

export const adapters = {
  /**
   * Claude Code. Plain print mode, so its stdout is the answer.
   */
  claude: {
    name: "claude",
    command: "claude",
    restrictToMcp: true,
    buildArgs({ prompt, mcpConfig, allowedTools, resume }) {
      const args = ["-p", prompt, "--mcp-config", mcpConfig];
      if (allowedTools?.length) args.push("--allowedTools", allowedTools.join(","));
      // Confining the agent to bridge tools means denying its built-ins.
      if (this.restrictToMcp) args.push("--disallowedTools", "Bash,Edit,Write,Read");
      if (resume) args.push("--continue");
      return args;
    },
    readText: textFromStdout,
  },

  /**
   * Antigravity CLI.
   *
   * Runs in `stream-json` mode, which emits NDJSON covering assistant text,
   * every tool invocation with its parameters, and a terminal result carrying
   * token usage. `--add-dir` registers the workspace because cwd alone is not
   * enough in print mode.
   *
   * It exposes no flag for MCP servers — those live in agy's own config files —
   * so the bridge cannot hand it a per-session endpoint. Tool activity for this
   * agent is therefore *observed* rather than gated.
   */
  agy: {
    name: "agy",
    command: "agy",
    restrictToMcp: false,
    // One process for the whole session: turns arrive on stdin as NDJSON and
    // answers stream back on stdout, so startup and context are paid once
    // instead of per turn.
    persistent: true,
    // No MCP flag exists; servers are read from <workspace>/.gemini/settings.json,
    // so the bridge registers its endpoint there for the life of the session.
    mcpViaWorkspaceFile: true,
    buildSessionArgs({ cwd, skipAgentPermissions, resumeConversationId }) {
      const args = [
        "--add-dir",
        cwd,
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
      ];
      // Cancelling a turn has to kill the process — SIGINT ends agy outright
      // rather than interrupting a turn — so resuming by id is what turns
      // "stop" into "stop this turn" instead of "lose the conversation".
      if (resumeConversationId) args.push("--conversation", resumeConversationId);
      // Headless agy cannot prompt, so it auto-denies anything needing
      // permission — including reaching an MCP server. Skipping its prompts
      // hands the decision to whoever gates the MCP channel instead of leaving
      // every tool dead. It does NOT gate agy's built-in tools, which then run
      // unsupervised: that is the trade, and why this is off by default.
      if (skipAgentPermissions) args.push("--dangerously-skip-permissions");
      return args;
    },
    encodeTurn: encodeAgyTurn,
    parseLine: parseAgyLine,
  },

  /**
   * agy with OS sandboxing, its own prompts skipped.
   *
   * Headless agy auto-denies anything needing permission, which makes shell
   * commands and even MCP unreachable. Skipping its prompts restores them and
   * leans on `--sandbox` instead of a human.
   *
   * Read agy's own wording carefully: --sandbox enables "terminal restrictions".
   * It governs shell commands, and in testing did NOT stop file reads outside
   * the workspace. Built-in tools are unreviewed here; bridge tools stay gated.
   */
  "agy-sandboxed": {
    // Deny rules hold even under --dangerously-skip-permissions, so a
    // per-session HOME can protect credentials the skip would otherwise expose.
    deniesViaAgentHome: true,
    name: "agy-sandboxed",
    command: "agy",
    restrictToMcp: false,
    persistent: true,
    mcpViaWorkspaceFile: true,
    buildSessionArgs({ cwd, resumeConversationId }) {
      return [
        ...(resumeConversationId ? ["--conversation", resumeConversationId] : []),
        "--add-dir",
        cwd,
        "--sandbox",
        "--dangerously-skip-permissions",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
      ];
    },
    encodeTurn: encodeAgyTurn,
    parseLine: parseAgyLine,
  },

  /**
   * agy whose consequential work goes through the bridge, where policy decides
   * and a human can be asked.
   *
   * Runs in an isolated workspace by default — an empty directory holding only
   * the MCP registration — so the reviewed MCP tools are the obvious way to work
   * and the project directory is not casually in reach.
   *
   * Not a sandbox. agy can still read outside its workspace by absolute path
   * (verified on 1.1.13, with and without --sandbox), so treat this as shaping
   * behaviour, not as confining it. Real confinement needs an OS-level boundary
   * — a container or namespace — around the whole agent process.
   */
  "agy-gated": {
    // Deny rules hold even under --dangerously-skip-permissions, so a
    // per-session HOME can protect credentials the skip would otherwise expose.
    deniesViaAgentHome: true,
    name: "agy-gated",
    command: "agy",
    restrictToMcp: false,
    persistent: true,
    mcpViaWorkspaceFile: true,
    // An empty workspace makes gated MCP tools the path of least resistance.
    // It is NOT confinement: agy read a file outside its workspace by absolute
    // path in testing, with and without --sandbox.
    defaultWorkspaceMode: "isolated",
    buildSessionArgs({ cwd, resumeConversationId }) {
      return [
        ...(resumeConversationId ? ["--conversation", resumeConversationId] : []),
        "--add-dir",
        cwd,
        "--dangerously-skip-permissions",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
      ];
    },
    encodeTurn: encodeAgyTurn,
    parseLine: parseAgyLine,
  },

  /**
   * agy over two channels: a PTY for steering and MCP for work.
   *
   * The stdio channel above carries structured data, so it cannot also carry an
   * interrupt or a slash command: `session/cancel` can only kill the process and
   * `session/set_model` has nowhere to go. A PTY answers both, and is also the
   * only place agy's own permission prompts can be answered.
   *
   * Not implemented. Named so the choice is visible rather than discovered
   * later as a missing feature.
   */
  "agy-dual": {
    name: "agy-dual",
    command: "agy",
    restrictToMcp: false,
    // A terminal rather than a data stream: the only channel that can carry an
    // interrupt or a slash command. Built-in tools stay available and
    // unreviewed; MCP tools remain gated, because MCP is HTTP and unaffected by
    // what occupies stdio.
    pty: true,
    // The turn itself travels over MCP, not the terminal. Typing a prompt into a
    // TUI and reading the answer back off a redrawing screen is the fragile part
    // of this transport; next_task and submit_result remove both. The terminal
    // then carries only the nudge, ESC, and slash commands.
    turnsOverMcp: true,
    /** One line, because the real instruction arrives over MCP. */
    nudge: DUAL_NUDGE,
    mcpViaWorkspaceFile: true,
    deniesViaAgentHome: true,
    /**
     * Built-in tools agy may use without stopping to ask.
     *
     * Nothing on this side of the terminal can answer a confirmation: agy
     * surfaces one for RunCommand and simply waits, so the turn never returns.
     * Dual mode routes *turns* over MCP, not tool calls — reviewing those is
     * what agy-gated is for.
     *
     * Granted by name rather than by skipping permissions wholesale, so the
     * riskier verbs agy knows (`unsandboxed`, `escalate_admin`, `execute_url`)
     * still stop. The session HOME's deny rules continue to apply.
     */
    autoApprove: ["command(*)", "read_file(*)", "write_file(*)", "read_url(*)"],
    buildSessionArgs({ cwd, initialPrompt }) {
      // -i runs the prompt then stays interactive, so the first turn never has
      // to be typed — which removes the echo the terminal would otherwise
      // reflow and shred.
      const args = ["--add-dir", cwd];
      if (initialPrompt) args.push("-i", initialPrompt);
      return args;
    },
  },

  /**
   * Dual transport with execution gated.
   *
   * The mode that closes the write-then-run gap. Reviewing a tool by name is
   * not enough for a shell: an agent that cannot run a command can still write
   * a script and ask for the script to be run, and the run is the part that
   * matters. So the command arrives as an MCP call carrying the command text,
   * where the gate can see exactly what will execute.
   *
   * agy's own command tool is denied rather than merely discouraged, because an
   * instruction to prefer a tool is a request and a deny rule is not. Reads and
   * writes stay with the agent — they are what it is for, and the deny list
   * still bounds where they may go.
   */
  "agy-dual-gated": {
    name: "agy-dual-gated",
    command: "agy",
    restrictToMcp: false,
    pty: true,
    turnsOverMcp: true,
    nudge: DUAL_NUDGE,
    mcpViaWorkspaceFile: true,
    deniesViaAgentHome: true,
    /** Offer execution and file access over MCP, so the gate sees what happens. */
    execViaMcp: true,
    filesViaMcp: true,
    /**
     * And close the paths that would bypass them.
     *
     * A denied built-in is what makes the MCP route authoritative rather than
     * merely available. Note what this costs: every file the agent touches now
     * takes a round trip through the gate, so the review policy decides whether
     * that is one prompt or none — `review-consequential` lets reads through and
     * stops writes, which is the setting this mode is shaped for.
     */
    denyRules: ["command(*)", "read_file(*)", "write_file(*)"],
    // Fetching a URL is neither execution nor a file, and has its own tool.
    autoApprove: ["read_url(*)"],
    buildSessionArgs({ cwd, initialPrompt }) {
      // -i runs the prompt then stays interactive, so the first turn never has
      // to be typed — which removes the echo the terminal would otherwise
      // reflow and shred.
      const args = ["--add-dir", cwd];
      if (initialPrompt) args.push("-i", initialPrompt);
      return args;
    },
  },


};

/** agy takes one NDJSON turn per line on stdin. */
function encodeAgyTurn(text) {
  return JSON.stringify({
    type: "user",
    message: { role: "user", content: [{ type: "text", text }] },
  });
}

/**
 * Translate one line of agy's stream-json into bridge-neutral records.
 *
 * Returns null for anything carrying no meaning for a client — unparseable
 * lines, unknown events, and lifecycle steps that are bookkeeping rather than
 * agent activity. Guessing at unrecognised events would put invented work in
 * front of a user.
 */
export function parseAgyLine(line) {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return null;
  }

  if (message?.event === "init") {
    // The id a cancelled session can be resumed with.
    const conversationId = message.conversation_id ?? message.init?.conversation_id;
    return conversationId ? { kind: "session", conversationId: String(conversationId) } : null;
  }

  if (message?.event === "result") {
    const result = message.result ?? {};
    return {
      kind: "result",
      ...(result.conversation_id ? { conversationId: String(result.conversation_id) } : {}),
      ok: result.status === "SUCCESS",
      text: typeof result.response === "string" ? result.response : "",
      // The agent's own vocabulary, kept for logs. It is NOT an ACP stop
      // reason and must not be forwarded as one — ACP accepts only end_turn,
      // cancelled, max_tokens, max_turn_requests and refusal, and a client
      // that validates will reject anything else, leaving the turn unsettled.
      ...(result.status ? { agentStatus: String(result.status) } : {}),
      ...(result.usage ? { usage: result.usage } : {}),
    };
  }

  if (message?.event !== "step_update") return null;
  const step = message.step_update ?? {};

  if (step.step_type === "agent_response") {
    // Some agent_response steps carry only usage; only text is a client event.
    return typeof step.text_delta === "string" && step.text_delta.length > 0
      ? { kind: "text", text: step.text_delta }
      : null;
  }

  if (step.step_type === "tool") {
    const info = step.tool_info ?? {};
    return {
      kind: "tool",
      // step_index is stable across the ACTIVE/DONE pair, so it identifies the
      // call without correlating on name and arguments.
      id: `agy-step-${step.step_index}`,
      name: step.tool_name ?? info.name ?? "tool",
      args: info.parameters ?? {},
      status: step.state === "DONE" ? "completed" : "in_progress",
    };
  }

  return null;
}

export function getAdapter(name) {
  const adapter = adapters[name];
  if (!adapter) {
    throw new Error(`unknown agent '${name}' (known: ${Object.keys(adapters).join(", ")})`);
  }
  // Fail at selection rather than at the first turn, when the user has already
  // typed a prompt and expects an answer.
  if (adapter.unavailable) throw new Error(adapter.unavailable);
  return adapter;
}
