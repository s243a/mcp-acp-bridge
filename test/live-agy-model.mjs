/**
 * Does a model choice actually reach agy?
 *
 * The status line names the current model, so switching it is observable
 * without asking the agent to introspect.
 */
import { mkdtempSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { startBridge } from "../src/bridge.js";
import { createPeer } from "../src/jsonRpc.js";
import { stripAnsi } from "../src/ptySession.js";

const base = join(homedir(), "acp-bridge-workspaces");
mkdirSync(base, { recursive: true });
const ws = mkdtempSync(join(base, "model-"));

const toBridge = new PassThrough();
const toClient = new PassThrough();
const bridge = await startBridge({
  agent: "agy-dual",
  cwd: ws,
  input: toBridge,
  output: toClient,
  log: (m) => console.log(m),
});
const client = createPeer({ input: toClient, output: toBridge });
client.on("session/update", () => {});
await client.request("initialize", { protocolVersion: 1 });
const session = await client.request("session/new", { cwd: ws });

let screen = "";
const capture = (chunk) => (screen += chunk);
process.stderr.write = new Proxy(process.stderr.write, {
  apply(target, thisArg, args) {
    capture(String(args[0]));
    return true;
  },
});

// A turn to get the terminal up and settled.
await client.request("session/prompt", {
  sessionId: session.sessionId,
  prompt: [{ type: "text", text: "Reply with exactly READY." }],
});

const modelLine = () => {
  const plain = stripAnsi(screen).replace(/\s+/g, " ");
  const matches = [...plain.matchAll(/(Gemini [\w. ()]+?) · (\w+)/g)];
  return matches.length ? matches[matches.length - 1][0] : "(no model line seen)";
};

screen = "";
await new Promise((r) => setTimeout(r, 2_000));
console.log("[test] before:", modelLine());

await client.request("session/set_model", {
  sessionId: session.sessionId,
  modelId: "Gemini 3.1 Pro",
});
await new Promise((r) => setTimeout(r, 12_000));
console.log("[test] after: ", modelLine());

await bridge.close();
process.exit(0);
