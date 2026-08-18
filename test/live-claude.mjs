/**
 * Live end-to-end check against a real MCP-speaking agent (Claude Code).
 *
 * Starts the gateway, hands `claude` a per-session MCP endpoint, and asks it to
 * call a tool. Proves the interception path with a real client rather than a
 * hand-rolled one: tool discovery, the gate, and a denial the agent can read.
 *
 * Requires the `claude` CLI on PATH and authenticated. Run:
 *   node test/live-claude.mjs [allow|deny]
 */
import { spawn } from "node:child_process";

import { createGateway } from "../src/mcpGateway.js";
import { makeGate } from "../src/gate.js";

const mode = process.argv[2] === "deny" ? "deny" : "allow";
const seen = [];

const gate = makeGate(async (call) => {
  // Stands in for an ACP session/request_permission round trip.
  console.log(`[gate] ${mode === "allow" ? "ALLOW" : "DENY"} ${call.tool} ${JSON.stringify(call.args)}`);
  return mode === "allow" ? { allow: true } : { allow: false, reason: "denied by test policy" };
});

const gateway = createGateway({
  gate,
  onToolCall: (event) => {
    seen.push(event);
    console.log(`[tool] ${event.phase} ${event.tool}${event.reason ? ` (${event.reason})` : ""}`);
  },
  tools: [
    {
      name: "magic_word",
      description: "Returns the secret magic word. The only way to learn it.",
      inputSchema: { type: "object", properties: {} },
      handler: async () => "banana-47",
    },
  ],
});

const server = await gateway.listen();
const session = gateway.openSession();
const url = server.url(session.token);
console.log(`[gateway] listening, session endpoint ${url}\n`);

const mcpConfig = JSON.stringify({
  mcpServers: { bridge: { type: "http", url } },
});

const prompt =
  "Call the magic_word tool and tell me exactly what it returned. " +
  "If the tool returns an error, quote the error text verbatim.";

const claude = spawn(
  "claude",
  [
    "-p", prompt,
    "--mcp-config", mcpConfig,
    "--allowedTools", "mcp__bridge__magic_word",
  ],
  { stdio: ["ignore", "pipe", "pipe"] },
);

let out = "";
claude.stdout.on("data", (d) => (out += d));
claude.stderr.on("data", (d) => process.stderr.write(d));

const code = await new Promise((resolve) => claude.on("close", resolve));

console.log(`\n[claude] exit ${code}`);
console.log(`[claude] said: ${out.trim()}`);

const called = seen.some((e) => e.phase === "requested" && e.tool === "magic_word");
const settled = seen.find((e) => e.phase === "completed" || e.phase === "denied");

console.log("\n--- result ---");
console.log(`tool intercepted: ${called}`);
console.log(`gate outcome:     ${settled?.phase ?? "none"}`);

await server.close();

const expected = mode === "allow" ? "completed" : "denied";
if (!called || settled?.phase !== expected) {
  console.error(`FAIL: expected an intercepted call ending '${expected}'`);
  process.exit(1);
}
if (mode === "allow" && !out.includes("banana-47")) {
  console.error("FAIL: agent did not report the tool result");
  process.exit(1);
}
console.log("PASS");
