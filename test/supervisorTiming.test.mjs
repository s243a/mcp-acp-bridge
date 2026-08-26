import { test } from "node:test";
import assert from "node:assert/strict";

import { sampleDelay, withResponseTiming, parseTimingProfile, DISTRIBUTIONS } from "../src/supervisorTiming.js";

test("parseTimingProfile validates and normalises", () => {
  assert.deepEqual(parseTimingProfile('{"min":100,"max":500}').dist, "uniform");
  assert.equal(parseTimingProfile({ min: 0, max: 0 }).max, 0);
  assert.throws(() => parseTimingProfile({ min: -1, max: 10 }), /non-negative/);
  assert.throws(() => parseTimingProfile({ min: 100, max: 10 }), /max must be >= min/);
  assert.throws(() => parseTimingProfile({ min: 0, max: 10, dist: "weibull" }), /dist must be one of/);
});

test("every distribution samples within [min, max]", () => {
  for (const dist of DISTRIBUTIONS) {
    const profile = parseTimingProfile({ min: 200, max: 2000, dist });
    for (let i = 0; i < 3000; i++) {
      const d = sampleDelay(profile);
      assert.ok(d >= 200 && d <= 2000, `${dist} produced ${d} outside [200,2000]`);
      assert.ok(Number.isInteger(d), `${dist} produced non-integer ${d}`);
    }
  }
});

test("uniform min==max is a fixed delay", () => {
  const profile = parseTimingProfile({ min: 750, max: 750 });
  for (let i = 0; i < 50; i++) assert.equal(sampleDelay(profile), 750);
});

test("withResponseTiming holds the verdict to the sampled target, and preserves it", async () => {
  const slept = [];
  const paced = withResponseTiming(async () => "reject", parseTimingProfile({ min: 500, max: 500 }), {
    sleep: async (ms) => void slept.push(ms),
  });
  const verdict = await paced({ tool: "Bash" });
  assert.equal(verdict, "reject", "the verdict is unchanged by pacing");
  assert.equal(slept.length, 1, "it waited once");
  assert.ok(slept[0] > 400 && slept[0] <= 500, `waited ~500ms, got ${slept[0]}`);
});

test("withResponseTiming does not delay when the supervisor was already slower than the target", async () => {
  const slept = [];
  // target 20ms, but the supervisor takes ~60ms — no extra sleep should be added.
  const paced = withResponseTiming(
    async () => {
      await new Promise((r) => setTimeout(r, 200));
      return "approve";
    },
    parseTimingProfile({ min: 5, max: 5 }),
    { sleep: async (ms) => void slept.push(ms) },
  );
  const verdict = await paced({ tool: "Read" });
  assert.equal(verdict, "approve");
  assert.equal(slept.length, 0, "no pacing sleep when the decision already outlasted the target");
});

test("parseTimingProfile validates distribution params and caps max (B1/B2)", () => {
  assert.throws(() => parseTimingProfile({ min: 0, max: 100, dist: "normal", sdMs: "abc" }), /sdMs must be a number/);
  assert.throws(() => parseTimingProfile({ min: 0, max: 100, dist: "gamma", shape: 0 }), /shape must be a number/);
  assert.throws(() => parseTimingProfile({ min: 0, max: 100, dist: "poisson", lambda: Infinity }), /lambda must be a number/);
  assert.throws(() => parseTimingProfile({ min: 0, max: 5_000_000 }), /max must be <=/);
  // unknown keys are dropped; vetted numbers survive
  const clean = parseTimingProfile({ min: 10, max: 20, dist: "gamma", shape: 2, bogus: "x" });
  assert.equal(clean.shape, 2);
  assert.equal(clean.bogus, undefined);
});
