# The supervisor

A decider that sits between the policy and the human. Where policy falls through
to *ask*, a supervisor may answer first — approve, reject, or **pass to the
human** — so the routine is handled and only the unfamiliar escalates.

**Built: the seam, the spawn mode, the seat/queue, and both the MCP and ACP transports.**

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

## Four modes, one interface

A supervisor is `(call) => Promise<"approve" | "reject" | "pass">`. Four ways to
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

### 2. MCP — built

The bridge already runs an MCP endpoint for the agent's tools. A supervisor could
connect to it as a *second* client and register as the decider — the bridge
exposes a tool the supervisor calls to claim the seat, and each pending decision
is offered to it and awaits its answer.

A connected MCP client cannot be handed a synchronous callback, so this uses the
*pull* shape: `createSupervisorSeat()` (`supervisorSeat.js`). Run the bridge with
`--supervisor-mcp` and it prints a **supervisor session URL** — a dedicated
`/mcp/<token>` path, separate from any agent's. A client connected there gets
five tools: `supervisor_claim`, `supervisor_pending`, `supervisor_decide`,
`supervisor_release`, and `supervisor_force_release`. It claims the single seat,
polls the decisions pending for it (each redacted to tool and args), and answers
one by id; `approve` allows, `reject` denies by policy, anything else passes to
the human. The tools **bypass the permission gate** — in seat mode the gate's
ask-path *is* the seat, so a `supervisor_decide` put through the gate would be
queued as another decision to answer: the reviewer's own console must not be a
reviewed action.

`supervisorAdapter.js` is what binds the seat to that session: the seat's random
token never leaves the process — the adapter holds it and identifies the client
by *which session its calls arrive on*, which the opaque path makes unforgeable.
`isOperator` gates the claim to the supervisor session the bridge created, so
reaching the endpoint is not enough; and only the seat-holder's session is
offered decisions or may decide. The same tools are visible to the agent's
session (one gateway), but every one is gated — the agent is not an operator and
never holds the seat, so calling them gains it nothing. Every fail-safe path is
the seat's: no seat, a full queue, a timeout, a release, a stale token all
resolve to *pass*, and only a live holder's `approve` approves.

One property to know: MCP over stateless HTTP has no disconnect signal, so a
supervisor that vanishes without `supervisor_release` leaves the seat nominally
held — decisions still *pass* on the per-decision timeout, and an operator
recovers the seat with `supervisor_force_release` — gated by operator authority,
not by holding the seat, since the holder is who is gone. The adapter's
`disconnect` hook is there for a transport that *can* detect it (ACP).

Why it is worth the extra shape over spawn: a spawned reviewer starts cold every
decision and reads only what is piped to it. A connected one is a *session* — it
can hold context across decisions, watch the conversation as it happens, and read
backwards from the tail as far as a given question needs. That is the difference
between a filter and a reviewer.

### 3. ACP — built

The same seat, over ACP, for a supervisor that is itself an agent. Run the bridge
with `--supervisor-acp [port]` and it opens a **TCP endpoint** a supervising ACP
client connects to — a *separate* connection from the one driving the agent.
Reaching the port is **not** authority: the port is loopback, and the supervised
agent runs on the same machine with shell-class tools, so it can reach the port
too. A connection becomes an operator only after presenting the **token the
bridge prints to its console** (stderr, which the agent cannot read) via ACP
`authenticate`. Without it, the connection supervises nothing — closing the
self-approval the agent would otherwise have. Once authenticated it calls the
same five methods as MCP: `supervisor/claim`, `supervisor/pending`, `supervisor/decide`,
`supervisor/release`, `supervisor/force_release`. This is the mode that lets *one
agent supervise another* — a larger model watching a smaller one's actions.

It reuses the built seat and `supervisorAdapter` unchanged (`supervisorAcp.js` is
the surface) — pull, not push: the client polls `supervisor/pending` and posts
`supervisor/decide`, the same queue MCP drives, so one hardened seat serves both
transports with no second decision path.

**ACP has what stateless MCP lacks: a disconnect signal.** A closed connection
frees the seat immediately (`adapter.disconnect`), so a supervisor that drops does
not wedge it — the case MCP needs `force_release` for resolves on its own here.

### 4. ACP push — built

The mirror of mode 3, and the more agent-idiomatic shape. Run the bridge with
`--supervisor-acp-push [port]` and it opens a **TCP endpoint** a supervising agent
connects to — but the direction reverses: instead of the agent polling a seat, the
bridge sends **each deferred decision to the agent as a `supervisor/review`
request** (`{tool, args}`, redacted the same way), and the agent's reply is the
verdict. Exactly how the bridge already raises `session/request_permission` to an
ACP client — an agent that supervises is asked, not made to poll.

The door is identical to mode 3: reaching the loopback port is not authority (the
supervised agent can reach it too), so the connection becomes the decider only
after presenting the **token the bridge prints to its console** via ACP
`authenticate`. This mode sits on `createExternalSupervisor` (the push *seam*)
rather than the seat: on authentication the connection *binds* as the decider, and
its close *unbinds* it — decisions fall back to the human with no force-release.
The seam's **generation token** discards a verdict still in flight when the
supervisor drops (fail-closed, never a stale allow), and a review the agent never
answers resolves to a deferral on the seam's own timeout, so a slow or silent
reviewer never hangs the gate. Verdicts read through the same `readVerdict` as
every mode — `approve` is the only thing that approves; `reject`, `pass`, empty,
or garbage all defer to the human.

`supervisorAcpPush.js` is the surface. Pull (mode 3) and push (mode 4) are
separate decision paths on purpose — pull drives the shared seat queue, push
drives the external seam — but both fail toward the human and both gate on the
same console token.

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

## Response timing: making a supervisor human-like

An automated supervisor answers in milliseconds; a person does not. `--supervisor-timing`
paces a supervisor's verdict so the *observed* response time — from a call being
held to its verdict applied — follows a distribution **clipped to `[min, max]`**:

```
bridge --supervisor-mcp --supervisor-timing '{"min":2000,"max":30000,"dist":"gamma","shape":2}'
```

The profile is JSON: `min`/`max` in milliseconds (the floor and ceiling — "both
clipped"), and `dist` one of `uniform`, `exponential`, `gamma`, `normal`,
`lognormal`, `poisson`, each with optional parameters (`meanMs`, `shape`/`scaleMs`,
`meanMs`/`sdMs`, `mu`/`sigma`, `lambda`/`unitMs`); sensible defaults derive from
`min`/`max` when parameters are omitted. It applies to whichever supervisor is
active (spawn, MCP seat, ACP, ACP-push).

Two invariants keep it honest:

- **It only adds latency.** The shaper cannot change a verdict, and it never
  resolves *sooner* than the underlying supervisor produced one — so a fast
  approval is held to look considered, but a slow one is not hurried.
- **A non-answer is not paced.** Abstention (the seat's timeout to `pass`) is not
  a response, so it is not shaped; it resolves on the seat's own timeout, and the
  gate's outer timeout still bounds everything. Keep `max` below the gate timeout
  (120s) so a paced verdict does not race the timeout to a deny.

Implementation: `src/supervisorTiming.js` (`sampleDelay`, `withResponseTiming`,
`parseTimingProfile`).

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

- **More than one supervisor.** A panel that must agree, or a cheap one that
  escalates to an expensive one, is just nested `withSupervisor` — worth stating
  that the composition is free, once the modes exist to compose.
- **What a supervisor may read across a tunnel.** A supervisor watching a
  *remote* agent's turn is reading that turn's plaintext at the near end, which is
  fine — but a supervisor that is itself remote raises the question the relay
  attestation work is already circling. Defer to that.
