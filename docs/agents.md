# The agent adapters, and what each harness taught us

The bridge speaks ACP to a client and MCP to an agent. Each agent is a CLI with
its own idea of how to take a prompt, where to find its MCP servers, and how much
it will let the bridge confine it. This is what we have learned about each — the
facts that shaped the adapter, and the ones worth knowing before adding another.

An adapter lives in `src/agents.js`. There are two shapes:

- **Print mode** — `buildArgs()` builds a one-shot command, spawned per turn, and
  its stdout is read either whole (`readText`) or line-by-line (`parseLine`).
  `claude` and `codex` are here.
- **Persistent stream-json** — `buildSessionArgs()`/`encodeTurn()`/`parseLine()`
  drive one long-lived process. `agy` is here.

## The gating spectrum

The bridge's point is the **gate**: an agent's tool calls arrive over MCP and are
held for review. How much that holds depends on the harness:

| Agent | MCP endpoint | Confined to bridge tools? | Gating |
| --- | --- | --- | --- |
| `claude` | `--mcp-config <json>` flag | yes — `--disallowedTools Bash,Edit,Write,Read` | **full** |
| `codex` | `-c mcp_servers.bridge.url=…` | partial — `-s read-only` sandboxes its own shell | **partial** |
| `agy` | config file only (no flag) | no | **observed, not gated** |

"Observed, not gated" means the bridge sees the agent's tool activity in its event
stream and can log it, but the agent runs those tools itself — the bridge is not
in the path to hold them. Only a harness that takes the bridge's MCP endpoint
*and* can be told to prefer it can be gated.

## claude

`claude -p <prompt> --mcp-config <json>`. The cleanest fit: the MCP endpoint is a
flag taking a JSON string (the bridge hands it `{"mcpServers":{"bridge":{"type":
"http","url":…}}}`), and `--disallowedTools Bash,Edit,Write,Read` confines claude
to the bridge's tools, so every file/exec action is a gated MCP call. Print mode,
stdout *is* the answer (`readText` = identity). Needs no workspace trust.

## codex

`codex exec --json <prompt>`. Different from claude in two good ways and one
limitation:

- **MCP as a config override, not a file.** Codex's MCP servers live in
  `~/.codex/config.toml` under `[mcp_servers.<name>]`, and — crucially — a
  **remote HTTP** server (`url = …`) is a first-class form, which is exactly what
  the bridge's gateway is. So the adapter injects the per-session endpoint with
  `-c mcp_servers.bridge.url="…" -c mcp_servers.bridge.enabled=true`. No config
  file to write, and **no trusted-project entry needed** — the `-c` override does
  not require the workspace to be trusted (trust only gates loading *repo-local*
  `.codex/config.toml`).
- **Structured output.** `--json` emits JSONL. The answer is
  `{"type":"item.completed","item":{"type":"agent_message","text":…}}`; the turn
  ends with `{"type":"turn.completed","usage":…}`. `parseLine` reads those and
  drops the rest (`thread.started`, `turn.started`, reasoning) — the gate is at
  the MCP gateway, so codex's own tool events are not forwarded.
- **Partial gating.** `-s read-only` stops codex's own shell from mutating the
  machine, so real work is meant to go through the gated bridge tools (which run
  in the bridge process, not codex's sandbox). It does not *force* codex to
  prefer them the way claude's `--disallowedTools` does — codex's
  `enabled_tools`/`disabled_tools` config could tighten this; that is a later
  refinement.

Also passed: `--skip-git-repo-check` (the bridge workspace is not a git repo),
`--ephemeral` (the bridge owns session lifecycle). **Not yet wired:** multi-turn
continuity (`resume`) — each turn is a fresh `codex exec`, so codex is single-turn
through the bridge for now. Verified end to end: an ACP prompt round-trips and
codex answers.

## agy (Antigravity — the harness for gemini)

Run gemini through **`--agent agy`**, not `--agent gemini`: agy is the modern
harness and the standalone gemini CLI is deprecated (there is no `gemini` or
`codex` *name* — `--agent codex` is a real codex adapter, but `--agent gemini`
would be an unknown agent and now fails at startup). agy is the hardest to gate:

- **No MCP flag.** agy reads MCP only from its config files
  (`<workspace>/.gemini/settings.json`, `<workspace>/.agents/mcp_config.json`), so
  the bridge cannot hand it a per-session endpoint on the command line. Its tool
  activity is therefore *observed* (parsed from `stream-json`), not gated.
- **Per-project MCP config is broken; it must be global.** agy ignores the
  per-workspace MCP the bridge writes — the MCP server has to be declared in agy's
  **global** config. The good news is gemini does not have to *use* it, so there
  is no per-session-endpoint problem to solve; declare it once.
- **Workspace trust, and hidden folders.** agy will only operate in an *approved*
  workspace, and a hidden (`.`-prefixed) or throwaway `/tmp` dir cannot be
  approved. So spawn agy in a **stable, non-hidden, pre-approved** directory:
  `bridge --agent agy --cwd /path/to/approved-ws --workspace-mode project` (the
  agy adapters otherwise default to `isolated`, a temp dir). A chroot to fake an
  approvable path is the only alternative and agy likely won't tolerate it.

This is why gemini "accepted the connection but never answered" until run as agy
in an approved workspace.

## ACP is also an option (and skips the bridge)

Both **claude** and **codex** can speak ACP natively. So the bridge is not the
only way to reach them — a client could point its ACP command straight at their
ACP mode (tunnelled the same way). The bridge's distinct value is the **gate**;
where you do not need to hold tool calls, ACP-direct is simpler, and where you do,
the bridge is the reason to run it.

## Adding an agent — the checklist the above implies

1. **How does it take a prompt non-interactively?** (`-p`, `exec`, a stream on
   stdin.) That decides print vs persistent.
2. **How does it find its MCP servers?** A flag (claude), a config override
   (codex), or config files only (agy)? A flag or override means it can be gated;
   files-only means observed.
3. **Can its own tools be disabled or sandboxed**, so work goes through the
   bridge's MCP? Full (claude), partial (codex), or not (agy).
4. **Does it need a trusted / non-hidden workspace to run at all?** (agy yes,
   codex no, claude no.)
5. **How does it emit the answer?** Whole stdout (`readText`) or structured
   events (`parseLine`)?
6. **Does it support multi-turn resume**, and is it wired?
