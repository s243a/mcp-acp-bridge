# mcp-acp-bridge

An **ACP server that fronts any MCP-speaking coding agent.**

The bridge hosts an MCP server for the agent and speaks
[ACP](https://agentclientprotocol.com) to an editor or client. Because every
tool call the agent makes passes through it, the bridge can hold each one and
ask the client for approval first — turning tool calls into real permission
prompts in whatever UI is driving.

```
client (T3 Code, Zed, …) ──ACP──► bridge ──MCP──► agent (agy, claude, codex, …)
                                    │
                                    └─ spawns and supervises the agent process
```

> **Status: the full chain works.** An ACP client drives the bridge, the bridge
> spawns a real agent, the agent's MCP tool call is held, and it surfaces to the
> client as `session/request_permission` — answered with allow or deny, either
> outcome reaching the agent legibly. Verified end-to-end against Claude Code.
>
> Not yet done: `session/load` (resume), command allow/block lists, and
> broker-provided file and shell tools. See [docs/design.md](docs/design.md).

## Try it

```bash
npm install
npm test              # unit tests, no agent required
npm run test:live     # drives the real `claude` CLI against the gateway
npm run test:bridge   # full chain: ACP client -> bridge -> agent -> approval
npm run test:bridge deny
```

The only native dependency, `node-pty`, is **optional** — it is needed just for
the PTY agents (`agy-dual`, `agy-dual-gated`). If its build fails (no C++
toolchain, e.g. on a minimal Linux box), `npm install` keeps going and the bridge
still runs the non-PTY agents (`claude`, `codex`, `gemini`) — those never load
it. Only starting a PTY agent without it errors, and says so.

`test:live` needs the `claude` CLI on PATH and authenticated. It hands Claude
Code a per-session MCP endpoint, asks it to call a tool, and shows the
interception:

```
[tool] requested magic_word
[gate] DENY magic_word {}
[tool] denied magic_word (denied by test policy)
[claude] said: The tool call was denied. The error returned was exactly:
         `Error: permission denied: denied by test policy`
```

## Why

Some coding agents emit no structured output. Google's Antigravity CLI (`agy`)
is the motivating case: it has no ACP mode
([upstream request](https://github.com/google-antigravity/antigravity-cli/issues/31)),
and in headless mode it prints plain text and **auto-denies** any permission it
cannot prompt for. Driving it from a GUI therefore means either scraping a TUI
or giving up on approvals.

This bridge takes a third path. It ignores what the agent *says* and intercepts
what the agent *does*: MCP tool calls are already structured, already
observable, and — crucially — already interceptable. An MCP server is not a
listener, it is a **gate**.

Nothing about the approach is agent-specific. Any agent that can be pointed at
an MCP server works.

## What it does and does not see

MCP is a *tool* channel, not an agent-output channel.

| ACP output | Source | Fidelity |
| --- | --- | --- |
| `tool_call`, `tool_call_update` | intercepted MCP calls | exact |
| `session/request_permission` | one per intercepted call | exact |
| `agent_message_chunk` | the agent's stdout | per-agent |
| turn boundaries | process lifecycle | exact |

An agent's **built-in** file and shell tools do not traverse MCP, so they raise
no `tool_call`. That is a visibility gap, not a correctness one — clients that
checkpoint the workspace (T3 Code diffs it on turn boundaries) still record what
changed. What is lost is live per-action progress, not the record.

## Choosing a mode

Modes differ in what stops for review. Pick by what you are willing to have
happen without being asked.

| Mode | Turns | Tool calls | Shell |
| --- | --- | --- | --- |
| `agy-dual` | over MCP | not reviewed | **runs unreviewed** |
| `agy-dual-gated` | over MCP | not reviewed | reviewed, with the command shown |
| `agy-gated` | over MCP | reviewed | no shell in an empty workspace |
| `agy-sandboxed` | headless | not reviewed | OS sandbox, permissions skipped |

### What an unreviewed shell means

`agy-dual` grants the agent's shell tool outright, and a granted shell is not
bounded by the deny list. Those rules are per-tool: `write_file(/home/you/.ssh)`
constrains the agent's *file* tool, and a shell command is not that tool.

This is measured, not theoretical. **Observed 2026-08-19 on agy 1.1.15**, with
the default deny rules in place, from a single prompt:

```
find . -maxdepth 0 -exec sh -c 'echo CANARY > /home/you/bridge-canary.txt' \;
```

The file was written, outside the workspace, with no prompt. The same request
under `agy-dual-gated` arrives as a permission card carrying that command text;
refused, nothing is written.

Two things can make this look contained, and neither is a boundary. Writes
relative to `$HOME` land in the throwaway per-session home and vanish with it,
so a `$HOME` canary disappears where an absolute path does not; and an agent
usually has no reason to leave its workspace at all.

Antigravity's own sandboxing is moving, and a later release may well close this.
Treat the date and version above as the scope of the claim rather than a
standing property of agy, and re-run the canary if it matters to you — one
prompt, and the answer is a file that either exists or does not.

In practice the realistic risk is an accident — a wrong path, an overreaching
cleanup — rather than anything deliberate, and running an agent on your own
machine is ordinary. `agy-dual` is a reasonable default for a workspace you can
restore. What it is not is a place to keep credentials you would mind losing.

### If this matters to you

Use both. They fail in different directions, which is the point.

**Run the bridge in an OS sandbox.** This is the only real boundary: it bounds
what the process can reach at all, whatever tool it reaches with and whatever
path it names. On Linux, `bwrap` or `firejail` with the workspace bound in and
`$HOME` left out; a container or VM does the same job more heavily. On macOS,
a container, or `sandbox-exec` for a rough equivalent. What a sandbox will not
do is tell you what is about to happen — it silently refuses, and the agent
usually reports a confusing failure.

**And use `agy-dual-gated`.** Review is what a sandbox cannot give you: the
command arrives as text you can read before it runs, so a mistake is visible
rather than merely blocked. What review cannot give you is a guarantee, since
it rests on a deny rule matching the tool the agent chose.

Together, the sandbox bounds the damage and the gate shows you the intent.
Either alone leaves a real gap: a sandbox with an unreviewed shell will let the
agent thrash destructively inside your workspace without ever asking, and review
without a sandbox depends on the agent taking the route you gated.

One thing not to confuse with any of this: agy's own `--sandbox` flag, used by
the `agy-sandboxed` profile, is described by agy as *terminal restrictions*. In
testing it did not stop file reads outside the workspace, with or without the
flag. It is not an OS sandbox and should not be relied on as one.

### A supervisor to answer the reviews

Review shows you the command, but a person cannot sit on every prompt. A
**supervisor** is a decider that sits in front of the human on the same seam:
it may approve, reject, or *pass to the human*, and every way it can fail —
unavailable, malformed verdict, timed out — resolves to pass, never to allow.
Four ways to supply one:

| Flag | The supervisor is… |
| --- | --- |
| `--supervisor <cmd>` | a command run per decision; its stdout is the verdict |
| `--supervisor-mcp` | a client that claims a seat over MCP and answers pending decisions |
| `--supervisor-acp [port]` | the same seat over ACP, for a supervisor that is itself an agent (it polls a queue) |
| `--supervisor-acp-push [port]` | an agent the bridge *asks* — each deferred decision is sent as a `supervisor/review` request whose reply is the verdict |

This is how one agent supervises another — a larger model watching a smaller
one's tool calls — without a person on every card. The ACP modes gate on a
token the bridge prints to its console, since the supervised agent can reach the
same loopback port. Design, the fail-closed guarantees, and the precedence
between modes: [docs/supervisor.md](docs/supervisor.md).

## MCP revision support

Both the current and the incoming revisions are supported, because the bridge
never keys anything on MCP transport state:

| Revision | Handshake | Session |
| --- | --- | --- |
| 2025-03-26 | `initialize` / `initialized` | `Mcp-Session-Id` header, optional |
| 2026-07-28 (RC) | none | removed; request metadata inline in `_meta` |

ACP sessions are correlated by a **path-scoped endpoint URL**, one per agent
run, so both revisions behave identically. See
[docs/design.md](docs/design.md#supporting-both-mcp-revisions).

## License

MIT. See [LICENSE](LICENSE).
