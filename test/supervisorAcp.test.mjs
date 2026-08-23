/**
 * The supervisor over ACP, end to end over a real stream pair.
 *
 * A client peer drives the supervisor ACP server through initialize, claim,
 * pending, decide — and, the point of doing it over ACP, dropping the connection
 * frees the seat with no force-release, which stateless MCP cannot do.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { PassThrough } from "node:stream";

import { createSupervisorSeat } from "../src/supervisorSeat.js";
import { createSupervisorAdapter } from "../src/supervisorAdapter.js";
import { createSupervisorAcpServer } from "../src/supervisorAcp.js";
import { createPeer } from "../src/jsonRpc.js";
import { APPROVE, PASS } from "../src/supervisor.js";

/** Cross-wire two streams so a client peer talks to the ACP supervisor server. */
function harness(session = "acp-op", operators = [session]) {
  const seat = createSupervisorSeat({ timeoutMs: 5000 });
  const adapter = createSupervisorAdapter(seat, { isOperator: (s) => operators.includes(s) });
  const toServer = new PassThrough();
  const toClient = new PassThrough();
  const server = createSupervisorAcpServer({ input: toServer, output: toClient, adapter, session });
  const client = createPeer({ input: toClient, output: toServer });
  return { seat, adapter, server, client, toServer };
}

const tick = () => new Promise((r) => setImmediate(r));

test("a supervisor claims over ACP, is offered a decision, and approves it", async () => {
  const { seat, client } = harness();

  const init = await client.request("initialize", { protocolVersion: 1 });
  assert.equal(init.protocolVersion, 1, "the ACP handshake answers");
  assert.equal((await client.request("supervisor/claim")).ok, true, "the operator connection claims the seat");

  const decision = seat.supervise({ tool: "run_command", args: { cmd: "ls" }, session: "SECRET" });
  const { pending } = await client.request("supervisor/pending");
  assert.equal(pending.length, 1);
  assert.equal(pending[0].tool, "run_command");
  assert.ok(!("session" in pending[0]), "redacted to tool and args");

  const decided = await client.request("supervisor/decide", { id: pending[0].id, verdict: "approve" });
  assert.equal(decided.ok, true);
  assert.equal(await decision, APPROVE, "the gate's decision resolves to the ACP verdict");
});

test("dropping the ACP connection frees the seat — no force-release needed", async () => {
  const { seat, client, toServer } = harness();
  await client.request("supervisor/claim");
  assert.equal(seat.status().held, true);

  toServer.end(); // the supervisor's connection closes
  await tick();

  assert.equal(seat.status().held, false, "the seat freed itself on disconnect — ACP's advantage over MCP");
  assert.equal(await seat.supervise({ tool: "x" }), PASS, "and decisions fall through again");
});

test("an ACP connection the bridge did not mark operator cannot claim", async () => {
  const { client } = harness("intruder", ["the-real-operator"]);
  assert.equal((await client.request("supervisor/claim")).ok, false, "reaching the endpoint is not authority");
  assert.deepEqual((await client.request("supervisor/pending")).pending, [], "and it is offered nothing");
});

test("a supervisor connects to the bridge's ACP endpoint over real TCP and supervises", async () => {
  const { startBridge } = await import("../src/bridge.js");
  const { connect } = await import("node:net");

  const bridge = await startBridge({
    agent: "claude",
    supervisorAcp: true,
    input: new PassThrough(), // not the real stdin
    output: new PassThrough(),
    log: () => {},
  });
  try {
    assert.ok(bridge.supervisorAcpPort > 0, "the ACP seat endpoint bound a port");
    const socket = connect(bridge.supervisorAcpPort, "127.0.0.1");
    await new Promise((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    const client = createPeer({ input: socket, output: socket });
    await client.request("initialize", { protocolVersion: 1 });
    assert.equal((await client.request("supervisor/claim")).ok, true, "the connecting supervisor is the operator");

    const decision = bridge.seat.supervise({ tool: "run_command", args: {} });
    const { pending } = await client.request("supervisor/pending");
    assert.equal(pending.length, 1);
    assert.equal((await client.request("supervisor/decide", { id: pending[0].id, verdict: "approve" })).ok, true);
    assert.equal(await decision, APPROVE, "the gate resolves to the ACP supervisor's verdict, over the wire");

    socket.destroy();
  } finally {
    await bridge.close();
  }
});
