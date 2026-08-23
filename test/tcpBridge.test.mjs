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

import { createTcpBridge, MAX_SESSIONS } from "../src/tcpBridge.js";
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

test("connections are capped, so a reconnect loop cannot exhaust the machine", async () => {
  const bridge = createTcpBridge({ agent: "claude" });
  const { port } = await bridge.listen();

  const held = [];
  // The server accepts the TCP connection and *then* destroys it when over the
  // cap, so "refused" shows up as the socket closing shortly after connecting
  // rather than as a connect error. Hold a connection open by settling on
  // connect, and separately watch whether it gets closed from the other end.
  const openOne = () =>
    new Promise((resolve) => {
      const socket = connect({ host: "127.0.0.1", port });
      let refused = false;
      socket.on("close", () => (refused = true));
      socket.on("error", () => {});
      socket.once("connect", () => setTimeout(() => resolve({ socket, refused }), 80));
    });

  try {
    for (let i = 0; i < MAX_SESSIONS; i += 1) held.push(await openOne());
    const overflow = await openOne();
    assert.equal(overflow.refused, true, "the one past the cap is closed, not served");
  } finally {
    for (const { socket } of held) socket.destroy();
    await bridge.close();
  }
});

test("close waits for sessions rather than returning before they end", async () => {
  const bridge = createTcpBridge({ agent: "claude" });
  const { port } = await bridge.listen();

  const socket = connect({ host: "127.0.0.1", port });
  await new Promise((resolve) => socket.once("connect", resolve));
  const client = clientOn(socket);
  client.on("session/update", () => {});
  await client.request("initialize", { protocolVersion: 1 });

  // The assertion is that close() settles *while a connection is still open* —
  // it tears the session down rather than waiting for the client to leave, and
  // it does not resolve before the agent teardown it awaits. A broken await
  // chain or a wait-for-client close would hang here.
  await assert.doesNotReject(
    Promise.race([
      bridge.close(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("close hung")), 4000)),
    ]),
    "close settles without waiting for the client to hang up",
  );
  socket.destroy();
});

test("close does not hang on a bridge that never finishes starting", async () => {
  // A startBridge that never resolves — port contention, a wedged dependency.
  // Teardown must not await it, or shutdown waits on something that may never
  // finish (the shape of the Ctrl-C bug, reintroduced by the fix for the last).
  let settle;
  const wedged = new Promise((resolve) => (settle = resolve));
  const bridge = createTcpBridge({ startBridgeImpl: () => wedged });
  const { port } = await bridge.listen();

  const socket = connect({ host: "127.0.0.1", port });
  await new Promise((resolve) => socket.once("connect", resolve));
  await new Promise((resolve) => setTimeout(resolve, 30)); // let the session register

  await assert.doesNotReject(
    Promise.race([
      bridge.close(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("close hung on a starting bridge")), 3000)),
    ]),
    "close returns even while a bridge is still starting",
  );
  socket.destroy();
  settle?.({ close: () => {} }); // let the wedged promise resolve to a closeable stub
});
