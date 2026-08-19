/**
 * Does cancelling a turn lose the conversation?
 *
 * SIGINT ends agy outright rather than interrupting a turn, so stopping means
 * killing the process. What must survive is the *conversation*: the user asked
 * to stop this turn, not to forget everything said before it.
 *
 *   node test/live-agy-cancel.mjs
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { startBridge } from "../src/bridge.js";
import { createPeer } from "../src/jsonRpc.js";

const workspace = mkdtempSync(join(tmpdir(), "agy-cancel-"));
const toBridge = new PassThrough();
const toClient = new PassThrough();

let starts = 0;
let resumes = 0;
const bridge = await startBridge({
  agent: process.env.BRIDGE_TEST_AGENT ?? "agy",
  cwd: workspace,
  input: toBridge,
  output: toClient,
  log: (m) => {
    if (m.includes("starting persistent")) starts += 1;
    if (m.includes("resuming conversation")) resumes += 1;
    console.log(m);
  },
});

const client = createPeer({ input: toClient, output: toBridge });
let text = [];
client.on("session/update", ({ update }) => {
  if (update.sessionUpdate === "agent_message_chunk") text.push(update.content.text);
});

await client.request("initialize", { protocolVersion: 1 });
const { sessionId } = await client.request("session/new", { cwd: workspace });

const ask = async (prompt) => {
  text = [];
  const result = await client.request("session/prompt", {
    sessionId,
    prompt: [{ type: "text", text: prompt }],
  });
  return { text: text.join("").trim(), stopReason: result.stopReason };
};

// 1. Establish something only this conversation knows.
const first = await ask("Remember this codeword: RHINOCEROS. Reply with exactly: STORED");
console.log(`\n[turn 1] ${first.text.slice(0, 60)}`);

// 2. Start a long turn and cancel it part-way.
const longTurn = client.request("session/prompt", {
  sessionId,
  prompt: [{ type: "text", text: "Write a detailed 3000-word essay on the history of computing, covering each decade from 1940 to 2020 in depth." }],
});
await new Promise((r) => setTimeout(r, 4000));
console.log("\n[test] cancelling mid-turn");
client.notify("session/cancel", { sessionId });
const cancelled = await longTurn;
console.log(`[turn 2] stopReason: ${cancelled.stopReason}`);

// 3. The conversation should still remember turn 1.
const third = await ask("What codeword did I ask you to remember? Reply with just the word.");
console.log(`[turn 3] ${third.text.slice(0, 60)}`);

await bridge.close();

console.log("\n--- result ---");
console.log(`cancelled turn stopReason: ${cancelled.stopReason}`);
console.log(`process starts: ${starts}, resumes: ${resumes}`);
console.log(`conversation survived: ${/rhinoceros/i.test(third.text)}`);

if (cancelled.stopReason !== "cancelled") {
  console.error(`FAIL: expected stopReason "cancelled", got "${cancelled.stopReason}"`);
  process.exit(1);
}
if (resumes < 1) {
  console.error("FAIL: the next turn did not resume the conversation");
  process.exit(1);
}
if (!/rhinoceros/i.test(third.text)) {
  console.error("FAIL: cancelling lost the conversation");
  process.exit(1);
}
console.log("PASS — the turn stopped, the conversation did not");
process.exit(0);
