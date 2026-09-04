import assert from "node:assert/strict";
import { test } from "node:test";

import { makeSupervisorCliOptions } from "../src/supervisorCli.js";
import { WHEN_ABSENT } from "../src/supervisor.js";

const LATE_BOUND_MODES = [
  ["MCP seat", { seatSupervisor: true }],
  ["ACP pull", { supervisorAcp: true }],
  ["ACP push", { supervisorAcpPush: true }],
];

for (const [name, mode] of LATE_BOUND_MODES) {
  test(`--require-supervisor selects deny for ${name}`, () => {
    const resolved = makeSupervisorCliOptions({ ...mode, requireSupervisor: true });

    assert.equal(resolved.whenSupervisorAbsent, WHEN_ABSENT.DENY);
    assert.equal("supervisor" in resolved, false, "late-bound modes do not create a command supervisor");
  });

  test(`${name} retains human fallback without --require-supervisor`, () => {
    const resolved = makeSupervisorCliOptions(mode);

    assert.equal(resolved.whenSupervisorAbsent, WHEN_ABSENT.HUMAN);
    assert.equal("supervisor" in resolved, false);
  });
}

test("command supervisor construction keeps the absent policy independent", () => {
  const created = [];
  const createSpawnSupervisorImpl = (config) => {
    created.push(config);
    return async () => "approve";
  };

  const strict = makeSupervisorCliOptions(
    { supervisor: "review-command", requireSupervisor: true },
    { createSpawnSupervisorImpl },
  );
  const lenient = makeSupervisorCliOptions(
    { supervisor: "review-command" },
    { createSpawnSupervisorImpl },
  );

  assert.equal(strict.whenSupervisorAbsent, WHEN_ABSENT.DENY);
  assert.equal(lenient.whenSupervisorAbsent, WHEN_ABSENT.HUMAN);
  assert.equal(typeof strict.supervisor, "function");
  assert.equal(typeof lenient.supervisor, "function");
  assert.deepEqual(created, [
    { command: "review-command", args: [] },
    { command: "review-command", args: [] },
  ]);
});

test("an absent policy is always explicit, even before any supervisor is configured", () => {
  assert.deepEqual(makeSupervisorCliOptions({}), {
    whenSupervisorAbsent: WHEN_ABSENT.HUMAN,
  });
  assert.deepEqual(makeSupervisorCliOptions({ requireSupervisor: true }), {
    whenSupervisorAbsent: WHEN_ABSENT.DENY,
  });
});
