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

/** Assistant text arrives on stdout for CLIs run in one-shot print mode. */
const textFromStdout = (chunk) => chunk;

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
    buildArgs({ prompt, cwd, resume }) {
      const args = ["--add-dir", cwd, "--output-format", "stream-json"];
      if (resume) args.push("-c");
      args.push("-p", prompt);
      return args;
    },
    parseLine: parseAgyLine,
  },
};

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

  if (message?.event === "result") {
    const result = message.result ?? {};
    return {
      kind: "result",
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
  return adapter;
}
