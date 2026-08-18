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

> **Status: early. Not yet usable.** Scaffolding and design only — no working
> implementation. See [docs/design.md](docs/design.md).

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

Routing built-ins through the bridge as MCP tools closes that gap and upgrades
the security model from standing grants to per-action review. It is planned
hardening, not a prerequisite.

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
