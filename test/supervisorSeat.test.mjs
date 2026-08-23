/**
 * The supervisor seat and its queue.
 *
 * The tests that matter are the fail-safe ones: no seat, a released seat, a
 * timeout, a full queue, a stale token — every one must resolve a decision to
 * PASS, never to approve. Only a live holder's explicit `approve` approves.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { createSupervisorSeat } from "../src/supervisorSeat.js";
import { withSupervisor, PASS, APPROVE, REJECT } from "../src/supervisor.js";

test("with no one in the seat, a decision passes to the human", async () => {
  const seat = createSupervisorSeat();
  assert.equal(await seat.supervise({ tool: "run_command" }), PASS);
  assert.deepEqual(seat.status(), { held: false, pending: 0 });
});

test("claiming needs operator authority, and the seat holds one at a time", () => {
  const seat = createSupervisorSeat({ now: () => 1000 });
  assert.equal(seat.claim({ by: "anon" }).ok, false, "no operator credential is refused");

  const first = seat.claim({ by: "boss", operator: true });
  assert.equal(first.ok, true);
  assert.deepEqual(seat.status(), { held: true, by: "boss", since: 1000, pending: 0 });

  const second = seat.claim({ by: "other", operator: true });
  assert.equal(second.ok, false, "a second claim is refused while the seat is held");
});

test("a held seat is offered the decision and its approve approves", async () => {
  const seat = createSupervisorSeat({ timeoutMs: 5000 });
  const { token } = seat.claim({ by: "boss", operator: true });

  const decision = seat.supervise({ tool: "run_command", args: { cmd: "ls" }, session: "SECRET" });
  const offered = seat.pending(token);
  assert.equal(offered.length, 1);
  assert.equal(offered[0].tool, "run_command");
  assert.deepEqual(offered[0].args, { cmd: "ls" });
  assert.ok(!("session" in offered[0]), "the seat sees tool and args, not the session internals");

  assert.equal(seat.decide(token, offered[0].id, "approve because ls only reads"), true);
  assert.equal(await decision, APPROVE);
  seat.release(token);
});

test("a holder's reject rejects", async () => {
  const seat = createSupervisorSeat({ timeoutMs: 5000 });
  const { token } = seat.claim({ by: "boss", operator: true });
  const decision = seat.supervise({ tool: "run_command" });
  const [offered] = seat.pending(token);
  seat.decide(token, offered.id, "reject");
  assert.equal(await decision, REJECT);
  seat.release(token);
});

test("a decision nobody answers times out to PASS", async () => {
  const seat = createSupervisorSeat({ timeoutMs: 15 });
  seat.claim({ by: "boss", operator: true });
  assert.equal(await seat.supervise({ tool: "run_command" }), PASS);
});

test("releasing the seat voids everything pending, to PASS", async () => {
  const seat = createSupervisorSeat({ timeoutMs: 60_000 });
  const { token } = seat.claim({ by: "boss", operator: true });
  const decision = seat.supervise({ tool: "run_command" });
  assert.equal(seat.release(token), true);
  assert.equal(await decision, PASS, "the departing holder's silence is a pass, not a verdict");
  assert.deepEqual(seat.status(), { held: false, pending: 0 });
});

test("a verdict from a stale token is ignored, and the decision still passes", async () => {
  const seat = createSupervisorSeat({ timeoutMs: 20 });
  const { token } = seat.claim({ by: "boss", operator: true });
  const decision = seat.supervise({ tool: "run_command" });
  const [offered] = seat.pending(token);

  assert.equal(seat.decide(token + 999, offered.id, "approve"), false, "a foreign token cannot decide");
  assert.deepEqual(seat.pending(token + 999), [], "nor read the queue");
  assert.equal(await decision, PASS, "so the decision times out to pass, never approved by the wrong hand");
});

test("a full queue passes rather than growing without bound", async () => {
  const seat = createSupervisorSeat({ timeoutMs: 60_000, maxPending: 2 });
  const { token } = seat.claim({ by: "boss", operator: true });
  seat.supervise({ tool: "a" });
  seat.supervise({ tool: "b" });
  assert.equal(await seat.supervise({ tool: "c" }), PASS, "past the cap, a decision passes to the human");
  assert.equal(seat.status().pending, 2, "the queue did not grow past its bound");
  seat.release(token);
});

test("it drops into withSupervisor: no seat falls to the human, approve allows", async () => {
  const seat = createSupervisorSeat({ timeoutMs: 5000 });
  const human = async () => ({ allow: false, reason: "human said no" });
  const decide = withSupervisor(seat.supervise, human, { log: () => {} });

  // Nobody in the seat — the wrapper falls through to the human decider.
  assert.equal((await decide({ tool: "x" })).reason, "human said no");

  // Held, and approved — the wrapper allows.
  const { token } = seat.claim({ by: "boss", operator: true });
  const pending = decide({ tool: "run_command", args: {} });
  const [offered] = seat.pending(token);
  seat.decide(token, offered.id, "approve");
  assert.equal((await pending).allow, true);
  seat.release(token);
});

test("the seat token is an unguessable string, not the generation counter", () => {
  const seat = createSupervisorSeat();
  const first = seat.claim({ by: "boss", operator: true });
  assert.equal(typeof first.token, "string");
  assert.ok(first.token.length >= 32, "a 128-bit token, not a one-digit integer");
  assert.notEqual(first.token, "1", "not the sequential generation a non-holder could guess");
  // A different holder after release gets a different token.
  seat.release(first.token);
  const second = seat.claim({ by: "boss", operator: true });
  assert.notEqual(second.token, first.token, "each claim mints a fresh token");
});

test("forceRelease frees a seat whose holder crashed without releasing", async () => {
  const seat = createSupervisorSeat({ timeoutMs: 60_000 });
  seat.claim({ by: "gone", operator: true });
  const decision = seat.supervise({ tool: "run_command" });

  assert.equal(seat.forceRelease({}), false, "no operator credential — refused, like claim");
  assert.equal(seat.forceRelease({ operator: true }), true, "the wedged seat is freed with no token");
  assert.equal(await decision, PASS, "and its pending decision voids to pass, not a verdict");
  assert.equal(seat.status().held, false, "the seat is open again");

  const reclaimed = seat.claim({ by: "new", operator: true });
  assert.equal(reclaimed.ok, true, "a new supervisor can take it");
  seat.release(reclaimed.token);
});
