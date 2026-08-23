# The ACP relay

**Status: designed, not built.** Supersedes the "stdio shim" sketched in
`design.md` — the shim was a special case of this.

## What it is

One component that T3 spawns as its ACP `command`, which decides **where the ACP
conversation goes**. Local and remote stop being two code paths and become one
router with different destinations.

T3's contract is unchanged and unchangeable-from-our-side: its ACP driver spawns
a command described in its own schema as *"Executable that speaks ACP over
stdio"*. The relay satisfies that exactly — it speaks ACP over stdio to T3 — and
everything about where the agent runs is behind that face, invisible to T3, which
is what keeps this a zero-fork change.

## Destinations

```
T3  ──stdio──▶  relay  ──▶  { local | tunnel | listen }
```

| Destination | What the relay does | Status |
| --- | --- | --- |
| **local** | spawn the bridge as a subprocess, pipe stdio to it | this is today's behaviour, unchanged |
| **tunnel** | open a peerhailer tunnel to a peer's `--listen`, pipe ACP through it | the new near end |
| **listen** | *(the far end)* `bridge --listen <port>` — already built | done |

Local is the degenerate case: a destination that happens to be a child process
rather than a socket. Writing it as a destination rather than a fork means the
review machinery below runs the same way whether the agent is here or across the
world.

## The destination is chosen by configuration, never by the caller

The rule from tunnel endpoints and declared commands, a third time. A route is
declared out of band:

```
route "home"   -> tunnel to peer "sol" endpoint "acp"
route "local"  -> spawn bridge --agent claude
```

T3 (or whatever peerhailer capability starts the relay) picks a *named* route;
the ACP client on the wire cannot redirect itself. Otherwise a prompt could talk
its own agent into connecting somewhere — the ACP stream is attacker-influenced
the moment a remote peer is driving it, and a stream must not choose its own
exit.

## Why a relay rather than a dumb shim: this is where review is richest

A shim copies bytes and can inspect nothing. A relay speaks ACP in the clear on
the **near** side, which is the one place the conversation is readable before it
is sealed for the tunnel — so everything the bridge's design wants to do to a
remote turn is *cheapest and richest* here, and attaches identically for a local
one:

- **Method policy.** ACP method names are a closed set. "A remote route may not
  call `session/set_config_option`" is an exact check, and it belongs at the
  relay because the relay is where a method is seen before it is acted on. Local
  routes can carry a looser policy or none; the point is that the *axis* exists
  and is per route.
- **The supervisor.** The component that subscribes to permission events and
  decides approve / reject / pass-to-human wants plaintext ACP, and the relay is
  where plaintext ACP is. A supervisor sits at the relay watching a route,
  whether that route is a local agent or a tunnelled one.
- **Source and destination as policy axes.** The relay knows both ends of a
  route by construction — who this is for and where it goes — which is exactly
  what the bridge's source/destination policy needs and could not cleanly get
  when the transport was fixed at spawn.

The shim could do none of this. But — and this is the correction a review forced
— **the relay is where review is richest, not where it lives.** It is not the
only seam, and nothing above makes it one.

### The relay is not the only path to the agent

`tunnel:acp` is a peerhailer capability granted per peer key. The relay reaches
the far `--listen` end *through that capability* — and the far daemon cannot tell
"the relay opening this tunnel" from "any other process on the relay's machine
opening the same tunnel", because both arrive under the same key. So whoever can
drive the relay machine can open a **raw tunnel straight to the agent**, and the
relay — with its method policy, its supervisor, its route-aware axes — sees
nothing. No second grant is needed; the side door is the same door.

What the bypass does *not* remove is the far bridge's own gate and policy, which
travel with the agent regardless of arrival path. So review does not vanish — it
**drops to whatever the far bridge was configured with**, and everything the
relay was going to add is gone. A policy that lives only at the relay applies
only to callers who volunteer for it.

### The fix: attest the relay, enforce at the far end

The far `--listen` end must be able to tell a relayed arrival from a raw one, and
apply its strictest policy to the raw one. The smallest thing that does it:

- **Relay attestation.** The relay presents, per connection, something a raw
  tunnel client does not — a shared secret in the ACP handshake, or the relay's
  signature over a session nonce. One config item at each end, no new crypto.
- **Not refusal — demotion.** A connection without attestation is *not* rejected;
  the far bridge still works for direct local use. It is answered with the
  strictest posture the bridge knows — its existing `review-everything` — which
  is exactly right for an arrival that declined supervision.

So method policy at the relay is **necessary but not sufficient**: the far end
must also enforce, not as duplication but because that is what makes the relay's
policy a *ceiling* rather than a suggestion. Without it, the relay's whole value
is opt-in by the very party you might not trust.

None of that changes what the relay is *for* — it is still where method policy,
the supervisor, and the route-aware axes are cheapest to run. It changes what
makes them binding: the far end, not the relay's goodwill.

## How it composes with sealing

Unchanged division of labour, now with an explicit router at the near end:

```
T3 ─stdio─▶ relay ─(policy, supervisor: sees plaintext ACP)─▶ seal ─▶
   peerhailer tunnel (carries bytes, reads nothing) ─▶ remote bridge ─▶ agent
```

- **peerhailer** answers *who* — the peer is authenticated, `tunnel:acp` is held,
  the arrival is encrypted.
- **the relay** answers *what* — which method, for which route, watched by which
  supervisor.
- **the bridge** runs the agent and raises the approval cards, which travel back
  up the same wire to the person at T3.

The relay reads ACP; the tunnel does not. That is the sealed-payload rule from
the tunnel design, with the relay as the thing on the near side that holds the
plaintext.

## What the relay does not do

**Not authentication.** A tunnel destination is reached through peerhailer, which
authenticated the peer; the relay does not re-check that. A local destination is
a child process it spawned. The relay routes and inspects; it never decides who a
peer is.

**Not transport.** It carries ACP specifically, because it understands ACP enough
to apply method policy. Arbitrary bytes are the tunnel's job. A relay that could
carry anything could inspect nothing, which is the shim again.

**Not a place the caller supplies an address.** Routes are named and declared,
for the reason above.

## Local and remote are not symmetric in failure

"Local is the degenerate case" is true for *routing and review* — the same code
path, the same inspection. It is false for *failure semantics*, and the
difference matters enough to state:

- **A local exit fails closed; a remote one can fail open.** A local agent that
  responds is the right agent — you spawned it. A remote agent that responds
  proves only that *something* answered: a mis-pointed route name lands on a
  different machine's agent, fully functional, approval cards and all, and the
  relay's review runs happily against the wrong destination. Named routes bound
  *caller* misdirection; nothing bounds *operator* misconfiguration, and the
  degenerate-case framing must not be read as "the route table is checked". It
  is not — it is config, and a wrong entry is a working tunnel to the wrong
  place.
- **Reconnect inherits the asymmetry** — see the two rules above. Locally,
  finding the session is trivial; remotely it is an authentication question.

Nothing in the core design depends on a symmetry it does not have, but the
reconnect work is where assuming it would produce a real hole.

## Open

- **Reconnect is an authentication problem, not a routing one.** A tunnelled
  route whose link drops mid-turn leaves the agent running at the far end, and a
  reconnecting relay must reattach. Two rules the design commits to now, before
  the code exists, because getting either wrong is a hole rather than a bug:
  - **A session pins its exit at establishment; reconnect re-finds, never
    re-chooses.** If reconnection re-resolved the route *by name*, a route-table
    edit between drop and reconnect would move a live session to a different
    exit — the stream influencing its own exit, once removed, which claim 2 is
    supposed to forbid.
  - **The far end must re-authenticate the session, not just the route.**
    "Find the session I left" is a claim the far end has to check with a session
    token the reconnecting relay presents. Fail-open here attaches a relay to
    whatever session the far end thinks matches — a stranger's agent, with a
    stranger's conversation in its context.
- **How a route is declared, and by whom.** T3 launches the relay with a route
  name; the route table itself is local configuration. Whether peerhailer's
  capability model gates *which* routes a given launch may use is the interesting
  coupling — a machine that may start a `local` route but not a `home` one.
- **Method policy defaults.** A local route probably defaults to no method
  restriction (it is the machine you are sitting at); a tunnelled route probably
  defaults to deny-by-default on the config-changing methods. The defaults are
  where an operator is most likely to be surprised, so they want stating.
