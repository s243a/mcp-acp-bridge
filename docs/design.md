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

## Files over MCP, and where confinement stops

`read_file` and `write_file` sit beside `run_command` for the same reason: a
held call carries the path — and for a write, the content — so what gets
reviewed is the change rather than the fact that one is coming. Denying the
agent's own file tools is what makes that route authoritative; offering it
without denying them leaves both doors open.

File tools are also **confined** to the workspace, which the shell is not. A
path is resolved through symlinks before the check, so `..`, an absolute path
elsewhere, and a link inside the workspace pointing out are all refused
identically. A file that does not exist yet is judged by its nearest existing
parent, which is what a write needs.

Do not mistake that for a boundary around the agent. Asked to write outside its
workspace, agy was refused by `write_file` and immediately tried
`run_command` with `echo -n "CANARY" > /home/you/bridge-canary.txt` — approved
in that test, and the file was written. The lesson is not that confinement
failed; it did its job. It is that **the shell has no equivalent**, and cannot:
paths in a command line cannot be reliably found, let alone rewritten. For the
shell the control is review, which means a reviewer who reads the command they
are approving.

That is the same layering as everywhere else here. Confinement where the shape
of the call allows it, review where it does not, and an OS sandbox when a real
boundary is wanted rather than defence in depth.

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

## The workspace's rules reach the agent in argv

An agent driven through the bridge writes for a chat window, not a terminal, and
nothing tells it so. The symptom was a directory listing arriving as one
unreadable run-on line: Markdown joins consecutive lines into a paragraph, and
the agent had emitted `ls -l` output with no fence around it. The same model
formatted the same request three different ways across one thread, so this is
not something a better prompt fixes once.

The workspace already has a place to say such things — agy documents
`GEMINI.md`, `AGENTS.md` and `.agents/rules/*.md` as its rules files. Two probes
showed it does not load them in print mode: asked to quote their first heading
it answered `NONE`, and asked what the workspace was for it answered `UNKNOWN`
when the file's opening line says exactly that.

So the bridge reads the rules itself and prepends them to the `-i` argument
(`buildInitialPrompt`). The alternative — instructing the agent to go and read
the file — was written first and discarded: it spends a tool call to learn
something the bridge can read for free, and under a gate that tool call is an
approval card raised before the user has typed anything. Rules are capped at
`MAX_RULES_CHARS`, and a workspace without them gets the bare nudge.

Verified by a codeword. The rules asked for `XYZZY` at the top of the first
reply; it arrived, which distinguishes "the rules never got there" from "they
got there and were ignored" — two failures that look identical from outside.

One question stays open: whether agy loads these files in interactive mode even
though it does not in print mode, which would make the inlining redundant.
`BRIDGE_INLINE_RULES=0` withholds them so a codeword can answer it.

A caution learned immediately. The first rule said to put command output in a
fenced block, and the agent started dumping raw `ls -l` where it had previously
written a tidy list of filenames — fixing the rendering by degrading the answer.
Telling an agent *how* to present output is one instruction; telling it *what to
show* is another, and conflating them costs more than it buys.

## Designed, not built: a shared terminal

In dual mode the agent already runs under a PTY, and that terminal is
deliberately kept out of the transcript: it renders answers as a redrawing frame
interleaved with spinners, so what arrives is shredded while the submitted
result is exact. That is right for the answer and wrong for everything else —
the terminal is where the interesting failures happen, and at present nobody can
see it.

Every hard problem in this project was diagnosed by turning on
`BRIDGE_PTY_DEBUG` and reading the raw screen: the permission prompt agy was
blocked on, the sign-in that had not finished, the model picker that ignores its
argument. Each looked identical from outside — a turn that never returned.

So: an **optional** mode that surfaces the terminal, with many watchers and one
driver.

### Optional, and off by default

Off, because during an ordinary turn the terminal carries the echoed nudge and
spinner frames and nothing worth reading. On, when something is wrong or when a
person wants to see what the agent is actually doing. The value is visibility
into a component that is otherwise a black box between "prompt sent" and
"answer returned".

It also wants a real terminal emulator on the client. The bridge currently
strips escapes and extracts answers heuristically, which is enough to recover a
sentence and not enough to render a screen. Feeding raw bytes to an emulator in
the client is both more honest and less code — the byte stream is the truth, and
guessing at it is what `extractAnswer` does because it has no other choice.

### Watching is not driving

**Many may watch; one may drive.** Not for etiquette — for the agent. Two people
typing into one TUI do not merely inconvenience each other; they compose a
single garbled instruction that the agent then acts on. An `ESC` from one person
cancels the other's turn with nothing to say who did it.

Control is therefore a distinct grant from viewing, and a much larger one.
Keystrokes into a live agent's terminal are, in practice, use of that machine —
slash commands, cancellation, and whatever the agent will do when asked. Anyone
who may drive can do what the agent can do.

### Handing over

The interface is small and should stay so:

- **Take control** when nobody holds it.
- **Request control** when somebody does — the holder is asked, and a request
  that is ignored expires rather than queueing forever.
- **Give control** to a named watcher, which is the common case: one person
  hands over deliberately.
- **Release**, and an idle timeout that releases for you. A controller who
  walked away should not hold the terminal until they come back.

Every transition is announced in the stream itself, so the record of who was
driving lives in the same place as what they did. A handover nobody can see
afterwards is indistinguishable from someone else's mistake.

### Across networks

Sharing between people on different machines is the peer fabric's problem rather
than this one: the terminal stream is bytes over an authenticated channel, and
who may attach is a capability like any other. Two capabilities, not one —
`terminal-watch` and `terminal-drive` — since the whole point is that they are
different grants.

Note what a shared terminal discloses. It shows everything the agent sees,
including whatever it read on the way: file contents, tokens printed by a
command, an error carrying a connection string. Sharing a terminal with a person
is sharing that, and no permission model above it changes what is on the screen.

### What ACP's terminal actually is, and why it is not this

Worth checking before building anything on the resemblance, because the
resemblance is mostly in the word.

`CreateTerminalRequest` is `{ command, args, cwd, env, outputByteLimit }`, and
the full method set is `terminal/create`, `terminal/output`,
`terminal/wait_for_exit`, `terminal/kill`, `terminal/release`. **There is no
method for sending input.**

So an ACP terminal is a **subprocess runner**, not a terminal: the agent says
run this, polls for what it printed, waits or kills, and releases. Nothing can
type into it — not the agent, not a person. It cannot host an interactive TUI,
cannot be driven, and could not host `agy`.

Which means the earlier claim here — same surface, different producer — was too
strong. A viewer for a non-interactive command's output is a log pane. The
shared terminal is a live TTY with handover. They share "bytes appear over
time" and diverge at everything that made the shared terminal interesting.

**What it does give an agent** is worth stating plainly, since it is the reason
`terminalAccess` is declined rather than served. Arbitrary command, arbitrary
arguments, chosen working directory, and a chosen environment — on the client's
machine. That is shell-equivalent authority there. Not control of T3 as an
application, which has no API here; but a command can do whatever the user
running T3 can do, which includes reading T3's own configuration and state. The
distinction between "control of the app" and "control of the machine the app is
on" does not survive contact with a shell.

The intended use is legible from the shape: an agent that has no shell where the
code is — running remotely, or sandboxed — asking the machine that *does* have
the code to run tests and report back. Useful, and a different feature from
watching a terminal.

### If it is ever served, it is gated by default

Arbitrary command, arguments, working directory and environment on the client's
machine is not a capability to grant quietly. Serving `terminal/create` without
review is the same posture as running an agent with permissions skipped, except
the machine being trusted is the *user's* rather than the agent's.

The gate already exists in the right shape. `run_command` here holds the call,
shows the command text, and waits — the same treatment applies, with the whole
request on the card: command, arguments, working directory, **and environment**.

That last one matters more than it looks, and is the reason to be sceptical of
screening as an alternative to review. **A screened command with an unscreened
environment is not screened.** `PATH` decides which binary `make` is;
`LD_PRELOAD` decides what any binary does; `NODE_OPTIONS` and friends run code
before the program's first line. An allowlist that reads the command string and
ignores `env` approves a name and executes something else.

Command screening is weak on its own terms too. This project already learned it
the hard way: `find` is innocuous until `-exec`, and a shell reaches the same
place through quoting, a subshell, or `sh -c`. Pattern-matching a command line
is defence in depth, not a boundary — the boundary is a person or a policy
seeing the whole request before it runs.

Which is where automation belongs, for anyone who wants it: not a static
allowlist compiled into the client, but a decider that sees the full request in
context and answers approve, refuse, or ask the human. The gate here already
takes exactly that shape, so a supervisor is a decider implementation rather
than new plumbing.

### Two directions, both possible, neither urgent

Surfacing the bridge's own terminal and serving ACP's are separate features. Of
the first, there are two directions and this document does not pick one:

**Client-hosted (ACP's direction).** T3 owns a PTY; the agent asks it to run
things. Standard, already specified, and gives the agent shell-equivalent
authority on the client. It cannot show the agent's own terminal, because the
agent's terminal is not the client's.

**Agent-hosted (the other direction).** The bridge owns the PTY — it already
does — and something attaches to watch or drive it. This is the one that shows
what `agy` is doing, and ACP has no method for it, so it needs a channel of its
own:

- a `session/update` variant carrying terminal bytes, riding a stream that
  already reaches T3, at the cost of a message no other ACP client understands;
- an extension method, which ACP's `_meta` and the runtime's raw `request` both
  allow, explicitly non-standard;
- or a side channel from the bridge — its own endpoint, attached to directly.
  No protocol change, one more thing to authenticate, and the only option that
  composes with sharing a terminal to a second person, since that is not a
  conversation between one client and one agent.

**Neither is urgent.** The bridge works without either, and the visibility a
shared terminal would give is available today through `BRIDGE_PTY_DEBUG` for
anyone debugging. Building it means an emulator in a client, an attach protocol,
control arbitration and a permission model, all for a feature whose value is
felt mostly when something else is already broken. Recorded here so the shape is
known when it is wanted, rather than started because it sounded close to
something else.

### Deferred: how either would land in T3

Design only. Both belong to a more automated setup than exists today, and
building either now would be building for a shape that has not settled.

**Serving ACP terminals** needs the surface whose absence is why the capability
is declined: somewhere for a terminal nobody opened to appear, a list of live
ones with what created each, and the approval card above wired to
`terminal/create`. The pieces are a viewer, a lifecycle, and a gate that already
exists in another form.

**Watching the bridge's terminal** needs an attach channel, an emulator in the
client, and — if more than one person can attach — the control arbitration
sketched above. The side channel is the option that survives contact with the
multi-party case.

They share a viewer and nothing else, which is the correction this section
exists to record. Build the viewer generically if either is built; do not build
either because the other seemed close.

The case that would justify both at once is the automated one: several machines,
agents working unattended, and a person who needs to see what one is doing
without interrupting it — plus a supervisor deciding the routine approvals so
the person is asked only about the rest. That is a coherent destination and a
long way from what is running today, which is one agent, one operator, and a
debug flag that already answers the question.

## Deferred: a supervisor as the decider

Design only, and cheaper than it sounds, because the seam already exists. Every
permission here passes through one decider — `makeGate` wraps a policy, and the
policy falls through to a human. A supervisor is another implementation of that
interface, not new plumbing.

**It answers three ways, not two.** Approve, refuse, or *pass to the human*.
The third is what makes it worth having: a supervisor that must decide
everything is one that will be wrong about something, while one that can defer
handles the routine and escalates what it does not recognise. The failure to
design out is the supervisor that quietly approves rather than admitting it is
unsure.

**It chooses how much to read.** A permission request alone is thin context —
`run_command` with a command string says what will happen and not why. The
useful supervisor reads backwards from the tail of the conversation, and how far
is its own decision, since a request that looks alarming in isolation is often
obvious given the two turns before it.

**And which channel.** The bridge keeps these separate, so a supervisor can ask
for what suits the question:

- the **aggregate**: what the client would show a person, which is the same view
  the human escalation would get;
- the **tool channel**: MCP calls and their arguments, exact and structured;
- the **terminal**: what the agent's own screen showed, which is where the
  answer lives when the question is "what state is it actually in".

Reading the tail rather than the whole conversation is a cost decision as much
as a relevance one — supervision is per-request, and a supervisor that re-reads
everything each time is one nobody leaves switched on.

**What it must not become.** A supervisor is a policy, not an authority: its
approvals are bounded by what the profile already allowed, exactly as a human's
are. It cannot widen a grant, and a request the policy would have refused
outright never reaches it. Otherwise "ask the supervisor" becomes a way around
the rules rather than a way of applying them.

Deferred because it costs tokens per decision and the current shape — one agent,
one operator — has a human close enough to ask. It becomes worth building at the
point where nobody is watching, which is the same point the shared terminal
becomes worth building, and for the same reason.

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
