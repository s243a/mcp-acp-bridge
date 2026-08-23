/**
 * A supervisor decides before the human, and every uncertainty falls to the
 * human — never to allow. That last property is the whole design; most of these
 * tests are about the ways a supervisor can fail and having them all pass safe.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  APPROVE,
  createExternalSupervisor,
  createSpawnSupervisor,
  PASS,
  REJECT,
  WHEN_ABSENT,
  withSupervisor,
} from "../src/supervisor.js";

/** The human fall-through, which records whether it was reached. */
function humanStub() {
  let asked = 0;
  const decide = async () => {
    asked += 1;
    return { allow: true, reason: "the human said yes" };
  };
  return { decide, asked: () => asked };
}

test("approve and reject are final; pass reaches the human", async () => {
  const human = humanStub();
  const verdicts = new Map([
    ["read_file", APPROVE],
    ["write_file", REJECT],
    ["run_command", PASS],
  ]);
  const gate = withSupervisor((call) => Promise.resolve(verdicts.get(call.tool)), human.decide);

  const approved = await gate({ tool: "read_file", args: {} });
  assert.equal(approved.allow, true);
  assert.match(approved.reason, /supervisor/);

  const rejected = await gate({ tool: "write_file", args: {} });
  assert.equal(rejected.allow, false);
  assert.match(rejected.reason, /denied-by-policy/, "a supervisor's no is a policy no, not a person's");

  const passed = await gate({ tool: "run_command", args: {} });
  assert.equal(passed.allow, true);
  assert.equal(human.asked(), 1, "only the passed one reached the human");
});

test("every uncertainty passes to the human, never to allow", async () => {
  const human = humanStub();

  // A supervisor that throws, one that returns junk, one that returns nothing.
  for (const supervise of [
    () => Promise.reject(new Error("model down")),
    () => Promise.resolve("maybe?"),
    () => Promise.resolve(""),
    () => Promise.resolve(undefined),
  ]) {
    const before = human.asked();
    const gate = withSupervisor(supervise, human.decide);
    const result = await gate({ tool: "run_command", args: { command: "rm -rf /" } });
    assert.equal(result.allow, true, "the human allowed it — the supervisor did not");
    assert.equal(human.asked(), before + 1, "and the human was the one asked");
  }
});

test("a spawned supervisor reads the call and returns a verdict", async () => {
  // A shell one-liner standing in for a real reviewer: approve reads, else pass.
  const supervise = createSpawnSupervisor({
    command: "sh",
    args: ["-c", 'read line; case "$line" in *read_file*) echo approve;; *) echo pass;; esac'],
    timeoutMs: 3000,
  });
  const human = humanStub();
  const gate = withSupervisor(supervise, human.decide);

  const read = await gate({ tool: "read_file", args: { path: "notes.md" } });
  assert.equal(read.allow, true);

  await gate({ tool: "run_command", args: { command: "ls" } });
  assert.equal(human.asked(), 1, "what it did not approve fell through");
});

test("a spawned supervisor that hangs passes to the human rather than stalling", async () => {
  const supervise = createSpawnSupervisor({
    command: "sh",
    args: ["-c", "sleep 30"],
    timeoutMs: 150,
  });
  const human = humanStub();
  const gate = withSupervisor(supervise, human.decide);

  const started = Date.now();
  const result = await gate({ tool: "run_command", args: {} });
  assert.ok(Date.now() - started < 3000, "it did not wait for the sleep");
  assert.equal(result.allow, true);
  assert.equal(human.asked(), 1, "a slow supervisor becomes the human, not a deny");
});

test("an external supervisor passes until something binds, then defers to it", async () => {
  const external = createExternalSupervisor({ timeoutMs: 200 });
  const human = humanStub();
  const gate = withSupervisor(external.supervise, human.decide);

  // Nobody bound: the human decides.
  await gate({ tool: "read_file", args: {} });
  assert.equal(human.asked(), 1);

  // An MCP/ACP client becomes the decider.
  external.bind(async (call) => (call.tool === "read_file" ? APPROVE : REJECT));
  const approved = await gate({ tool: "read_file", args: {} });
  assert.equal(approved.allow, true);
  const rejected = await gate({ tool: "write_file", args: {} });
  assert.equal(rejected.allow, false);
  assert.equal(human.asked(), 1, "the bound supervisor answered both");

  // A bound supervisor that hangs still falls to the human.
  external.bind(() => new Promise(() => {}));
  await gate({ tool: "run_command", args: {} });
  assert.equal(human.asked(), 2, "a wedged external supervisor times out to the human");
});

test("when-absent is configurable: human by default, deny on request", async () => {
  const human = humanStub();

  // A supervisor that only ever abstains (throws), under both postures.
  const abstain = () => Promise.reject(new Error("down"));

  const lenient = withSupervisor(abstain, human.decide, { whenAbsent: WHEN_ABSENT.HUMAN });
  const passed = await lenient({ tool: "run_command", args: {} });
  assert.equal(passed.allow, true, "human decides when the supervisor is absent");
  assert.equal(human.asked(), 1);

  const strict = withSupervisor(abstain, human.decide, { whenAbsent: WHEN_ABSENT.DENY });
  const denied = await strict({ tool: "run_command", args: {} });
  assert.equal(denied.allow, false, "nothing runs unwatched");
  assert.match(denied.reason, /no supervisor available/);
  assert.equal(human.asked(), 1, "and the human was not troubled");
});

test("require-supervisor never turns an approval or a deliberate reject into the wrong thing", async () => {
  const human = humanStub();

  // A present supervisor whose verdict is real must be honoured regardless of
  // the absent-policy — deny-on-absent applies only to abstention.
  const approver = withSupervisor(() => Promise.resolve(APPROVE), human.decide, { whenAbsent: WHEN_ABSENT.DENY });
  assert.equal((await approver({ tool: "read_file", args: {} })).allow, true, "a real approve still approves");

  const rejecter = withSupervisor(() => Promise.resolve(REJECT), human.decide, { whenAbsent: WHEN_ABSENT.DENY });
  const r = await rejecter({ tool: "write_file", args: {} });
  assert.equal(r.allow, false);
  assert.match(r.reason, /supervisor rejected/, "a real reject is the supervisor's, not the absent-policy's");
});

test("a verdict word must be exact, not a prefix", async () => {
  const human = humanStub();
  // These start with "approve"/"reject" but are not them. A prefix match failed
  // OPEN for approve, which is the one direction that must never happen.
  const g = (verdict) => withSupervisor(() => Promise.resolve(verdict), human.decide);
  assert.equal((await g("approveNOT")({ tool: "x" })).allow, true, "not an approve -> human allowed it, not the supervisor");
  assert.equal(human.asked() > 0, true);
  // And a real approve with a trailing reason still approves.
  assert.equal((await g("approve because it only reads")({ tool: "x" })).allow, true);
});

test("releasing or replacing the seat revokes a decision still in flight", async () => {
  const external = createExternalSupervisor({ timeoutMs: 5000 });
  const human = humanStub();
  const gate = withSupervisor(external.supervise, human.decide);

  // Bind a handler we hold open, start a decision, then release the seat and let
  // the released handler answer late.
  let answer;
  external.bind(() => new Promise((resolve) => (answer = resolve)));
  const inFlight = gate({ tool: "run_command", args: {} });
  external.unbind();
  answer(APPROVE); // the released seat tries to approve
  const result = await inFlight;
  assert.equal(result.allow, true, "the human decided, since the supervisor was revoked");
  assert.equal(human.asked(), 1, "and it fell to the human, not to the stale approve");

  // Rebinding also invalidates a decision that began under the old seat.
  let answer2;
  external.bind(() => new Promise((resolve) => (answer2 = resolve)));
  const second = gate({ tool: "write_file", args: {} });
  external.bind(async () => REJECT); // a new seat-holder replaces the first
  answer2(APPROVE); // the first, now-replaced handler answers
  const r2 = await second;
  assert.equal(r2.allow, true, "the replaced handler's approve was discarded; the human decided");
  assert.equal(human.asked(), 2);
});

test("an unknown whenAbsent is refused at construction", () => {
  assert.throws(() => withSupervisor(async () => "pass", async () => ({ allow: true }), { whenAbsent: "denny" }), /unknown whenAbsent/);
  assert.doesNotThrow(() => withSupervisor(async () => "pass", async () => ({ allow: true }), { whenAbsent: WHEN_ABSENT.DENY }));
});
