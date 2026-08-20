# Design

Status: design only. Nothing here is implemented.

## Shape

Three roles in one process:

1. **MCP server**, facing the agent. Advertises tools, receives `tools/call`.
2. **ACP server**, facing the client. Speaks `session/*` over stdio JSON-RPC.
3. **Process supervisor**, spawning the agent and owning its lifecycle.

A turn runs like this:

```
client  --session/prompt-------------►  bridge   ── spawns / feeds the agent
agent   --tools/call-----------------►  bridge
bridge  --session/request_permission-►  client
client  --allow / deny---------------►  bridge
bridge  ── relays or rejects the call ─►  agent
agent   --stdout text----------------►  bridge  --session/update (agent_message_chunk)--► client
```

The permission hop is the point. Everything else is plumbing.

## ACP surface

What a client consumes, and where the bridge gets it:

| Method / update | Source |
| --- | --- |
| `session/new` | allocate a session + its MCP endpoint path |
| `session/prompt` | user turn in; feed the agent |
| `session/update` → `agent_message_chunk` | agent stdout |
| `session/update` → `tool_call` / `tool_call_update` | intercepted MCP calls |
| `session/request_permission` | raised per intercepted call |
| `session/load` | replay a prior session |

`session/load` is deferred; the MVP need not support resuming.

## Supporting both MCP revisions

The two revisions differ in exactly the places a naive implementation would
depend on:

| | 2025-03-26 | 2026-07-28 (RC) |
| --- | --- | --- |
| Handshake | `initialize` → `InitializeResult`, then `initialized` | none |
| Protocol version | negotiated once at initialize | inline in `_meta` per request |
| Client capabilities | negotiated once at initialize | inline in `_meta` per request |
| Session identity | `Mcp-Session-Id` header, optional | removed |

Three rules make one server satisfy both:

**1. Treat `initialize` as optional, not required.**
If it arrives, answer it and echo the client's requested protocol version. If it
never arrives, do not wait for it and do not reject subsequent calls. A request
that shows up without a handshake is a 2026-07-28 client, not an error.

**2. Resolve request context per call, with the handshake as a fallback.**
Read protocol version and client capabilities from `_meta` when present;
otherwise fall back to whatever `initialize` negotiated for that connection.
This ordering — inline first, handshake second — means new clients work without
special-casing and old clients keep working unchanged.

**3. Never derive ACP session identity from MCP.**
This is the load-bearing rule. Correlation comes from a **path-scoped endpoint**
allocated at `session/new`:

```
http://127.0.0.1:<port>/mcp/<opaque-session-token>
```

The agent is handed that URL and only that URL. Every call arriving on it
belongs to that ACP session, by construction — no header, no handshake, no
transport state. `Mcp-Session-Id` may still be echoed if a 2025-03-26 client
sends one, but nothing routes on it.

Rule 3 also prevents a concrete failure: with a single shared endpoint, a second
concurrent agent's tool calls would land on the first agent's ACP session and
cross-wire two clients' output. Per-session paths make that impossible rather
than merely unlikely.

The session token must be unguessable — it is the only thing separating two
sessions on a shared loopback port.

## Permission gating

Every `tools/call` becomes a `session/request_permission` awaited before the
call is relayed.

Consequences to design for rather than discover:

- **The agent blocks while a human decides.** That is intended, but it puts
  client latency directly in the agent's tool-call path.
- **A timeout is mandatory, and its default must be deny.** An absent or
  disconnected client must not become an implicit allow.
- **Denial must be legible to the agent.** Return a tool error saying it was
  denied, so the agent can adapt rather than retry blindly.
- **Long-held requests must survive the transport.** Anything between agent and
  bridge that times out idle HTTP requests will break gating; loopback avoids
  this, remote deployments must verify it.

## Agent adapters

Agent-specific knowledge is confined to one small interface:

- how to launch it and point it at an MCP endpoint
- how to feed it a turn
- how to read assistant text from its output
- whether built-in tools can be disabled

`agy` is the first target: `--add-dir <cwd>`, `-p <text>` for a turn, `-c` to
continue, plain-text stdout. Whether its built-in tools can be restricted to
MCP-provided ones is **unverified** and worth establishing early — it decides
whether the hardening below is available for it.

## Dual mode: MCP for turns, terminal for steering

`agy-dual` runs agy under a PTY, but the turn itself never touches the screen.
The bridge queues the task, agy calls `next_task` to collect it and
`submit_result` to answer, and the terminal is left carrying only steering:
ESC to cancel, slash commands to change model. The screen is deliberately kept
out of the transcript — it renders answers as a redrawing frame with spinner
frames interleaved, which arrives shredded, while the submitted result is exact.

Four things about agy have to line up for this to work, each verified on 1.1.14:

1. **The endpoint goes in the shared config, as `serverUrl`.** Interactive agy
   reads `~/.gemini/config/mcp_config.json`; the `mcpServers` key in a
   workspace's `.gemini/settings.json` is honoured only by the stream-json path.
   It does support remote servers over HTTP — an earlier reading of a failed
   probe as "interactive agy is stdio-only" was wrong, and a stdio proxy written
   to work around it was deleted once `/mcp` showed the server connected.
2. **`/mcp` is the ground truth for registration.** It distinguishes a server
   that connected but exposes nothing from one that never connected, which
   inferring from the agent's prose does not. A connected server with no
   `Tools:` line is a bridge with no tools registered, not a transport problem.
3. **MCP calls need a standing allow rule.** Otherwise agy prompts
   `Do you want to proceed?` and blocks forever, since nothing on our side of
   the terminal answers it. Rules take the form `mcp(<server>/<tool>)`, matching
   agy's own built-in `mcp(chrome-devtools/*)`, and go in the session HOME's
   `settings.json`. They apply in interactive mode only: headless auto-denies
   and says so.
4. **Built-in tools need standing grants too.** The MCP rule only covers the
   task channel. The moment agy wants its own `RunCommand` it surfaces a
   confirmation and waits — `tool_confirmation_manager.go: Surfacing tool
   confirmation: "RunCommand"` in its log, with the turn never returning. Dual
   mode grants `command`, `read_file`, `write_file` and `read_url` by name
   rather than skipping permissions wholesale, so the riskier verbs agy knows
   (`unsandboxed`, `escalate_admin`, `execute_url`) still stop.
5. **The first turn rides in argv.** `-i <prompt>` runs a prompt and stays
   interactive, so the opening nudge is never typed — no echo to unpick, and no
   dependence on correctly detecting readiness. Because agy then asks for its
   task moments after spawn, the task must be queued before the process starts.

## What a shell grant actually grants

Observed 2026-08-19 on agy 1.1.15, in `agy-dual`, with the default deny list
in place:

```
find . -maxdepth 0 -exec sh -c 'echo CANARY > /home/s243a/bridge-canary.txt' \;
```

The file was written. No prompt, no denial, outside the workspace.

The deny rules are not broken; they govern the wrong thing. `write_file(...)`
constrains the agent's *file tool*, and a shell command is not that tool. Grant
`command(*)` and the deny list stops describing what the agent can reach — it
describes only the paths one particular tool will not touch. Anything the shell
can do, the agent can do.

Two things happen to soften this and neither should be relied on. The session
HOME override means `$HOME`-relative writes land in a directory that is deleted
afterwards, so a canary written that way disappears; an absolute path does not.
And an agent usually has no reason to leave its workspace. Neither is a boundary.

The same prompt under `agy-dual-gated`, where `command(*)` is denied and
execution arrives as `run_command`, reaches the client as a permission request
carrying the command text. Rejected, agy reports the execution as blocked and
the file is not written. That is the difference between reviewing a tool's name
and reviewing what it will run.

Antigravity's sandboxing is under active development and a later release may
close this. The date and version above are the scope of the claim, not a
standing property of agy: re-run the canary when it matters, since the answer is
a file that either exists or does not.

The recommendation for anyone who cares about this is both: run the bridge under
an OS sandbox *and* use a gated mode. A sandbox is the only real boundary — it
bounds what the process can reach whatever tool it reaches with — but it cannot
say what is about to happen, so a refusal surfaces as a confusing failure. A
gate cannot guarantee anything, since it rests on a deny rule matching the route
the agent took, but it shows the command before it runs. The sandbox bounds the
damage; the gate shows the intent. A sandbox alone still lets an unreviewed
shell thrash inside the workspace without asking.

Not to be confused with either: agy's own `--sandbox`, which agy describes as
terminal restrictions and which did not stop reads outside the workspace in
testing. Everything in this repo is defence in depth, not a jail.

## Gating execution

Reviewing a tool by name is not enough for a shell. An agent that cannot run a
command can still write a script and ask for the script to be run: the write is
harmless, the run is not, and by the time a name like "RunCommand" appears there
is nothing in it to judge.

So execution is offered as an MCP tool, `run_command`, and the held call carries
the command itself — `echo 'echo GATED_OK' > hello.sh && bash hello.sh` reaches
the client as text a policy or a person can read before anything happens.

Offering it is not enough on its own. An instruction to prefer a tool is a
request, and an agent under pressure to finish will reach for what it has. The
deny rule is the enforcement: with `command(*)` denied in the session HOME, the
MCP route is the only route, which is what makes the gate authoritative rather
than merely available.

Reads and writes stay with the agent in this mode. They are what it is for, the
deny list still bounds where they may go, and a mode that stops for every read
is a mode nobody leaves switched on.

## An empty answer

Agents finish turns without saying anything. agy's own trajectory records the
call as `{"Arguments":{},"ToolName":"submit_result"}` — the tool invoked with no
arguments at all. The turn completes, there is nothing to render, and the client
shows silence, which is the one failure indistinguishable from a broken bridge.

The channel asks once: an empty result is refused with a note telling the agent
to call again with its answer, which in practice it then does. A second empty
result is accepted rather than pressed, so a stubbornly silent agent ends its
turn instead of hanging on it.

If the answer is still missing, the terminal is read for whatever the agent said
on screen, and reported as recovered — flagged, like a permission that arrived
the wrong way, because the MCP channel is the one that should have carried it.
Failing even that, the turn says plainly that nothing was reported. What it
never does is finish silently.

Agy also keeps its conversations as SQLite under `antigravity-cli/conversations`,
which looks like a better recovery source than a screen until you open one: the
payloads are protobuf with JSON embedded, undocumented and version-dependent.
The screen is fragile in an obvious way; that would be fragile in a subtle one.

## Two permission channels

Permission questions reach the bridge two ways, and both end at the same policy.

**The tool channel** is the one to prefer. A call routed through the gateway is
held before it runs, decided, and answered as an ACP permission request. It
carries the tool's arguments, it cannot be missed, and nothing has to be read
off a screen.

**The terminal channel** is a fallback. Agents have their own built-in tools
that never reach the gateway, and a standing grant can quietly stop matching —
a renamed verb, a new one, a rule the agent no longer honours. In every such
case the agent raises its own confirmation and waits for a keystroke that
nothing here can send, and the turn stops with no error to show for it. Reading
that prompt off the terminal turns a hang into a question.

Instructing an agent to prefer MCP tools is worth doing, but it is not what
makes the tool channel authoritative — an instruction is a request, not a
constraint. A deny rule is the enforcement: with the built-in denied, the agent
cannot take the other path. The terminal channel then covers what the rule does
not match, which is the failure worth insuring against.

A terminal-channel request is answered by the user like any other, and says so
on the card — `RunCommand (asked on the terminal)` — with a line in the
transcript explaining that a permission rule has probably stopped matching. The
approval counts either way; the route is the symptom, and hiding it would leave
a configuration error to be discovered as a mysterious pause instead.

The two channels overlap on MCP tools, which agents may also prompt about
themselves. A verdict the tool channel reached is remembered briefly so the
same call arriving on the terminal is answered from it rather than asked again:
one call seen twice is one decision.

## Choosing a model

`session/set_model` carries the client's choice to the agent. For a terminal
agent that means driving the picker, because `/model <name>` is not a setter:
agy ignores the argument and opens the picker regardless. The bridge opens it,
reads the list and cursor off the screen, walks to the wanted entry with arrow
keys and selects it — matching names loosely, since the screen may abbreviate.

An unknown name closes the picker before failing. Leaving it open would swallow
the next turn's keystrokes, which looks like a hang rather than a bad name.

Selecting a model also resets agy's effort (a model switch showed
`Gemini 3.7 Flash · high` becoming `Gemini 3.1 Pro · low`). Effort is a separate
axis in the same picker and is not exposed yet; it belongs with the other
per-turn options if it is wanted.

## Planned hardening: built-ins through MCP

Disabling an agent's built-in file and shell tools and supplying equivalents as
MCP tools gives the bridge complete visibility and per-action review over
everything the agent does.

| | Built-ins active | Built-ins disabled |
| --- | --- | --- |
| Privileged actions governed by | the agent's own standing permission config | per-action review at the bridge |
| Bridge sees | MCP calls only | everything |

This is an upgrade, not a prerequisite. Note the interaction with headless mode:
an agent that cannot prompt auto-denies, so without this it needs standing
grants to do privileged work at all.

If built-in equivalents are implemented, they need real path hardening —
allowlisted roots, no caller-supplied absolute paths, and receipts that do not
echo file contents back through the tool channel.

## Open questions

1. Can `agy` run with built-in tools disabled or restricted to MCP-provided
   ones?
2. Does any target agent silently fall back to a built-in when an MCP tool
   fails? That would punch a hole through the gate.
3. Should one bridge process serve many concurrent sessions, or one process per
   session? Per-session paths permit the former; per-process is simpler and may
   be enough.
