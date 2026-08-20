/**
 * The task channel: a turn handed over as an MCP call and answered by one.
 *
 * The case worth pinning is the empty answer. It completes the turn while
 * leaving nothing to render, which reaches the user as silence — the hardest
 * failure to tell apart from a broken bridge.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { createTaskChannel } from "../src/taskChannel.js";

test("an empty result is queried once, then accepted and flagged", async () => {
  const channel = createTaskChannel({ log: () => {} });
  const turn = channel.runTurn("s1", "Say hello");
  const [, submitTool] = channel.toolDefinitions();

  await channel.toolDefinitions()[0].handler({}, { sessionId: "s1" });

  // Silence would complete the turn with nothing to show, so ask again first.
  const first = await submitTool.handler({ result: "   " }, { sessionId: "s1" });
  assert.match(first, /empty/i);
  assert.equal(channel.hasPending("s1"), true, "the turn must stay open to be answered");

  // A second blank answer ends the turn rather than hanging on it.
  await submitTool.handler({ result: "" }, { sessionId: "s1" });
  const outcome = await turn;
  assert.equal(outcome.empty, true, "the caller has to know there was nothing to show");
});

test("an answer given after the query is the one reported", async () => {
  const channel = createTaskChannel({ log: () => {} });
  const turn = channel.runTurn("s2", "Say hello");
  const [takeTool, submitTool] = channel.toolDefinitions();

  await takeTool.handler({}, { sessionId: "s2" });
  await submitTool.handler({ result: "" }, { sessionId: "s2" });
  await submitTool.handler({ result: "Hello" }, { sessionId: "s2" });

  const outcome = await turn;
  assert.equal(outcome.text, "Hello");
  assert.notEqual(outcome.empty, true);
});
