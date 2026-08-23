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
 * them — but every one is gated: `claim` needs operator authority the agent's
 * session does not have, and `decide` acts only for the seat-holder, which the
 * agent never becomes. Calling them gains the agent nothing. (Hiding them from a
 * non-operator session is a per-session tool filter the gateway does not yet
 * have; noted, not required for safety.)
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
      description:
        "Claim the supervisor seat, so pending permission decisions are offered to you. Requires operator authority; one holder at a time.",
      inputSchema: { type: "object", properties: {} },
      handler: async (_args, { sessionId }) => adapter.claim(sessionId),
    },
    {
      name: "supervisor_pending",
      description:
        "List the permission decisions waiting for the supervisor seat you hold. Each has an id, the tool, and its arguments.",
      inputSchema: { type: "object", properties: {} },
      handler: async (_args, { sessionId }) => ({ pending: adapter.pending(sessionId) }),
    },
    {
      name: "supervisor_decide",
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
      description: "Give up the supervisor seat, so decisions fall through to the human again.",
      inputSchema: { type: "object", properties: {} },
      handler: async (_args, { sessionId }) => adapter.release(sessionId),
    },
  ];
}
