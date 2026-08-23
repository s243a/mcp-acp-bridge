/**
 * The supervisor seat, and the queue of decisions offered to it.
 *
 * `createExternalSupervisor` (in `supervisor.js`) models the *push* shape: a
 * bound handler is called with each decision and returns the verdict. The
 * late-binding modes the doc describes — an MCP client, an ACP agent — do not
 * work that way. A connected client cannot be handed a synchronous callback; it
 * *claims* the seat, *reads* the decisions waiting for it, and *posts* verdicts
 * by id. This is that pull shape: a single visible seat, and a queue.
 *
 * The one rule is the supervisor's rule, made no weaker by the extra machinery:
 * **it never fails open.** No seat, a full queue, a timeout, a released or
 * replaced seat, a stale token, an unknown verdict — every one resolves to
 * PASS. Only a current seat-holder's explicit `approve` returns approve.
 *
 * Transport-free on purpose. It holds no socket and speaks no protocol, so it
 * is unit-testable without a bridge, and the MCP and ACP surfaces are thin
 * adapters over `claim` / `pending` / `decide` / `release`. Two boundaries are
 * the adapter's to enforce, and are stated where they bite:
 *
 *   - **Operator authority to claim.** `claim` refuses without an `operator`
 *     credential, so a forgetful adapter fails closed rather than opening the
 *     seat to any client that reached the endpoint. The adapter still must be
 *     the thing that *decides* a client is an operator; this is the backstop.
 *   - **Binding decide/release to the seat-holder's session.** The `token` here
 *     guards against stale-generation races, not as a bearer secret — the
 *     adapter must only route a connected holder's own calls here. See the doc.
 *
 * @module supervisorSeat
 */
import { randomBytes } from "node:crypto";

import { PASS, DEFAULT_SUPERVISOR_MS, readVerdict } from "./supervisor.js";

/** At most this many decisions wait for the seat at once; beyond it, PASS. */
export const MAX_PENDING = 32;

/**
 * @param {{ timeoutMs?: number, now?: () => number, maxPending?: number }} [options]
 */
export function createSupervisorSeat({ timeoutMs = DEFAULT_SUPERVISOR_MS, now = Date.now, maxPending = MAX_PENDING } = {}) {
  /** @type {{ by: string, at: number, views: string[], token: string } | null} */
  let seat = null;
  // Bumped on every claim and release. A pending decision captures the
  // generation it was offered under; if it changed, the seat has been released
  // or handed on, and the decision is void. This is the race guard; the seat's
  // random `token` is the separate thing that authorizes decide/release.
  let generation = 0;
  let nextId = 1;

  /** @type {Map<string, { call: any, resolve: (v: string) => void, born: number, offeredAt: number, timer: any }>} */
  const queue = new Map();

  /** @param {string} id @param {string} verdict */
  const settle = (id, verdict) => {
    const entry = queue.get(id);
    if (!entry) return;
    clearTimeout(entry.timer);
    queue.delete(id);
    entry.resolve(verdict);
  };

  // Any change of hands voids everything outstanding, to PASS. A decision
  // offered to the seat one operator held is not the next one's to answer.
  const voidAll = () => {
    for (const id of [...queue.keys()]) settle(id, PASS);
  };

  /** @param {any} call */
  const supervise = (call) =>
    new Promise((resolve) => {
      if (!seat) return resolve(PASS); // nobody holds the seat — the human decides
      if (queue.size >= maxPending) return resolve(PASS); // a stuck holder must not queue the world
      const id = String(nextId++);
      // Not unref'd: a pending decision is real in-flight work — an agent
      // blocked awaiting approval — so the process should stay alive while one
      // is outstanding, exactly as long as the timer runs. It clears itself the
      // moment the decision settles (verdict, timeout, or the seat's release),
      // so it never holds the loop open past a genuinely pending decision.
      const timer = setTimeout(() => settle(id, PASS), timeoutMs);
      queue.set(id, { call, resolve, born: generation, offeredAt: now(), timer });
    });

  return {
    /** The decider to hand `withSupervisor`. */
    supervise,

    /**
     * Take the seat. Refuses if it is held (one holder at a time) or if no
     * operator credential is presented (the fail-closed backstop described
     * above). Returns the token the holder answers with.
     * @param {{ by?: string, operator?: boolean, views?: string[] }} [claim]
     * @returns {{ ok: true, token: string } | { ok: false, reason: string }}
     */
    claim: ({ by, operator, views = ["tool-args"] } = {}) => {
      if (!operator) return { ok: false, reason: "claiming the supervisor seat requires operator authority" };
      if (seat) return { ok: false, reason: `the seat is held by ${seat.by}` };
      // The token is a CSPRNG string, not the generation counter: `generation`
      // is a small sequential integer used only for the born-race check, and a
      // guessable token would let a non-holder decide with a one-digit brute
      // force if an adapter ever slipped on session-binding. Unguessable by
      // construction shrinks that from a discipline to a property.
      const token = randomBytes(16).toString("hex");
      seat = { by: String(by ?? "unknown"), at: now(), views: [...views], token };
      generation += 1;
      return { ok: true, token };
    },

    /**
     * Release the seat. Only its current holder's token may, and doing so voids
     * anything still pending — to PASS, never to a verdict the departing holder
     * did not give.
     * @param {string} token
     */
    release: (token) => {
      if (!seat || token !== seat.token) return false;
      seat = null;
      generation += 1;
      voidAll();
      return true;
    },

    /**
     * Release whoever holds the seat, no token needed — for a holder that
     * crashed without releasing and would otherwise wedge the seat until the
     * bridge restarts (every claim refused, every decision queuing to PASS). The
     * adapter gates this behind operator authority, the same bar as `claim`.
     */
    forceRelease: () => {
      if (!seat) return false;
      seat = null;
      generation += 1;
      voidAll();
      return true;
    },

    /**
     * The decisions waiting for the current holder, each cut down to the views
     * its claim was granted. The holder reads this and answers by id.
     * @param {string} token
     */
    pending: (token) => {
      if (!seat || token !== seat.token) return [];
      return [...queue.entries()].map(([id, entry]) => ({ id, ...redact(entry.call, seat.views) }));
    },

    /**
     * The holder's verdict for one pending decision. Ignored — not honoured as a
     * pass, simply not applied — unless the token is the live seat's and the
     * decision was offered under it. The verdict itself goes through the same
     * `readVerdict` the whole supervisor uses, so `approve` is the only thing
     * that approves and everything else is a deferral.
     * @param {string} token @param {string} id @param {string} verdict
     */
    decide: (token, id, verdict) => {
      if (!seat || token !== seat.token) return false;
      const entry = queue.get(id);
      if (!entry || entry.born !== generation) return false;
      settle(id, readVerdict(verdict));
      return true;
    },

    /** What a person must be able to see: who holds the seat, since when, how many wait. */
    status: () => (seat ? { held: true, by: seat.by, since: seat.at, pending: queue.size } : { held: false, pending: 0 }),
  };
}

/**
 * A decision, cut to the views a claim was granted. Today the only view is
 * `tool-args` — `{tool, args}`, the same redaction the spawn supervisor sees —
 * so by default the seat learns what will happen, not the session's internals.
 * The broader views the doc describes (aggregate, channel, tail) are per-view
 * additions here, not a rewrite: a claim that was granted them gets them, and
 * one that was not never does.
 * @param {any} call @param {string[]} views
 */
function redact(call, views) {
  /** @type {Record<string, any>} */
  const out = {};
  if (views.includes("tool-args")) {
    out.tool = call?.tool;
    out.args = call?.args;
  }
  return out;
}
