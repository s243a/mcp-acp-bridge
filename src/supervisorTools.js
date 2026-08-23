/**
 * The MCP surface of the supervisor seat.
 *
 * Four tools a connected client calls to supervise: claim the seat, read the
 * decisions waiting for it, decide one, release. They are thin over
 * `supervisorAdapter`, which is where the seat-binding and the fail-closed rules
 * live; each handler passes the MCP session it arrived on so the adapter can
 * tell the seat-holder from anyone else.
 *
 * The pull shape is deliberate and is why these are tools rather than a push:
 * MCP is request/response, so a supervisor polls `supervisor_pending` and posts
 * `supervisor_decide`, exactly the model the seat's queue implements.
 *
 * These are registered on the same gateway the agent uses, so the agent can see
 * them — but every one is gated by the adapter: `claim` needs operator authority
 * the agent's session does not have, and `decide` acts only for the seat-holder,
 * which the agent never becomes. Calling them gains the agent nothing. (Hiding
 * them from a non-operator session is a per-session tool filter the gateway does
 * not yet have; noted, not required for safety.)
 *
 * Each carries `bypassGate: true`, so the gateway does not run the permission
 * gate on them. It must not: in seat mode the gate's ask-path *is* the seat, so
 * a `supervisor_decide` put through the gate would be queued as another decision
 * for the supervisor to answer — a reviewing-the-reviewer spiral. The reviewer's
 * own console is not a reviewed action, the same reason the transport tools that
 * carry the turn are not reviewed.
 *
 * @module supervisorTools
 */

/**
 * @param {ReturnType<import("./supervisorAdapter.js").createSupervisorAdapter>} adapter
 * @returns {Array<{name: string, description: string, inputSchema: object, handler: (args: any, ctx: {sessionId: string}) => Promise<unknown>}>}
 */
export function supervisorTools(adapter) {
  return [
    {
      name: "supervisor_claim",
      bypassGate: true,
      description:
        "Claim the supervisor seat, so pending permission decisions are offered to you. Requires operator authority; one holder at a time.",
      inputSchema: { type: "object", properties: {} },
      handler: async (_args, { sessionId }) => adapter.claim(sessionId),
    },
    {
      name: "supervisor_pending",
      bypassGate: true,
      description:
        "List the permission decisions waiting for the supervisor seat you hold. Each has an id, the tool, and its arguments.",
      inputSchema: { type: "object", properties: {} },
      handler: async (_args, { sessionId }) => ({ pending: adapter.pending(sessionId) }),
    },
    {
      name: "supervisor_decide",
      bypassGate: true,
      description:
        "Answer one pending decision by id: 'approve' allows it, 'reject' denies by policy, anything else passes it to the human.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "the pending decision's id, from supervisor_pending" },
          verdict: { type: "string", description: "'approve', 'reject', or 'pass'" },
        },
        required: ["id", "verdict"],
      },
      handler: async (args, { sessionId }) => adapter.decide(sessionId, String(args?.id ?? ""), String(args?.verdict ?? "")),
    },
    {
      name: "supervisor_release",
      bypassGate: true,
      description: "Give up the supervisor seat, so decisions fall through to the human again.",
      inputSchema: { type: "object", properties: {} },
      handler: async (_args, { sessionId }) => adapter.release(sessionId),
    },
    {
      name: "supervisor_force_release",
      bypassGate: true,
      description:
        "Force the supervisor seat open when its holder vanished without releasing. Any operator may — the holder need not be you.",
      inputSchema: { type: "object", properties: {} },
      handler: async (_args, { sessionId }) => adapter.forceRelease(sessionId),
    },
  ];
}
