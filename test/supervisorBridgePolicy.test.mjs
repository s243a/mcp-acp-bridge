import assert from "node:assert/strict";
import { test } from "node:test";
import { PassThrough } from "node:stream";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { startBridge } from "../src/bridge.js";
import { createPeer } from "../src/jsonRpc.js";
import { WHEN_ABSENT } from "../src/supervisor.js";

const MODES = [
  ["MCP seat", { seatSupervisor: true }],
  ["ACP pull", { supervisorAcp: true }],
  ["ACP push", { supervisorAcpPush: true }],
];

async function harness(mode, whenSupervisorAbsent) {
  const toBridge = new PassThrough();
  const fromBridge = new PassThrough();
  let humanRequests = 0;
  let toolRuns = 0;

  const bridge = await startBridge({
    agent: "claude",
    input: toBridge,
    output: fromBridge,
    log: () => {},
    ...mode,
    whenSupervisorAbsent,
    tools: [
      {
        name: "probe",
        description: "Records whether an approved tool call ran.",
        inputSchema: { type: "object", properties: {} },
        handler: async () => {
          toolRuns += 1;
          return "ran";
        },
      },
    ],
  });

  const acpClient = createPeer({ input: fromBridge, output: toBridge });
  acpClient.on("session/request_permission", () => {
    humanRequests += 1;
    return { outcome: { outcome: "selected", optionId: "allow-once" } };
  });
  await acpClient.request("initialize", { protocolVersion: 1 });
  const { sessionId } = await acpClient.request("session/new", { cwd: process.cwd() });

  const session = bridge.gateway.openSession({ sessionId });
  const mcpClient = new Client({ name: "supervisor-policy-test", version: "0" }, { capabilities: {} });
  await mcpClient.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${bridge.port}/mcp/${session.token}`)),
  );

  return {
    bridge,
    acpClient,
    mcpClient,
    humanRequests: () => humanRequests,
    toolRuns: () => toolRuns,
  };
}

for (const [name, mode] of MODES) {
  test(`${name}: strict absence denies without asking the human`, async () => {
    const h = await harness(mode, WHEN_ABSENT.DENY);
    try {
      const result = await h.mcpClient.callTool({ name: "probe", arguments: {} });

      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /no supervisor available/);
      assert.equal(h.humanRequests(), 0);
      assert.equal(h.toolRuns(), 0);
    } finally {
      await h.mcpClient.close();
      h.acpClient.close();
      await h.bridge.close();
    }
  });

  test(`${name}: default absence still falls through to the human`, async () => {
    const h = await harness(mode, WHEN_ABSENT.HUMAN);
    try {
      const result = await h.mcpClient.callTool({ name: "probe", arguments: {} });

      assert.notEqual(result.isError, true);
      assert.equal(h.humanRequests(), 1);
      assert.equal(h.toolRuns(), 1);
    } finally {
      await h.mcpClient.close();
      h.acpClient.close();
      await h.bridge.close();
    }
  });
}
