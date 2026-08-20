/**
 * Execution gated over MCP.
 *
 * Asks for the write-then-run sequence that defeats reviewing tools by name:
 * write a script, then run it. What matters is that the run arrives as an MCP
 * call carrying the command, and that agy's own command tool is not what
 * carried it.
 */
import { mkdtempSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { startBridge } from "../src/bridge.js";
import { createPeer } from "../src/jsonRpc.js";

const base = join(homedir(), "acp-bridge-workspaces");
mkdirSync(base, { recursive: true });
const ws = mkdtempSync(join(base, "gated-"));

const toBridge = new PassThrough();
const toClient = new PassThrough();
const bridge = await startBridge({
  agent: "agy-dual-gated",
  cwd: ws,
  input: toBridge,
  output: toClient,
  log: (message) => console.log(message),
});

const client = createPeer({ input: toClient, output: toBridge });
client.on("session/update", () => {});

/** Every held call, with the command the gate was shown. */
const reviewed = [];
client.on("session/request_permission", (params) => {
  const call = params?.toolCall ?? {};
  reviewed.push({ tool: call.title ?? call.toolCallId, raw: JSON.stringify(call) });
  console.log(`[review] ${call.title ?? "?"} :: ${JSON.stringify(call.content ?? {}).slice(0, 160)}`);
  return { outcome: { outcome: "selected", optionId: "allow-once" } };
});

await client.request("initialize", { protocolVersion: 1 });
const session = await client.request("session/new", { cwd: ws });

const started = Date.now();
const done = client.request("session/prompt", {
  sessionId: session.sessionId,
  prompt: [
    {
      type: "text",
      text: "Write a file hello.sh containing `echo GATED_OK`, then run it with bash and reply with its exact output.",
    },
  ],
});
const result = await Promise.race([
  done,
  new Promise((r) => setTimeout(() => r({ stopReason: "TIMEOUT" }), 180_000)),
]);

console.log(`\n[test] ${Math.round((Date.now() - started) / 1000)}s -> ${JSON.stringify(result)}`);
console.log(`[test] calls reviewed: ${reviewed.length}`);
for (const call of reviewed) console.log(`   - ${call.tool}`);

let failed = false;
const commands = reviewed.map((call) => call.raw).join(" ");
if (result.stopReason !== "end_turn") {
  console.error(`FAIL: turn ended as ${result.stopReason}`);
  failed = true;
}
if (!reviewed.length) {
  console.error("FAIL: execution was never put to the gate");
  failed = true;
}
if (!reviewed.every((call) => call.tool === "run_command")) {
  console.error("FAIL: something other than run_command carried the execution");
  failed = true;
}
if (!/hello\.sh/.test(commands)) {
  console.error("FAIL: the gate was not shown the command text");
  failed = true;
}

await bridge.close();
console.log(failed ? "FAILED" : "PASS — execution reviewed with the command in hand");
process.exit(failed ? 1 : 0);
