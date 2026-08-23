/**
 * The supervisor over MCP: adapter + tools, against a real seat.
 *
 * What matters: only an operator session claims, only the holder decides, the
 * token never leaves the process (the tools take a session, not a secret), and a
 * disconnect frees the seat. Every non-holder path yields nothing, never an
 * approval.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { createSupervisorSeat } from "../src/supervisorSeat.js";
import { createSupervisorAdapter } from "../src/supervisorAdapter.js";
import { supervisorTools } from "../src/supervisorTools.js";
import { withSupervisor, PASS, APPROVE } from "../src/supervisor.js";

const OP = "supervisor-session";
const AGENT = "agent-session";

function setup() {
  const seat = createSupervisorSeat({ timeoutMs: 5000 });
  const adapter = createSupervisorAdapter(seat, { isOperator: (s) => s === OP });
  const tools = Object.fromEntries(supervisorTools(adapter).map((t) => [t.name, t]));
  return { seat, adapter, tools };
}

test("only an operator session may claim; an agent session cannot", async () => {
  const { tools } = setup();
  assert.equal((await tools.supervisor_claim.handler({}, { sessionId: AGENT })).ok, false, "the agent is refused the seat");
  assert.equal((await tools.supervisor_claim.handler({}, { sessionId: OP })).ok, true, "the operator's session claims it");
});

test("only the holder is offered decisions and only the holder decides", async () => {
  const { seat, tools } = setup();
  await tools.supervisor_claim.handler({}, { sessionId: OP });

  const decision = seat.supervise({ tool: "run_command", args: { cmd: "ls" }, session: "SECRET" });

  // The agent sees nothing and cannot decide.
  assert.deepEqual((await tools.supervisor_pending.handler({}, { sessionId: AGENT })).pending, []);
  assert.equal((await tools.supervisor_decide.handler({ id: "1", verdict: "approve" }, { sessionId: AGENT })).ok, false);

  // The holder sees it, redacted to tool+args, and approves.
  const { pending } = await tools.supervisor_pending.handler({}, { sessionId: OP });
  assert.equal(pending.length, 1);
  assert.equal(pending[0].tool, "run_command");
  assert.ok(!("session" in pending[0]), "the seat sees tool and args, not the session internals");

  const decided = await tools.supervisor_decide.handler({ id: pending[0].id, verdict: "approve because ls reads" }, { sessionId: OP });
  assert.equal(decided.ok, true);
  assert.equal(await decision, APPROVE);
});

test("the decide tool takes a session and an id, never a token", () => {
  const [, , decide] = supervisorTools(createSupervisorAdapter(createSupervisorSeat()));
  assert.equal(decide.name, "supervisor_decide");
  assert.ok(!("token" in decide.inputSchema.properties), "the seat token never leaves the process");
  assert.deepEqual(Object.keys(decide.inputSchema.properties).sort(), ["id", "verdict"]);
});

test("the seat holds one session at a time", () => {
  const seat = createSupervisorSeat();
  const ops = new Set(["a", "b"]);
  const adapter = createSupervisorAdapter(seat, { isOperator: (s) => ops.has(s) });
  assert.equal(adapter.claim("a").ok, true);
  assert.equal(adapter.claim("b").ok, false, "one holder at a time");
  assert.equal(adapter.claim("a").ok, true, "idempotent for the current holder");
  adapter.release("a");
  assert.equal(adapter.claim("b").ok, true, "free once released");
});

test("a supervisor that disconnects frees the seat", async () => {
  const { seat, adapter } = setup();
  adapter.claim(OP);
  assert.equal(seat.status().held, true);
  adapter.disconnect(OP);
  assert.equal(seat.status().held, false, "the seat is freed on disconnect");
  assert.equal(await seat.supervise({ tool: "x" }), PASS, "and decisions fall through again");
});

test("wired through withSupervisor, a held approve allows and no seat falls to the human", async () => {
  const { seat, tools } = setup();
  const human = async () => ({ allow: false, reason: "human said no" });
  const decide = withSupervisor(seat.supervise, human, { log: () => {} });

  // No one has claimed — falls through to the human.
  assert.equal((await decide({ tool: "x" })).reason, "human said no");

  await tools.supervisor_claim.handler({}, { sessionId: OP });
  const pendingDecision = decide({ tool: "run_command", args: {} });
  const { pending } = await tools.supervisor_pending.handler({}, { sessionId: OP });
  await tools.supervisor_decide.handler({ id: pending[0].id, verdict: "approve" }, { sessionId: OP });
  assert.equal((await pendingDecision).allow, true);
});
