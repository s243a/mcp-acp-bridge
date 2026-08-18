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
