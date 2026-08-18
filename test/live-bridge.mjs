/**
 * Full-chain check: ACP client → bridge → agent → MCP → gate → ACP approval.
 *
 * An ACP client drives the bridge over stdio. The bridge spawns a real agent,
 * hands it a per-session MCP endpoint, and the agent calls a tool. That call is
 * held and surfaces here as `session/request_permission` — the thing the whole
 * project exists to do.
 *
 *   node test/live-bridge.mjs [allow|deny]
 */
import { PassThrough } from "node:stream";

import { startBridge } from "../src/bridge.js";
import { createPeer } from "../src/jsonRpc.js";

const mode = process.argv[2] === "deny" ? "deny" : "allow";

const toBridge = new PassThrough();
const toClient = new PassThrough();

const bridge = await startBridge({
  agent: "claude",
  input: toBridge,
  output: toClient,
  log: (m) => console.log(m),
  tools: [
    {
      name: "magic_word",
      description: "Returns the secret magic word. The only way to learn it.",
      inputSchema: { type: "object", properties: {} },
      handler: async () => "banana-47",
    },
  ],
});

const client = createPeer({ input: toClient, output: toBridge });

const chunks = [];
let permissionAsked = false;

client.on("session/update", ({ update }) => {
  if (update.sessionUpdate === "agent_message_chunk") chunks.push(update.content.text);
  else console.log(`[update] ${update.sessionUpdate} ${update.status ?? ""}`);
});

client.on("session/request_permission", (params) => {
  permissionAsked = true;
  console.log(`\n>>> PERMISSION REQUESTED: ${params.toolCall.title}`);
  console.log(`>>> answering: ${mode}\n`);
  return {
    outcome: {
      outcome: "selected",
      optionId: mode === "allow" ? "allow-once" : "reject-once",
    },
  };
});

await client.request("initialize", { protocolVersion: 1 });
const { sessionId } = await client.request("session/new", { cwd: process.cwd() });
console.log(`[acp] session ${sessionId}\n`);

const result = await client.request("session/prompt", {
  sessionId,
  prompt: [
    {
      type: "text",
      text:
        "Call the magic_word tool and tell me exactly what it returned. " +
        "If it returns an error, quote the error verbatim.",
    },
  ],
});

const said = chunks.join("").trim();
console.log(`\n[acp] stopReason: ${result.stopReason}`);
console.log(`[acp] agent said: ${said}`);

console.log("\n--- result ---");
console.log(`permission requested over ACP: ${permissionAsked}`);

await bridge.close();

if (!permissionAsked) {
  console.error("FAIL: the tool call never surfaced as an ACP permission request");
  process.exit(1);
}
if (mode === "allow" && !said.includes("banana-47")) {
  console.error("FAIL: allowed call did not reach the agent");
  process.exit(1);
}
if (mode === "deny" && !/denied/i.test(said)) {
  console.error("FAIL: denial did not reach the agent legibly");
  process.exit(1);
}
console.log("PASS");
process.exit(0);
