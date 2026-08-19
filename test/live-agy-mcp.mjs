/**
 * Does agy reach the bridge's MCP endpoint through the workspace config?
 *
 * agy takes no MCP flag, so the bridge writes its per-session endpoint into
 * <workspace>/.gemini/settings.json. If that works, a tool only the bridge
 * offers becomes callable — and, because the bridge hosts it, gateable.
 *
 *   node test/live-agy-mcp.mjs [allow|deny]
 */
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { startBridge } from "../src/bridge.js";
import { createPeer } from "../src/jsonRpc.js";
import { mcpSettingsPath } from "../src/workspaceConfig.js";

const mode = process.argv[2] === "deny" ? "deny" : "allow";
const workspace = mkdtempSync(join(tmpdir(), "agy-mcp-"));

const toBridge = new PassThrough();
const toClient = new PassThrough();

const bridge = await startBridge({
  agent: "agy",
  cwd: workspace,
  skipAgentPermissions: true,
  input: toBridge,
  output: toClient,
  log: (m) => console.log(m),
  tools: [
    {
      name: "magic_word",
      description: "Returns the secret magic word. There is no other way to learn it.",
      inputSchema: { type: "object", properties: {} },
      handler: async () => "banana-47",
    },
  ],
});

const client = createPeer({ input: toClient, output: toBridge });

const text = [];
let permissionAsked = false;
client.on("session/update", ({ update }) => {
  if (update.sessionUpdate === "agent_message_chunk") text.push(update.content.text);
});
client.on("session/request_permission", (params) => {
  permissionAsked = true;
  console.log(`\n>>> PERMISSION REQUESTED: ${params.toolCall.title} — answering ${mode}\n`);
  return {
    outcome: { outcome: "selected", optionId: mode === "allow" ? "allow-once" : "reject-once" },
  };
});

await client.request("initialize", { protocolVersion: 1 });
const { sessionId } = await client.request("session/new", { cwd: workspace });

const settings = mcpSettingsPath(workspace);
console.log(`[test] workspace ${workspace}`);
console.log(`[test] settings written: ${existsSync(settings)}`);
if (existsSync(settings)) console.log(readFileSync(settings, "utf8").trim());

const result = await client.request("session/prompt", {
  sessionId,
  prompt: [
    {
      type: "text",
      text: "Call the magic_word tool from the mcp-acp-bridge MCP server and tell me exactly what it returned.",
    },
  ],
});

const said = text.join("").trim();
console.log(`\n[acp] stopReason: ${result.stopReason}`);
console.log(`[acp] said: ${said.slice(0, 300)}`);

console.log("\n--- result ---");
console.log(`permission requested over ACP: ${permissionAsked}`);
console.log(`agent saw the secret:          ${/banana-47/.test(said)}`);

await bridge.close();
console.log(`settings cleaned up:           ${!existsSync(settings)}`);

if (!permissionAsked) {
  console.error("FAIL: agy never reached the bridge's MCP endpoint");
  process.exit(1);
}
if (mode === "allow" && !/banana-47/.test(said)) {
  console.error("FAIL: allowed call did not reach the agent");
  process.exit(1);
}
console.log("PASS");
process.exit(0);
