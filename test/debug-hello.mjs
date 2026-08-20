/** Throwaway: what does a plain "Hello" produce end to end? */
import { mkdtempSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { startBridge } from "../src/bridge.js";
import { createPeer } from "../src/jsonRpc.js";

const base = join(homedir(), "acp-bridge-workspaces");
mkdirSync(base, { recursive: true });
const ws = mkdtempSync(join(base, "hello-"));
const toBridge = new PassThrough(); const toClient = new PassThrough();
const bridge = await startBridge({ agent: "agy-dual", cwd: ws, input: toBridge, output: toClient, log: (m) => console.log(m) });
const client = createPeer({ input: toClient, output: toBridge });
const chunks = [];
client.on("session/update", (p) => {
  const u = p?.update;
  if (u?.sessionUpdate === "agent_message_chunk") chunks.push(u.content?.text ?? "");
});
await client.request("initialize", { protocolVersion: 1 });
const s = await client.request("session/new", { cwd: ws });
const result = await Promise.race([
  client.request("session/prompt", { sessionId: s.sessionId, prompt: [{ type: "text", text: "Hello" }] }),
  new Promise((r) => setTimeout(() => r({ stopReason: "TIMEOUT" }), 120_000)),
]);
console.log("\n[test] result:", JSON.stringify(result).slice(0, 200));
console.log("[test] agent_message_chunks:", chunks.length, JSON.stringify(chunks).slice(0, 300));
await bridge.close(); process.exit(0);
