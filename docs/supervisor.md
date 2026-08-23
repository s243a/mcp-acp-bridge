# The supervisor

A decider that sits between the policy and the human. Where policy falls through
to *ask*, a supervisor may answer first — approve, reject, or **pass to the
human** — so the routine is handled and only the unfamiliar escalates.

**Built: the seam and the spawn mode. Designed: the two late-binding modes.**

## The one rule everything else serves

**It can never fail open.** A supervisor that is slow, absent, crashed, or unsure
resolves to *pass* — never to allow. Every path in `supervisor.js` funnels
there: a throw, an unparseable verdict, an empty answer, a timeout, and "nobody
is bound yet" all become `pass`. What `pass` then *means* is the operator's
choice — fall through to the human, or refuse — but it is never an approval (see
below). The design failure this avoids is the
supervisor that quietly approves rather than admitting it does not know. A
reject, likewise, is reported as `denied-by-policy` and not as a human refusal,
so the agent is told a *policy* decided — it must not act as though a person
refused when none did.

This is why a supervisor is safe to add: at worst it changes nothing (everything
passes through to the human), and it can only ever *remove* work from the human,
never grant on their behalf without being explicit about it.

### What an absent supervisor means is configurable

Absent — crashed, timed out, or not yet bound — resolves to one of two things,
never to allow:

- **`human`** (default, `--supervisor` alone). The call falls through to the
  human. With a human present that is normal review; unattended, no human
  answers and the gate timeout denies. Safe in both.
- **`deny`** (`--require-supervisor`). While the supervisor is not answering,
  refuse. This is "nothing runs unwatched" — for unattended operation where the
  supervisor is the *only* intended reviewer, so its silence does not become a
  human's silence-until-timeout with a wider window than you meant.

Both apply only to **abstention**. A supervisor that is present and answers —
approve or reject — is always honoured; `--require-supervisor` never overrides a
real verdict, only fills the gap when there is none. And neither posture is
*approve*, because that is the one thing a supervisor's absence must never
become.

## Three modes, one interface

A supervisor is `(call) => Promise<"approve" | "reject" | "pass">`. Three ways to
supply that function:

### 1. Spawn — built

```sh
bridge --supervisor ./review.sh
```

A command run per decision. The call — `{tool, args}` — is written to its stdin
as one JSON line; its stdout, read to completion, is the verdict. `approve` and
`reject` are final; anything else is `pass`. It gets 20 seconds, after which it is
killed and the call passes to the human.

Everything about *what* the command does is behind that boundary — a shell
one-liner, a script, a call to a model — exactly as a declared command's body is.
What is fixed is the contract: JSON in, a word out, silence means pass.

The call is redacted to `{tool, args}` before it crosses: a supervisor decides on
what will happen, not on the session's internals.

### 2. MCP — designed, late-bound

The bridge already runs an MCP endpoint for the agent's tools. A supervisor could
connect to it as a *second* client and register as the decider — the bridge
exposes a tool the supervisor calls to claim the seat, and each pending decision
is offered to it and awaits its answer.

`createExternalSupervisor()` is the seam: `bind(handler)` makes a function the
decider, `unbind()` releases it, and while nothing is bound every call passes to
the human. What is unbuilt is the MCP surface that turns a connected client's
tool calls into `bind`/answer — a `supervisor/claim`, a `supervisor/decide`, and
the plumbing that hands each pending call to whoever claimed the seat.

Why it is worth the extra shape over spawn: a spawned reviewer starts cold every
decision and reads only what is piped to it. A connected one is a *session* — it
can hold context across decisions, watch the conversation as it happens, and read
backwards from the tail as far as a given question needs. That is the difference
between a filter and a reviewer.

### 3. ACP — designed, late-bound

The same, over ACP instead of MCP, for a supervisor that is itself an agent. It
connects to the bridge (over stdio, or over `--listen`), and the bridge offers it
each pending decision as an ACP request it answers. This is the mode that lets
*one agent supervise another* — a larger model watching a smaller one's actions,
deciding what it recognises and escalating what it does not.

It uses the same `createExternalSupervisor` seam; only the surface differs. The
unbuilt part is the ACP method the bridge raises to the supervising agent and the
mapping of its reply to a verdict.

## What a supervisor chooses to read

A permission request alone is thin — `run_command` with a command string says
what will happen and not why, and a request that looks alarming in isolation is
often obvious given the two turns before it. So a real supervisor reads context,
and **how much is its own decision**. The bridge keeps three views separate so a
supervisor can ask for what suits the question:

- the **aggregate** — what the client would show a person, the same view the
  human escalation would get;
- a **channel** — the MCP tool calls, or the terminal, on their own;
- the **tail** — the last N turns, backwards from the decision, which is usually
  enough and cheapest.

The spawn mode sees only what is piped (today, the call itself). The late-bound
modes, being sessions, can request more — which is the substantive reason to
build them.

## Composition with everything else

- **After policy, before the human.** Allow and deny never reach it — those are
  already decided. It only ever sees the *ask* fall-through, which is where
  judgement is wanted.
- **At the bridge, not the fabric.** A supervisor reads plaintext ACP, and the
  bridge is where plaintext ACP is — the peer fabric carries sealed bytes and can
  see none of this. Same reason method policy lives here.
- **Per relay route, eventually.** When the relay lands, a route can name a
  supervisor, so *this* peer's agent is watched and *that* one's is not — the
  supervisor becoming one of the route-aware axes the relay already wants.

## Open

- **The MCP and ACP surfaces themselves** — the claim/decide methods and the
  queue that offers pending calls to the bound decider. `createExternalSupervisor`
  is built; what feeds it is not.
- **More than one supervisor.** A panel that must agree, or a cheap one that
  escalates to an expensive one, is just nested `withSupervisor` — worth stating
  that the composition is free, once the modes exist to compose.
- **What a supervisor may read across a tunnel.** A supervisor watching a
  *remote* agent's turn is reading that turn's plaintext at the near end, which is
  fine — but a supervisor that is itself remote raises the question the relay
  attestation work is already circling. Defer to that.
