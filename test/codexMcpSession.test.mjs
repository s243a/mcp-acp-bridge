import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { createCodexMcpSession } from "../src/codexMcpSession.js";

const fake = join(dirname(fileURLToPath(import.meta.url)), "fake-codex-mcp.mjs");
const withFake = (opts = {}) =>
  createCodexMcpSession({ command: process.execPath, args: [fake], ...opts });

test("streams deltas and routes the approval through onElicit (allow → command runs)", async () => {
  const elicited = [];
  const s = withFake({ onElicit: async (p) => (elicited.push(p), true) });
  const chunks = [];
  const out = await s.prompt("do it", { onText: (t) => chunks.push(t) });
  s.stop();
  assert.equal(elicited.length, 1, "codex's approval reached the gate");
  assert.deepEqual(elicited[0].codex_command, ["echo"], "the command text is carried to the gate");
  assert.ok(chunks.join("").startsWith("hi "), "the delta streamed to the client");
  assert.match(out.text, /APPROVED/, "an allow reply made the fake run the command");
  assert.equal(out.threadId, "T1");
});

test("a deny reply is honored (command does not run)", async () => {
  const s = withFake({ onElicit: async () => false });
  const out = await s.prompt("do it");
  s.stop();
  assert.match(out.text, /DECLINED/, "declining stops the command");
});

test("the second turn resumes the same thread via codex-reply", async () => {
  const s = withFake({ onElicit: async () => true });
  const first = await s.prompt("first");
  assert.equal(first.threadId, "T1");
  const second = await s.prompt("second");
  s.stop();
  assert.equal(second.text, "recall:T1", "codex-reply was called with the captured threadId");
});
