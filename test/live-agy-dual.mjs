/**
 * Live check for the terminal-driven profile.
 *
 * Three things only a PTY can do, and one it does worse:
 *   - a turn completes and its answer is recovered from the screen;
 *   - context carries across turns in one live session;
 *   - ESC cancels a turn without ending the session.
 *
 *   node test/live-agy-dual.mjs
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { startBridge } from "../src/bridge.js";
import { createPeer } from "../src/jsonRpc.js";

const workspace = mkdtempSync(join(tmpdir(), "agy-dual-"));
const toBridge = new PassThrough();
const toClient = new PassThrough();

let starts = 0;
const bridge = await startBridge({
  agent: "agy-dual",
  cwd: workspace,
  input: toBridge,
  output: toClient,
  log: (m) => {
    if (m.includes("[pty] starting")) starts += 1;
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
console.log(`[test] workspace ${workspace}\n`);

const ask = async (prompt) => {
  text = [];
  const started = Date.now();
  const result = await client.request("session/prompt", {
    sessionId,
    prompt: [{ type: "text", text: prompt }],
  });
  return { text: text.join("").trim(), ms: Date.now() - started, stopReason: result.stopReason };
};

const first = await ask("Remember the codeword OCELOT. Reply with exactly: STORED");
console.log(`\n[turn 1] ${first.ms}ms — ${JSON.stringify(first.text.slice(0, 120))}`);

const second = await ask("What codeword did I ask you to remember? Reply with just the word.");
console.log(`[turn 2] ${second.ms}ms — ${JSON.stringify(second.text.slice(0, 120))}`);

// ESC should stop the turn without ending the session.
const longTurn = client.request("session/prompt", {
  sessionId,
  prompt: [{ type: "text", text: "Write a detailed 3000-word essay on the history of computing." }],
});
await new Promise((r) => setTimeout(r, 6000));
console.log("\n[test] cancelling with ESC");
client.notify("session/cancel", { sessionId });
const cancelled = await longTurn.catch((e) => ({ stopReason: `error: ${e.message}` }));
console.log(`[turn 3] stopReason: ${cancelled.stopReason}`);

await new Promise((r) => setTimeout(r, 4000));
const fourth = await ask("Reply with exactly: STILL_HERE");
console.log(`[turn 4] ${JSON.stringify(fourth.text.slice(0, 80))}`);

await bridge.close();

console.log("\n--- result ---");
console.log(`pty starts (want 1): ${starts}`);
console.log(`context carried:     ${/ocelot/i.test(second.text)}`);
console.log(`survived cancel:     ${/still_here/i.test(fourth.text)}`);

let failed = false;
if (!/stored/i.test(first.text)) {
  console.error("FAIL: could not recover the first answer from the terminal");
  failed = true;
}
if (!/ocelot/i.test(second.text)) {
  console.error("FAIL: context did not carry across turns");
  failed = true;
}
if (!/still_here/i.test(fourth.text)) {
  console.error("FAIL: the session did not survive the cancel");
  failed = true;
}
if (starts !== 1) {
  console.error(`FAIL: expected one terminal session, saw ${starts}`);
  failed = true;
}
console.log(failed ? "FAILED" : "PASS — steerable, and the session held");
process.exit(failed ? 1 : 0);
