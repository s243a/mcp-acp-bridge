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

## Why a relay rather than a dumb shim: this is where review lives

A shim copies bytes and can inspect nothing. A relay speaks ACP in the clear on
the **near** side, which is the one place the conversation is readable before it
is seal­ed for the tunnel — so everything the bridge's design already wants to do
to a remote turn attaches *here*, and attaches identically for a local one:

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

The shim could do none of this. The relay is the seam the design has been asking
for.

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

## Open

- **Reconnect.** A tunnelled route whose link drops mid-turn: the agent keeps
  running at the far end, and a reconnecting relay must find the session it left
  or cancel it. This is the bridge's existing "link drops mid-turn" open question,
  now with a named place to solve it.
- **How a route is declared, and by whom.** T3 launches the relay with a route
  name; the route table itself is local configuration. Whether peerhailer's
  capability model gates *which* routes a given launch may use is the interesting
  coupling — a machine that may start a `local` route but not a `home` one.
- **Method policy defaults.** A local route probably defaults to no method
  restriction (it is the machine you are sitting at); a tunnelled route probably
  defaults to deny-by-default on the config-changing methods. The defaults are
  where an operator is most likely to be surprised, so they want stating.
