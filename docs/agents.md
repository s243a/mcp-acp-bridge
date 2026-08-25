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

## Seeing what agy discussed (and its "remote mode")

agy has no clean local protocol to enumerate its work the way codex's app-server
does — investigated 2026-08-25 on agy 1.1.17. What it has instead:

- **A per-instance local control server** on a random loopback port (`/healthz`
  → `{instanceId,status}`), which mostly proxies the Antigravity **cloud** backend
  (`/v1internal:generateChat`, `:fetchUserInfo`, …) and hosts a **remote** entry
  (`/remote/<host>:4901/task/…`). Its "remote mode" is a **mesh**: instances
  connect to each other (`connectInstance`, `initiateMeshSession`) and drive a
  remote agy on **port 4901**, named by `config.json`'s `remoteControlHostname`.
  That is Antigravity's own remote-agent system — account/cloud-gated and
  device-addressed — not a neutral API to tunnel. (On WSL/Linux the `antigravity`
  IDE binary is a stub that defers to the Windows install, so its VS Code-style
  tunnel is Windows-only.)
- **An on-disk conversation store** — this is the tractable visibility path. Every
  conversation is a SQLite db at `~/.gemini/antigravity-cli/conversations/<id>.db`,
  indexed by `conversation_summaries.db` (id, title, preview, step_count, status,
  agent_name, **battle_id/winning_conversation_id** — agy runs competing
  "battles" — timing, killed, not_fully_idle). Each conversation's `steps` table
  holds `step_type/status` plus **protobuf** blobs (`step_payload/render_info/
  task_details`).

`bin/agy-conversations.js` reads this **read-only** (the live agy is writing it)
and can serve it over HTTP so a peerhailer tunnel carries it — the same remote
visibility we proved for codex:

```sh
agy-conversations                 # JSON list (newest first)
agy-conversations read <id> --text  # a conversation's steps, with a text peek
agy-conversations --serve 9220      # GET /conversations , /conversations/<id>?text=1
```

Step content is protobuf, but text fields survive as readable byte runs, so
`--text` recovers the gist without the schema. The step_type/status integers are
mapped from the reverse-engineered schema in **shubzkothekar/antigravity-acp**
(MIT) — which also has the real `@bufbuild/protobuf` decoder if you want full
content, not a heuristic:

| step_type | | step_type | | status | |
| ---: | --- | ---: | --- | ---: | --- |
| 5 | write_file | 21 | run_command | 2 | in_progress |
| 7 | grep_search | 31 | read_url | 3 | completed |
| 8 | view_file | 33 | search_web | 6 | cancelled |
| 9 | list_dir | 127 | invoke_subagent | 7 | failed |
| 14 | user_prompt | 138 | ask_question | | |
| 15 | agent_text | 90/98/101 | lifecycle | | |

**A Terms-of-Service caveat, surfaced by antigravity-acp:** Google's Antigravity
ToS names using a third-party tool to *drive* `agy` as a violation that can get an
account suspended — which is what the bridge's `--agent agy` support does. Reading
the SQLite store at rest (this tool) is local file inspection, not "accessing the
Service", so it sits on the safe side of that line — but the driving path does
not, and that is worth a deliberate decision rather than a default.

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

## codex app-server and remote-control (the richer surface)

`codex exec` (our `codex` adapter) and `codex mcp-server` (our `codex-mcp`) are
the narrow surfaces. Codex's *full* local control protocol is **`app-server`** —
JSON-RPC codex speaks over stdio (`codex app-server`) or through a managed daemon
on a unix socket (`codex app-server proxy --sock`). `@zed-industries/codex-acp`
wraps it; that is what our ACP-native path runs. Its schema
(`codex app-server generate-json-schema --out DIR`) is worth reading — it is much
larger than mcp-server's two tools:

- **Threads (sessions):** `thread/list`, `thread/loaded/list`, `thread/read`,
  `thread/resume`, `thread/fork`, `thread/rollback`, `thread/start`,
  `thread/archive`, `thread/goal/*`, `thread/name/set`, `thread/compact/start`.
- **Turns:** `turn/start`, **`turn/steer`** (inject guidance into a running
  turn), `turn/interrupt`.
- **Interactive command exec:** `command/exec`, `command/exec/write` (stdin),
  `command/exec/resize` (it is a PTY), `command/exec/terminate`, with
  `item/commandExecution/outputDelta` notifications streaming output live.
- **Everything else:** `fs/*`, `account/*` (login flows), `config/*`,
  `mcpServer/*`, `plugin`/`skill`/`hooks` lists, permission profiles, and a full
  notification stream (`item/agentMessage/delta`, `item/reasoning/*`,
  `item/fileChange/*`, turn and thread lifecycle).

### Visibility into an existing session — demonstrated

This is the part worth calling out. A fresh client that connects and calls
`thread/list` gets the machine's **existing codex sessions back, with previews**;
`thread/loaded/list` gives the ones currently live in memory; `thread/resume` +
`thread/read` attach to one, and the notification stream then lets the client
*watch* it, `turn/steer` nudge it, and `command/exec/*` drive its shell. So
app-server is an observability-and-steering surface over codex's own sessions,
not merely another way in — codex's native answer to "see and take over the
agent that is already running", the same itch peerhailer's shell plugin scratches
for a raw shell.

### remote-control, and the deployment caveat

`codex remote-control start` runs that app-server daemon with remote access and
`codex remote-control pair` mints a short-lived pairing code — codex's own
built-in remote solution, in the same space as peerhailer's tunnel or T3 Connect.
**But the managed daemon needs codex's standalone installer**
(`~/.codex/packages/standalone/current/codex`); an npm/Homebrew codex fails
`daemon start` with "managed standalone Codex install not found", and so cannot
run `remote-control` either. The plain stdio `codex app-server` still works
without it (single client, no pairing) — which is why our codex-acp path runs
even though the daemon does not.

### How this bears on the project

Two honest options for reaching codex remotely, and they are not the same tool:

- **peerhailer tunnel + stdio app-server (or codex-acp over the passthrough).**
  One fabric, one auth model, works with any codex install. The visibility
  surface is real and **prototyped**: tunnel `codex app-server` and a fresh
  client can `thread/list` the machine's existing codex sessions, `thread/read`
  their history, and `thread/resume` to continue one — richer than our per-turn
  bridge. Proven end to end on loopback by peerhailer's
  `npm run test:codex-appserver` (one connection stores a session; a separate
  connection over the tunnel lists, reads, resumes, and recalls it).

  **Live mid-turn steer works too** (`npm run test:codex-steer`): two connections
  over the tunnel share one `codex app-server` via `bin/appserver-hub.js`, and a
  steerer that never started the turn pulls the live thread/turn off the
  broadcast stream and `turn/steer`s it — the worker's output changes course. The hub is the
  zero-dependency option — one app-server, N clients, id-remapped requests,
  broadcast notifications — and works with any codex install.

  **The managed daemon works too, once you speak its protocol.** Its control
  socket is not raw JSON-RPC: it is **JSON-RPC over a WebSocket carried on the
  unix socket** (`client_async("ws://localhost/")` in codex's `app-server-daemon`
  crate; messages are WebSocket text frames). That is why `codex app-server
  proxy` fails for a JSON-RPC client — it relays raw bytes and never sends the
  upgrade — and why a raw write gets a clean close. Auth (`--ws-auth`) is enforced
  only on *non-loopback* listeners, so the local unix socket needs no token.
  `bin/appserver-ws-bridge.js` does the upgrade and exposes the daemon as a plain
  newline-JSON-RPC TCP port; through it the daemon natively shares thread
  visibility (`thread/loaded/list` shows another connection's live thread) and a
  steerer can `thread/read` the active turn and `turn/steer` it — verified. Two
  notes: an isolated `CODEX_HOME` (under `$HOME`, not `/tmp`) is what clears the
  "app server is running but is not managed" conflict; and `turn/steer` *queues* —
  codex finishes its current work, then applies the steer, rather than
  interrupting.
- **codex remote-control.** Codex's own pairing-based remote, but a second
  transport to run and trust, and gated on the standalone install. Useful to know
  it exists; not a fit for a peerhailer-centric setup.

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
