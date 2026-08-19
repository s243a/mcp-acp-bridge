/**
 * Does a second turn reuse the first turn's conversation?
 *
 * The point of the persistent profile is that startup and context are paid
 * once. Asking the agent to recall something from turn one is the only honest
 * check — a fast second turn could just be caching.
 *
 *   node test/live-agy-multiturn.mjs
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { startBridge } from "../src/bridge.js";
import { createPeer } from "../src/jsonRpc.js";

const workspace = mkdtempSync(join(tmpdir(), "agy-multi-"));
const toBridge = new PassThrough();
const toClient = new PassThrough();

let starts = 0;
const bridge = await startBridge({
  agent: "agy",
  cwd: workspace,
  input: toBridge,
  output: toClient,
  log: (m) => {
    if (m.includes("starting persistent")) starts += 1;
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
  const started = Date.now();
  const result = await client.request("session/prompt", {
    sessionId,
    prompt: [{ type: "text", text: prompt }],
  });
  return { text: text.join("").trim(), ms: Date.now() - started, stopReason: result.stopReason };
};

const first = await ask("Remember this codeword: PLATYPUS. Reply with exactly: STORED");
console.log(`\n[turn 1] ${first.ms}ms — ${first.text.slice(0, 80)}`);

const second = await ask("What was the codeword I asked you to remember? Reply with just the word.");
console.log(`[turn 2] ${second.ms}ms — ${second.text.slice(0, 80)}`);

await bridge.close();

console.log("\n--- result ---");
console.log(`agent process starts: ${starts}`);
console.log(`turn 1: ${first.ms}ms, turn 2: ${second.ms}ms`);

if (starts !== 1) {
  console.error(`FAIL: expected one agent process for the session, saw ${starts}`);
  process.exit(1);
}
if (!/platypus/i.test(second.text)) {
  console.error("FAIL: the second turn did not recall the first — context was not retained");
  process.exit(1);
}
console.log("PASS — one process, context retained across turns");
process.exit(0);
