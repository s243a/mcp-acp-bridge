/**
 * The supervisor over ACP, end to end over a real stream pair and real TCP.
 *
 * The headline is the door: reaching the loopback port is not authority — a
 * connection supervises nothing until it presents the token the bridge printed,
 * which the supervised agent (also on this machine) cannot read. Then the ACP
 * advantage holds: a dropped connection frees the seat with no force-release.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { PassThrough } from "node:stream";

import { createSupervisorSeat } from "../src/supervisorSeat.js";
import { createSupervisorAdapter } from "../src/supervisorAdapter.js";
import { createSupervisorAcpServer } from "../src/supervisorAcp.js";
import { createPeer } from "../src/jsonRpc.js";
import { APPROVE, PASS } from "../src/supervisor.js";

/** Cross-wire two streams; a connection is operator only after the token. */
function harness(session = "acp-op") {
  const seat = createSupervisorSeat({ timeoutMs: 5000 });
  const operators = new Set();
  const adapter = createSupervisorAdapter(seat, { isOperator: (s) => operators.has(s) });
  const token = "the-secret-token";
  const toServer = new PassThrough();
  const toClient = new PassThrough();
  const server = createSupervisorAcpServer({
    input: toServer,
    output: toClient,
    adapter,
    session,
    token,
    onAuthenticated: (s) => operators.add(s),
  });
  const client = createPeer({ input: toClient, output: toServer });
  return { seat, adapter, server, client, toServer, token };
}

const tick = () => new Promise((r) => setImmediate(r));

test("an authenticated supervisor claims over ACP, is offered a decision, and approves it", async () => {
  const { seat, client, token } = harness();

  const init = await client.request("initialize", { protocolVersion: 1 });
  assert.equal(init.protocolVersion, 1, "the ACP handshake answers");
  await client.request("authenticate", { token });
  assert.equal((await client.request("supervisor/claim")).ok, true, "the authenticated connection claims the seat");

  const decision = seat.supervise({ tool: "run_command", args: { cmd: "ls" }, session: "SECRET" });
  const { pending } = await client.request("supervisor/pending");
  assert.equal(pending.length, 1);
  assert.equal(pending[0].tool, "run_command");
  assert.ok(!("session" in pending[0]), "redacted to tool and args");

  const decided = await client.request("supervisor/decide", { id: pending[0].id, verdict: "approve" });
  assert.equal(decided.ok, true);
  assert.equal(await decision, APPROVE, "the gate resolves to the ACP verdict");
});

test("a connection without the token is not an operator — the agent cannot self-approve", async () => {
  const { client } = harness();
  await client.request("initialize", { protocolVersion: 1 });

  await assert.rejects(client.request("authenticate", { token: "wrong" }), "a wrong token is rejected");
  // And a connection that never authenticated (as the supervised agent would be)
  // is refused everything — reaching the loopback port bought it nothing.
  assert.equal((await client.request("supervisor/claim")).ok, false, "unauthenticated cannot claim");
  assert.deepEqual((await client.request("supervisor/pending")).pending, [], "and is offered nothing");
});

test("dropping the ACP connection frees the seat — no force-release needed", async () => {
  const { seat, client, toServer, token } = harness();
  await client.request("authenticate", { token });
  await client.request("supervisor/claim");
  assert.equal(seat.status().held, true);

  toServer.end(); // the supervisor's connection closes
  await tick();

  assert.equal(seat.status().held, false, "the seat freed itself on disconnect — ACP's advantage over MCP");
  assert.equal(await seat.supervise({ tool: "x" }), PASS, "and decisions fall through again");
});

test("over real TCP: unauthenticated is refused, then the token lets the supervisor decide", async () => {
  const { startBridge } = await import("../src/bridge.js");
  const { connect } = await import("node:net");

  const bridge = await startBridge({
    agent: "claude",
    supervisorAcp: true,
    input: new PassThrough(),
    output: new PassThrough(),
    log: () => {},
  });
  try {
    assert.ok(bridge.supervisorAcpPort > 0, "the ACP seat endpoint bound a port");
    assert.ok(bridge.supervisorAcpToken, "a token was minted");

    const socket = connect(bridge.supervisorAcpPort, "127.0.0.1");
    await new Promise((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    const client = createPeer({ input: socket, output: socket });
    await client.request("initialize", { protocolVersion: 1 });

    assert.equal((await client.request("supervisor/claim")).ok, false, "reaching the port is not authority");
    await client.request("authenticate", { token: bridge.supervisorAcpToken });
    assert.equal((await client.request("supervisor/claim")).ok, true, "the token makes it an operator");

    const decision = bridge.seat.supervise({ tool: "run_command", args: {} });
    const { pending } = await client.request("supervisor/pending");
    assert.equal((await client.request("supervisor/decide", { id: pending[0].id, verdict: "approve" })).ok, true);
    assert.equal(await decision, APPROVE, "supervised over the wire, end to end");

    socket.destroy();
  } finally {
    await bridge.close();
  }
});

test("bridge.close() completes with an ACP supervisor still connected", async () => {
  const { startBridge } = await import("../src/bridge.js");
  const { connect } = await import("node:net");

  const bridge = await startBridge({
    agent: "claude",
    supervisorAcp: true,
    input: new PassThrough(),
    output: new PassThrough(),
    log: () => {},
  });
  const socket = connect(bridge.supervisorAcpPort, "127.0.0.1");
  await new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  // Hold the connection open and tear the bridge down. If close() waited on the
  // socket to end on its own, this would hang and the test would time out.
  await bridge.close();
  socket.destroy();
  assert.ok(true, "close resolved with a socket held open");
});
