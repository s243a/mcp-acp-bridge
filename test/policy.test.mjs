/**
 * Permission policy.
 *
 * The load-bearing property is that nothing unclassified gets through. Every
 * way a policy can be wrong — unknown preset, bad verdict, malformed rule,
 * missing config — must land on "ask", never on "allow".
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { makePolicy, PRESETS, withPolicy } from "../src/policy.js";

const call = (tool) => ({ sessionId: "s", tool, args: {} });

test("review-everything asks about everything, reads included", () => {
  const policy = makePolicy("review-everything");
  assert.equal(policy.decide(call("view_file")).verdict, "ask");
  assert.equal(policy.decide(call("run_command")).verdict, "ask");
});

test("review-consequential lets reads through and stops the rest", () => {
  const policy = makePolicy("review-consequential");
  assert.equal(policy.decide(call("view_file")).verdict, "allow");
  assert.equal(policy.decide(call("grep")).verdict, "allow");
  assert.equal(policy.decide(call("run_command")).verdict, "ask");
  assert.equal(policy.decide(call("write_to_file")).verdict, "ask");
});

test("a trailing star matches a family of tools", () => {
  const policy = makePolicy({ rules: [{ tools: ["browser_*"], action: "deny" }], default: "ask" });
  assert.equal(policy.decide(call("browser_click_element")).verdict, "deny");
  assert.equal(policy.decide(call("view_file")).verdict, "ask");
});

test("the first matching rule wins", () => {
  const policy = makePolicy({
    rules: [
      { tools: ["view_file"], action: "deny" },
      { tools: ["*"], action: "allow" },
    ],
    default: "ask",
  });
  assert.equal(policy.decide(call("view_file")).verdict, "deny");
  assert.equal(policy.decide(call("anything_else")).verdict, "allow");
});

test("an unknown preset falls back to asking, not to allowing", () => {
  const policy = makePolicy("no-such-preset");
  assert.equal(policy.decide(call("run_command")).verdict, "ask");
});

test("an invalid default falls back to asking", () => {
  const policy = makePolicy({ rules: [], default: "yes-please" });
  assert.equal(policy.decide(call("run_command")).verdict, "ask");
});

test("rules with an unrecognised action are skipped, not honoured", () => {
  const policy = makePolicy({ rules: [{ tools: ["*"], action: "maybe" }], default: "ask" });
  assert.equal(policy.decide(call("run_command")).verdict, "ask");
});

test("no configuration at all means ask", () => {
  assert.equal(makePolicy().decide(call("run_command")).verdict, "ask");
  assert.equal(makePolicy(null).decide(call("x")).verdict, "ask");
});

test("allow-all is available but must be chosen explicitly", () => {
  assert.equal(PRESETS["allow-all"].default, "allow");
  assert.equal(makePolicy("allow-all").decide(call("run_command")).verdict, "allow");
});

test("withPolicy answers allow and deny without troubling the human", async () => {
  let asked = 0;
  const decide = async () => {
    asked += 1;
    return { allow: true };
  };
  const gated = withPolicy(makePolicy("review-consequential"), decide);

  assert.equal((await gated(call("view_file"))).allow, true);
  assert.equal(asked, 0, "an allowed read must not raise a prompt");

  await gated(call("run_command"));
  assert.equal(asked, 1, "anything consequential must reach the decider");
});

test("withPolicy denies without asking, and the reason survives", async () => {
  const gated = withPolicy(
    makePolicy({ rules: [{ tools: ["rm_rf"], action: "deny", reason: "never" }], default: "ask" }),
    async () => ({ allow: true }),
  );
  const decision = await gated(call("rm_rf"));
  assert.equal(decision.allow, false);
  assert.equal(decision.reason, "never");
});
