/**
 * Live check: ACP client → bridge → agy → ACP events.
 *
 * agy exposes no MCP flag, so its tool activity is observed through
 * stream-json rather than gated. What this proves is that a real agy turn
 * surfaces as proper ACP session updates — assistant text AND tool calls —
 * instead of an opaque blob of prose.
 *
 *   node test/live-agy.mjs
 */
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { startBridge } from "../src/bridge.js";
import { createPeer } from "../src/jsonRpc.js";

const workspace = mkdtempSync(join(tmpdir(), "agy-live-"));
const target = join(workspace, "hello.txt");

const toBridge = new PassThrough();
const toClient = new PassThrough();

const bridge = await startBridge({
  agent: "agy",
  cwd: workspace,
  input: toBridge,
  output: toClient,
  log: (m) => console.log(m),
});

const client = createPeer({ input: toClient, output: toBridge });

const text = [];
const toolEvents = [];
client.on("session/update", ({ update }) => {
  if (update.sessionUpdate === "agent_message_chunk") {
    text.push(update.content.text);
  } else {
    toolEvents.push(`${update.sessionUpdate}:${update.title ?? update.toolCallId}:${update.status}`);
    console.log(`[update] ${update.sessionUpdate} ${update.title ?? ""} ${update.status ?? ""}`);
  }
});
client.on("session/request_permission", () => ({
  outcome: { outcome: "selected", optionId: "allow-once" },
}));

await client.request("initialize", { protocolVersion: 1 });
const { sessionId } = await client.request("session/new", { cwd: workspace });
console.log(`[acp] session ${sessionId}`);
console.log(`[acp] workspace ${workspace}\n`);

const result = await client.request("session/prompt", {
  sessionId,
  prompt: [
    {
      type: "text",
      text: `Create a file called hello.txt in ${workspace} containing exactly the word banana. Use your file writing tool.`,
    },
  ],
});

console.log(`\n[acp] stopReason: ${result.stopReason}`);
console.log(`[acp] assistant text: ${text.join("").trim().slice(0, 300)}`);

console.log("\n--- result ---");
console.log(`tool events over ACP: ${toolEvents.length}`);
for (const event of toolEvents) console.log(`  ${event}`);
console.log(`file written: ${existsSync(target)}`);
if (existsSync(target)) console.log(`file contents: ${readFileSync(target, "utf8").trim()}`);

await bridge.close();

const streamedText = text.join("").trim().length > 0;
if (!streamedText) {
  console.error("FAIL: no assistant text streamed over ACP");
  process.exit(1);
}
if (toolEvents.length === 0) {
  console.error("FAIL: agy used a tool but no tool_call reached the client");
  process.exit(1);
}
console.log("PASS");
process.exit(0);
