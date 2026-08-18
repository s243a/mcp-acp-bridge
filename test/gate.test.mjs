/**
 * The gate must fail closed. Every test here is a way the gate could wrongly
 * open; none of them may return `allow: true`.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { DenyReason, makeGate } from "../src/gate.js";

test("allows when the decider allows", async () => {
  const gate = makeGate(async () => ({ allow: true }));
  assert.equal((await gate(call())).allow, true);
});

test("denies when the decider denies", async () => {
  const gate = makeGate(async () => ({ allow: false, reason: "nope" }));
  const decision = await gate(call());
  assert.equal(decision.allow, false);
  assert.equal(decision.reason, "nope");
});

test("denies when no decision arrives before the timeout", async () => {
  const gate = makeGate(() => new Promise(() => {}), { timeoutMs: 20 });
  const decision = await gate(call());
  assert.equal(decision.allow, false);
  assert.equal(decision.reason, DenyReason.TIMEOUT);
});

test("denies when the decider throws", async () => {
  const gate = makeGate(async () => {
    throw new Error("client exploded");
  });
  const decision = await gate(call());
  assert.equal(decision.allow, false);
  assert.match(decision.reason, /decider-failed/);
});

test("denies when the decider returns nothing", async () => {
  const gate = makeGate(async () => undefined);
  assert.equal((await gate(call())).allow, false);
});

test("denies on a truthy non-true allow — no coercion", async () => {
  // `allow: "yes"` must not be read as approval.
  const gate = makeGate(async () => ({ allow: "yes" }));
  assert.equal((await gate(call())).allow, false);
});

test("reports every decision to the observer", async () => {
  const seen = [];
  const gate = makeGate(async () => ({ allow: false, reason: "r" }), {
    onDecision: (d) => seen.push(d),
  });
  await gate(call());
  assert.equal(seen.length, 1);
  assert.equal(seen[0].tool, "t");
  assert.equal(seen[0].allow, false);
});

function call(overrides = {}) {
  return { sessionId: "s", tool: "t", args: {}, ...overrides };
}
