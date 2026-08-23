# The supervisor

A decider that sits between the policy and the human. Where policy falls through
to *ask*, a supervisor may answer first — approve, reject, or **pass to the
human** — so the routine is handled and only the unfamiliar escalates.

**Built: the seam, the spawn mode, and the seat/queue the two late-binding modes share. Designed: the MCP and ACP transports that drive the seat.**

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

**One caution for the late-bound modes:** with `deny`, "absent" includes *not
yet connected* — so every startup and every supervisor reconnect is a full-deny
window by design. That is safe, but it pressures an operator toward binding
something quickly to clear the window, which tends toward a permanently-bound,
minimally-scrutinised supervisor — worse than the human default. `--require-
supervisor` pairs cleanly with the *spawn* mode, which is always present; with a
late-bound mode the operator is accepting deny-windows and should be told so, and
the claim event logged as loudly as decisions.

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

Two seams exist for this. `createExternalSupervisor()` is the *push* shape —
`bind(handler)` makes a function the decider — but a connected MCP client cannot
be handed a synchronous callback, so the late-binding modes use the *pull* shape
instead: `createSupervisorSeat()` (built, in `supervisorSeat.js`). A client
`claim`s the single seat, reads the decisions `pending` for it, and posts a
verdict by id with `decide`; `status` is what a person reads to see who holds it.
Every fail-safe path is the seat's already — no seat, a full queue, a timeout, a
release, a stale token all resolve to *pass*, and only a live holder's `approve`
approves. What is unbuilt is only the MCP *transport*: the `supervisor/claim`,
`supervisor/pending`, and `supervisor/decide` tools that a connected client
calls, and the operator-authority check that gates the claim. The decision logic
they drive is done.

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

## The late-bound seat is the most privileged reader — three rules it needs

The spawn mode redacts: a supervisor gets `{tool, args}`, and the session's
internals are deliberately withheld. The late-bound modes' whole selling point —
"holds context, watches the conversation, reads backwards from the tail" —
*removes that boundary*. That is not a detail to gloss: whoever binds the seat
gets a standing feed of the full session plaintext, on request. The seat is the
most privileged reader in the system — it sees what the human sees, plus
structured access the human does not have — and none of the following is
optional before either late-bound mode ships.

**Claiming the seat requires operator authority, not mere connection.** The
sketched `supervisor/claim` is a tool a connected client calls, and "who can
connect to the MCP endpoint" was sized for tool callers, not session readers. So
claim must check operator-level authority, the same bar as reloading a plugin or
minting a grant — never "any client that reached the endpoint."

**The seat is single, attested, and visible.** One holder at a time, and the
human must be able to see that a supervisor is bound and which one. An invisible
supervisor is a silent man-in-the-middle of the consent flow — a party deciding
approvals that the person believes they are deciding. Binding and unbinding are
logged as loudly as decisions.

**Which views a seat may read is a property of the claim, not the reader's
choosing.** The aggregate / channel / tail trio is the right shape, but a bound
supervisor should get the views its claim was granted, not whatever it asks for
after the fact. Redaction does not disappear because the mode changed; it becomes
per-view and per-claim.

## An agent supervisor's own calls are policy-decided, never self-decided

Mode 3 — an agent watching an agent — inverts the gate's trust direction, and the
inversion has to be closed explicitly or the mode ships a self-approval path:

- **The supervised agent's requests become another agent's input.** Prompt-
  injection content in a file the small agent read flows into the large agent's
  decision context. The supervisor is a second injection surface, and a more
  capable one — worth stating so nobody treats "bigger model" as "safer."
- **Correlated failure.** Two models of the same family share blind spots;
  "recognises and escalates" fails silently when both misread the same call.
- **The rule that must be stated now:** a supervising agent that needs tools to
  read context has those calls hit the *gate* — and they are **policy-decided,
  never supervisor-decided**. A supervisor approving its own calls is a loop or a
  bypass, which is failing open one level up. The supervisor decides the
  *supervised* agent's calls and nothing of its own.

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

- **The MCP and ACP transports themselves** — the `supervisor/claim`,
  `supervisor/pending`, `supervisor/decide` methods a connected client calls,
  the operator-authority check that gates the claim, and the session-binding
  that ties `decide`/`release` to the holder (the seat's token guards races, not
  identity). The seat and its queue — `createSupervisorSeat` — are built and
  tested; only this transport glue is not.
- **More than one supervisor.** A panel that must agree, or a cheap one that
  escalates to an expensive one, is just nested `withSupervisor` — worth stating
  that the composition is free, once the modes exist to compose.
- **What a supervisor may read across a tunnel.** A supervisor watching a
  *remote* agent's turn is reading that turn's plaintext at the near end, which is
  fine — but a supervisor that is itself remote raises the question the relay
  attestation work is already circling. Defer to that.
