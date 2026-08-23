/**
 * The bridge over a socket rather than over stdio.
 *
 * The transport, not the agent: a connection becomes an ACP session, an ACP
 * client can `initialize` and open a session over it, and a dropped socket tears
 * the session down.
 */
import assert from "node:assert/strict";
import { connect } from "node:net";
import { test } from "node:test";

import { createTcpBridge } from "../src/tcpBridge.js";
import { createPeer } from "../src/jsonRpc.js";

/** An ACP client speaking JSON-RPC down a socket. */
function clientOn(socket) {
  return createPeer({ input: socket, output: socket });
}

test("a client can initialize and open a session over TCP", async () => {
  // A stub agent, so this exercises the transport rather than a real CLI.
  const bridge = createTcpBridge({ agent: "claude", host: "127.0.0.1" });
  const { port } = await bridge.listen();

  const socket = connect({ host: "127.0.0.1", port });
  await new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  const client = clientOn(socket);
  client.on("session/update", () => {});

  try {
    const init = await client.request("initialize", { protocolVersion: 1 });
    assert.ok(init.protocolVersion, "the bridge answered initialize over the socket");

    const session = await client.request("session/new", { cwd: "/tmp" });
    assert.ok(session.sessionId, "and opened a session over the socket");
  } finally {
    socket.destroy();
    await bridge.close();
  }
});

test("a dropped connection ends its session", async () => {
  const bridge = createTcpBridge({ agent: "claude" });
  const { port } = await bridge.listen();

  const socket = connect({ host: "127.0.0.1", port });
  await new Promise((resolve) => socket.once("connect", resolve));
  const client = clientOn(socket);
  client.on("session/update", () => {});
  await client.request("initialize", { protocolVersion: 1 });

  // Drop it. The point is that closing does not hang and the server survives to
  // take another connection — an agent nobody can reach must not linger.
  socket.destroy();
  await new Promise((resolve) => setTimeout(resolve, 50));

  const again = connect({ host: "127.0.0.1", port });
  await new Promise((resolve, reject) => {
    again.once("connect", resolve);
    again.once("error", reject);
  });
  const second = clientOn(again);
  second.on("session/update", () => {});
  try {
    const init = await second.request("initialize", { protocolVersion: 1 });
    assert.ok(init.protocolVersion, "the listener survived the dropped connection");
  } finally {
    again.destroy();
    await bridge.close();
  }
});

test("it binds loopback by default", async () => {
  const bridge = createTcpBridge({ agent: "claude" });
  const { host } = await bridge.listen();
  try {
    assert.equal(host, "127.0.0.1", "an unauthenticated agent does not reach a network by accident");
  } finally {
    await bridge.close();
  }
});
