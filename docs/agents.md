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
- **MCP server** (`mcpServer: true`) — the roles invert: the agent *is* the MCP
  server and the bridge is its client. The turn is delivered as a tool call, and
  the agent's own approvals come back as MCP elicitations the bridge gates.
  `codex-mcp` is here (`src/codexMcpSession.js`).

## The gating spectrum

The bridge's point is the **gate**: an agent's tool calls arrive over MCP and are
held for review. How much that holds depends on the harness:

| Agent | MCP endpoint | Confined to bridge tools? | Gating |
| --- | --- | --- | --- |
| `claude` | `--mcp-config <json>` flag | yes — `--disallowedTools Bash,Edit,Write,Read` | **full** |
| `codex` | `-c mcp_servers.bridge.url=…` | partial — `-s read-only` sandboxes its own shell | **partial** |
| `codex-mcp` | bridge is codex's MCP *client* | yes — codex asks the bridge to approve each exec/patch | **full (native)** |
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
`--ephemeral` (the bridge owns session lifecycle). This adapter is **single-turn**
(each turn is a fresh `codex exec`) and only partially gated. For multi-turn *and*
a real gate, use `codex-mcp` below; keep this one as the simple, dependency-free
fallback.

## codex-mcp

`codex mcp-server`, driven the other way round: codex is the MCP server, the
bridge is its client. This is the best codex integration — everything the `exec`
adapter cannot do, it does:

- **The turn goes over MCP.** The bridge calls codex's `codex` tool with the
  prompt (first turn) and `codex-reply` with `{threadId, prompt}` after that. Not
  argv, not stdin — a real tool call.
- **Live multi-turn.** One persistent `codex mcp-server` process holds the
  conversation; `codex-reply` continues the same `threadId` in memory, so a
  second turn recalls the first without paying startup again (measured ~3.5s vs
  ~13s for the first). Tracked per ACP session.
- **A native gate.** With `approval-policy: untrusted` + `sandbox:
  workspace-write`, codex asks *the bridge* before running any non-trivial
  command or applying a patch — as an MCP `elicitation/create` request carrying
  the exact `codex_command` (e.g. `/bin/bash -lc 'printf %s … > codeword.txt'`)
  and the cwd. The bridge routes that to the same `gate()` every other tool call
  goes through, so it becomes an ordinary `session/request_permission` card. This
  is a gate on codex's *real* actions with the command text in hand — strictly
  more than the `exec` adapter's `-s read-only`, and the same philosophy as
  `agy-dual-gated`, but built into codex.

**Gating is configurable — codex has an auto mode too.** The default is
`untrusted` (a card for every command). Two flags tune it, the equivalent of
choosing Claude's review vs auto:

| `--codex-approval` | `--codex-sandbox` | behaviour |
| --- | --- | --- |
| `untrusted` (default) | `workspace-write` | every non-trivial command is a card |
| `on-request` | `workspace-write` | codex asks only when it wants to escalate |
| `never` | `workspace-write` / `danger-full-access` | **auto mode** — codex runs unattended, no cards, the bridge still owns the session |

Verified both ways live: `untrusted` raises the command cards; `never` runs the
same task with zero cards and still keeps multi-turn.

Two wire details that are easy to get wrong (learned the hard way):

- **Approval needs a top-level `decision`, not just MCP's `action`.** The accept
  reply is `{action: "accept", decision: "approved"}`; `{action: "accept"}` alone
  leaves the command *rejected*. Deny is `{action: "decline", decision:
  "denied"}`.
- **stdio only.** `codex mcp-server` has no HTTP listener, so the bridge speaks
  to it over a local stdio pipe. That is fine for remoting: the pipe is
  co-located with codex, and only ACP crosses the fabric — codex's stdin/stdout
  never does. (No byte-relaying; see the network-trust notes in peerhailer.)

The message streams back as `codex/event` `agent_message_content_delta` events
(`msg.delta`); the final `tools/call` result carries `structuredContent.{threadId,
content}` as the whole answer, used as a fallback when a build does not stream.

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

## ACP-native: the passthrough, and when to prefer it

The bridge exists because some agents do not speak ACP (agy is the motivating
case): it translates ACP<->MCP and gates the MCP tool channel. But claude and
codex each have a real **ACP adapter** — `@zed-industries/claude-code-acp` and
`@zed-industries/codex-acp` — that already speaks ACP and already surfaces the
agent's *own* native permissions (every tool, not just MCP ones), with richer
session capabilities (`loadSession`/`resume`/`fork`). For those, there is nothing
to translate.

What was missing is only a way to reach a stdio adapter from across the fabric,
since ACP adapters speak over stdio, not a port. `bin/acp-passthrough.js` is that
— a dumb byte forwarder that serves any stdio ACP adapter on a loopback TCP port,
one adapter process per connection, so a peerhailer tunnel can carry it:

```sh
acp-passthrough --listen 9110 -- npx -y @zed-industries/codex-acp
acp-passthrough --listen 9111 -- npx -y @zed-industries/claude-code-acp
```

It has **no gate of its own** — the adapter carries the agent's. Loopback by
default: what reaches it is the tunnel, and the fabric authenticates.

**Bridge vs passthrough — pick by the agent and the gate you want:**

| | bridge (`--listen --agent X`) | passthrough (native ACP) |
| --- | --- | --- |
| works for | any agent, incl. no-ACP (agy) | agents with an ACP adapter (claude, codex) |
| gate | the bridge's MCP gate (MCP tools only) | the agent's *native* permissions (every tool) |
| sessions | per the adapter (codex-mcp multi-turn) | native `loadSession`/`resume`/`fork` |
| translation | ACP<->MCP | none |

Verified: codex-acp driven end to end over a peerhailer tunnel through the
passthrough (peerhailer `npm run test:acp-native`). **Caveat:** the adapters
authenticate themselves — `codex-acp` uses codex's login, but `claude-code-acp`
(Agent SDK) needs its own `claude /login` or `ANTHROPIC_API_KEY`; without it,
`session/new` fails with "Query closed before response received" even though the
`claude` CLI the bridge uses is authed.

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
