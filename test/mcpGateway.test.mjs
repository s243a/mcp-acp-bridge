/**
 * Session routing, exercised over real HTTP with an SDK client.
 *
 * The property under test is that a session's identity comes from its path and
 * nothing else — no `Mcp-Session-Id`, no handshake state — so the same code
 * serves both MCP revisions and two concurrent agents cannot cross-wire.
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { createGateway } from "../src/mcpGateway.js";
import { makeGate } from "../src/gate.js";

const observed = [];

const gateway = createGateway({
  gate: makeGate(async (c) => ({ allow: c.args?.secret !== "forbidden" , reason: "policy" })),
  onToolCall: (e) => observed.push(e),
  tools: [
    {
      name: "whoami",
      description: "Echoes the calling session id.",
      inputSchema: { type: "object", properties: { secret: { type: "string" } } },
      handler: async () => "ok",
    },
  ],
});

const server = await gateway.listen();
after(() => server.close());

async function connect(token) {
  const client = new Client({ name: "test", version: "0" }, { capabilities: {} });
  await client.connect(new StreamableHTTPClientTransport(new URL(server.url(token))));
  return client;
}

test("lists tools over a session endpoint", async () => {
  const session = gateway.openSession();
  const client = await connect(session.token);
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name), ["whoami"]);
  await client.close();
});

test("attributes a call to the session that owns the path", async () => {
  const a = gateway.openSession({ sessionId: "session-a" });
  const b = gateway.openSession({ sessionId: "session-b" });

  const clientB = await connect(b.token);
  observed.length = 0;
  await clientB.callTool({ name: "whoami", arguments: {} });
  await clientB.close();

  const requested = observed.find((e) => e.phase === "requested");
  assert.equal(requested.sessionId, "session-b");
  assert.notEqual(requested.sessionId, a.sessionId);
});

test("a denied call reaches the agent as a readable tool error", async () => {
  const session = gateway.openSession();
  const client = await connect(session.token);
  const result = await client.callTool({
    name: "whoami",
    arguments: { secret: "forbidden" },
  });
  assert.equal(result.isError, true);
  // The reason travels with the refusal, and the refusal says not to retry —
  // an agent that rewords a denied call asks the reviewer the same question
  // twice.
  assert.match(result.content[0].text, /refused/i);
  assert.match(result.content[0].text, /policy/);
  assert.match(result.content[0].text, /do not run it again/i);
  await client.close();
});

test("issues no Mcp-Session-Id — nothing may depend on transport state", async () => {
  const session = gateway.openSession();
  const response = await fetch(server.url(session.token), {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "probe", version: "0" },
      },
    }),
  });
  assert.equal(response.ok, true);
  assert.equal(response.headers.get("mcp-session-id"), null);
});

test("rejects an unknown session path", async () => {
  const response = await fetch(server.url("not-a-real-token"), { method: "POST" });
  assert.equal(response.status, 404);
});

test("a closed session stops accepting calls", async () => {
  const session = gateway.openSession();
  gateway.closeSession(session.token);
  const response = await fetch(server.url(session.token), { method: "POST" });
  assert.equal(response.status, 404);
});
