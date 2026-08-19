/**
 * agy stream-json translation.
 *
 * Fixtures are real lines captured from agy 1.1.13. The rule under test is that
 * anything not understood becomes null rather than a guess — a client showing
 * invented tool activity is worse than one showing none.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { getAdapter, parseAgyLine } from "../src/agents.js";

test("assistant text becomes a text record", () => {
  const record = parseAgyLine(
    JSON.stringify({
      event: "step_update",
      step_update: { step_index: 2, state: "DONE", step_type: "agent_response", text_delta: "banana\n" },
    }),
  );
  assert.deepEqual(record, { kind: "text", text: "banana\n" });
});

test("an agent_response carrying only usage is not a text event", () => {
  const record = parseAgyLine(
    JSON.stringify({
      event: "step_update",
      step_update: { step_index: 2, state: "DONE", step_type: "agent_response", usage: { total_tokens: 5 } },
    }),
  );
  assert.equal(record, null);
});

test("a tool step carries its name, arguments and status", () => {
  const record = parseAgyLine(
    JSON.stringify({
      event: "step_update",
      step_update: {
        step_index: 3,
        state: "ACTIVE",
        step_type: "tool",
        tool_name: "write_to_file",
        tool_info: { name: "write_to_file", parameters: { TargetFile: "/tmp/x/hello.txt" } },
      },
    }),
  );
  assert.equal(record.kind, "tool");
  assert.equal(record.name, "write_to_file");
  assert.equal(record.status, "in_progress");
  assert.deepEqual(record.args, { TargetFile: "/tmp/x/hello.txt" });
});

test("the ACTIVE and DONE halves of one call share an id", () => {
  const line = (state) =>
    JSON.stringify({
      event: "step_update",
      step_update: { step_index: 3, state, step_type: "tool", tool_name: "write_to_file" },
    });
  const active = parseAgyLine(line("ACTIVE"));
  const done = parseAgyLine(line("DONE"));
  assert.equal(active.id, done.id, "a client must be able to update the same call");
  assert.equal(done.status, "completed");
});

test("the result reports success and keeps the agent's own status", () => {
  const record = parseAgyLine(
    JSON.stringify({
      event: "result",
      result: { status: "SUCCESS", response: "done\n", usage: { total_tokens: 10 } },
    }),
  );
  assert.equal(record.kind, "result");
  assert.equal(record.ok, true);
  assert.equal(record.text, "done\n");
  assert.equal(record.agentStatus, "SUCCESS");
});

test("the agent's status is never presented as an ACP stop reason", () => {
  // ACP accepts only these; forwarding "success" leaves a validating client
  // waiting forever on a prompt that already finished.
  const ACP_STOP_REASONS = new Set([
    "end_turn",
    "cancelled",
    "max_tokens",
    "max_turn_requests",
    "refusal",
  ]);
  for (const status of ["SUCCESS", "ERROR", "CANCELLED"]) {
    const record = parseAgyLine(
      JSON.stringify({ event: "result", result: { status, response: "" } }),
    );
    assert.equal(record.stopReason, undefined, "must not claim an ACP stop reason");
    assert.equal(ACP_STOP_REASONS.has(record.agentStatus), false);
  }
});

test("a non-success result is not reported as ok", () => {
  const record = parseAgyLine(
    JSON.stringify({ event: "result", result: { status: "ERROR", response: "" } }),
  );
  assert.equal(record.ok, false);
});

test("unparseable and unknown lines are dropped, never guessed at", () => {
  assert.equal(parseAgyLine("not json"), null);
  assert.equal(parseAgyLine(JSON.stringify({ event: "something_new" })), null);
  assert.equal(
    parseAgyLine(JSON.stringify({ event: "step_update", step_update: { step_type: "checkpoint" } })),
    null,
  );
});

test("an initial prompt rides in argv so the first turn is never typed", () => {
  const dual = getAdapter("agy-dual");
  assert.deepEqual(dual.buildSessionArgs({ cwd: "/w" }), ["--add-dir", "/w"]);
  assert.deepEqual(
    dual.buildSessionArgs({ cwd: "/w", initialPrompt: "go" }),
    ["--add-dir", "/w", "-i", "go"],
    "-i runs the prompt and keeps the session interactive",
  );
});
