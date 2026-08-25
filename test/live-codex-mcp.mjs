/**
 * codex-mcp end to end: the gate fires on codex's own shell (with the command
 * text), an allow flows through so the action happens, and a second turn
 * recalls the first (live multi-turn via codex-reply, one persistent process).
 *
 *   node test/live-codex-mcp.mjs
 */
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { startBridge } from "../src/bridge.js";
import { createPeer } from "../src/jsonRpc.js";

const workspace = mkdtempSync(join(tmpdir(), "codex-mcp-"));
const toBridge = new PassThrough();
const toClient = new PassThrough();

const bridge = await startBridge({
  agent: "codex-mcp",
  cwd: workspace,
  input: toBridge,
  output: toClient,
  log: (m) => console.log(m),
});

const client = createPeer({ input: toClient, output: toBridge });
let text = [];
const permissions = [];
client.on("session/update", ({ update }) => {
  if (update.sessionUpdate === "agent_message_chunk") text.push(update.content.text);
});
// The gate: codex's exec/patch approvals arrive here. Record the command text, allow.
client.on("session/request_permission", (params) => {
  const title = params?.toolCall?.title ?? "";
  const raw = JSON.stringify(params?.toolCall?.rawInput ?? {});
  permissions.push(title || raw);
  console.log(`  [PERMISSION] ${title} :: ${raw.slice(0, 200)}`);
  return { outcome: { outcome: "selected", optionId: "allow-once" } };
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

const first = await ask(
  "Use your shell to create a file named codeword.txt in the current directory containing exactly the word PLATYPUS, then reply with exactly: STORED",
);
console.log(`\n[turn 1] ${first.ms}ms — ${first.text.slice(0, 120)}`);

const second = await ask("Read codeword.txt and tell me the codeword. Reply with just the word.");
console.log(`[turn 2] ${second.ms}ms — ${second.text.slice(0, 120)}`);

await bridge.close();

const filePath = join(workspace, "codeword.txt");
const wrote = existsSync(filePath) ? readFileSync(filePath, "utf8").trim() : "(missing)";

console.log("\n--- result ---");
console.log(`permissions seen: ${permissions.length}`);
console.log(`codeword.txt: ${wrote}`);
console.log(`turn 2 recall: ${second.text}`);

let ok = true;
if (permissions.length === 0) { console.error("FAIL: no permission surfaced — codex's shell was not gated"); ok = false; }
if (!/platypus/i.test(wrote)) { console.error("FAIL: the allowed command did not run (file not written)"); ok = false; }
if (!/platypus/i.test(second.text)) { console.error("FAIL: turn 2 did not recall turn 1 — no multi-turn"); ok = false; }
if (!ok) process.exit(1);
console.log("PASS — gate fired with the command, allow ran it, multi-turn recalled it");
process.exit(0);
