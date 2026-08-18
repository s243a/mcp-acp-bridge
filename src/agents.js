/**
 * Agent adapters — the only place agent-specific knowledge lives.
 *
 * An adapter answers four questions: how to launch it, how to point it at an
 * MCP endpoint, how to feed it one turn, and how to read assistant text back.
 * Everything else in the bridge is agent-agnostic.
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
   * Claude Code. Used as the reference agent because it speaks MCP over HTTP
   * and runs headless without a TTY.
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
   * Antigravity CLI. Plain-text stdout, no structured mode; `--add-dir`
   * registers the workspace because cwd alone is not enough in print mode.
   *
   * Whether its built-in tools can be disabled is UNVERIFIED — the flag below
   * is a placeholder until someone confirms it on a machine that can log in.
   */
  agy: {
    name: "agy",
    command: "agy",
    restrictToMcp: false,
    buildArgs({ prompt, cwd, resume }) {
      const args = ["--add-dir", cwd];
      if (resume) args.push("-c");
      args.push("-p", prompt);
      return args;
    },
    readText: textFromStdout,
  },
};

export function getAdapter(name) {
  const adapter = adapters[name];
  if (!adapter) {
    throw new Error(`unknown agent '${name}' (known: ${Object.keys(adapters).join(", ")})`);
  }
  return adapter;
}
