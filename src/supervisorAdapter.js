/**
 * Binding the supervisor seat to a transport's sessions.
 *
 * The seat (`supervisorSeat.js`) is transport-free: it authorizes with a random
 * token and knows nothing of who is connected. This adapter is the piece that
 * ties the seat to a *session* — an MCP path, an ACP connection — so a client
 * claims by connecting, not by carrying a secret. The seat's token never leaves
 * this process: the adapter holds it and looks it up by session, so a client is
 * identified by *which session its calls arrive on*, which the transports make
 * unforgeable (MCP by the opaque `/mcp/<token>` path, ACP by the connection).
 * The token remains as server-side defense in depth, not as a bearer secret the
 * client must guard.
 *
 * Two boundaries, both fail-closed here:
 *
 *   - **Operator authority to claim.** `isOperator(session)` gates the claim.
 *     Injected, because only the transport knows which session is an operator's
 *     — for MCP, the dedicated supervisor session the bridge created, as opposed
 *     to an agent's. Defaults to refusing everyone, so a forgetful wiring opens
 *     the seat to nobody rather than to all.
 *   - **Only the holder decides.** `pending`/`decide`/`release` act only for the
 *     session that currently holds the seat; any other session gets nothing and
 *     no verdict, never a pass turned into an approve.
 *
 * @module supervisorAdapter
 */

/**
 * @param {ReturnType<import("./supervisorSeat.js").createSupervisorSeat>} seat
 * @param {{ isOperator?: (session: string) => boolean }} [options]
 */
export function createSupervisorAdapter(seat, { isOperator = () => false } = {}) {
  /** @type {{ session: string, token: string } | null} */
  let holder = null;

  /** @param {string} session */
  const holds = (session) => holder !== null && holder.session === session;

  return {
    /**
     * Take the seat for this session. Refused unless the session is an operator's
     * and the seat is free (idempotent for the current holder).
     * @param {string} session
     */
    claim: (session) => {
      if (!isOperator(session)) return { ok: false, reason: "not authorized to supervise" };
      if (holds(session)) return { ok: true }; // already yours
      const result = seat.claim({ by: String(session), operator: true });
      if (!result.ok) return { ok: false, reason: result.reason };
      holder = { session, token: result.token };
      return { ok: true };
    },

    /**
     * The decisions waiting for this session, or [] if it does not hold the seat.
     * @param {string} session
     */
    pending: (session) => (holds(session) ? seat.pending(holder.token) : []),

    /**
     * This session's verdict for one pending decision. Ignored unless the session
     * holds the seat.
     * @param {string} session @param {string} id @param {string} verdict
     */
    decide: (session, id, verdict) => {
      if (!holds(session)) return { ok: false, reason: "you do not hold the supervisor seat" };
      return { ok: seat.decide(holder.token, id, verdict) };
    },

    /**
     * Give up the seat. Only the holder may.
     * @param {string} session
     */
    release: (session) => {
      if (!holds(session)) return { ok: false };
      seat.release(holder.token);
      holder = null;
      return { ok: true };
    },

    /**
     * The transport calls this when a session ends, so a supervisor that
     * disconnects without releasing frees the seat rather than wedging it. Where
     * a transport cannot detect disconnect (stateless MCP), the seat's
     * per-decision timeout still passes each call, and an operator `forceRelease`
     * recovers the seat.
     * @param {string} session
     */
    disconnect: (session) => {
      if (holds(session)) {
        seat.release(holder.token);
        holder = null;
      }
    },

    /** Who holds the seat and how many wait — for an operator to see. */
    status: () => seat.status(),
  };
}
