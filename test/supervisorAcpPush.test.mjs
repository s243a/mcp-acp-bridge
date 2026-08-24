/**
 * The supervisor over ACP, *push* shape — end to end over real streams and TCP.
 *
 * The mirror of supervisorAcp.test.mjs. Same door (a token, since the port is
 * loopback and the supervised agent can reach it too), but the direction is
 * reversed: the bridge sends each deferred decision to the connected agent as a
 * `supervisor/review` request, and the agent's reply is the verdict. Authenticate
 * binds this connection as the decider; its close returns decisions to the human.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { PassThrough } from "node:stream";

import { createSupervisorAcpPushServer } from "../src/supervisorAcpPush.js";
import { createExternalSupervisor } from "../src/supervisor.js";
import { createPeer } from "../src/jsonRpc.js";
import { APPROVE, REJECT, PASS } from "../src/supervisor.js";

/** Cross-wire two streams; the client answers `supervisor/review` requests. */
function harness({ token = "the-secret-token", review } = {}) {
  const supervisor = createExternalSupervisor({ timeoutMs: 5000 });
  const toServer = new PassThrough();
  const toClient = new PassThrough();
  const server = createSupervisorAcpPushServer({ input: toServer, output: toClient, supervisor, token });
  const client = createPeer({ input: toClient, output: toServer });
  if (review) client.on("supervisor/review", review);
  return { supervisor, server, client, toServer };
}

const tick = () => new Promise((r) => setImmediate(r));

test("an authenticated supervisor becomes the decider; its reply is the verdict", async () => {
  const seen = [];
  const { supervisor, client } = harness({
    review: (params) => {
      seen.push(params);
      return { verdict: "approve" };
    },
  });

  const init = await client.request("initialize", { protocolVersion: 1 });
  assert.equal(init.protocolVersion, 1, "the ACP handshake answers");
  await client.request("authenticate", { token: "the-secret-token" });

  const verdict = await supervisor.supervise({ tool: "run_command", args: { cmd: "ls" }, session: "SECRET" });
  assert.equal(verdict, APPROVE, "the gate resolves to the agent's reply");
  assert.equal(seen.length, 1, "one review was pushed");
  assert.deepEqual(seen[0], { tool: "run_command", args: { cmd: "ls" } }, "redacted to tool and args — no session");
});

test("a `reject` reply defers to the human (REJECT), never a silent allow", async () => {
  const { supervisor, client } = harness({ review: () => ({ verdict: "reject" }) });
  await client.request("initialize", { protocolVersion: 1 });
  await client.request("authenticate", { token: "the-secret-token" });
  assert.equal(await supervisor.supervise({ tool: "x", args: {} }), REJECT);
});

test("a bare verdict string is read the same way as {verdict}", async () => {
  const { supervisor, client } = harness({ review: () => "approve" });
  await client.request("initialize", { protocolVersion: 1 });
  await client.request("authenticate", { token: "the-secret-token" });
  assert.equal(await supervisor.supervise({ tool: "x", args: {} }), APPROVE);
});

test("a connection without the token never binds — the agent cannot self-approve", async () => {
  let reviewed = false;
  const { supervisor, client } = harness({ review: () => ((reviewed = true), { verdict: "approve" }) });
  await client.request("initialize", { protocolVersion: 1 });
  await assert.rejects(client.request("authenticate", { token: "wrong" }), "a wrong token is rejected");

  // Nobody bound, so the seam falls through to the human — here, PASS — and the
  // unauthenticated connection is never asked to review anything.
  assert.equal(await supervisor.supervise({ tool: "x", args: {} }), PASS, "no reviewer bound → deferral");
  assert.equal(reviewed, false, "the unauthenticated connection was never handed a decision");
});

test("dropping the connection unbinds — decisions fall back to the human", async () => {
  const { supervisor, client, toServer } = harness({ review: () => ({ verdict: "approve" }) });
  await client.request("initialize", { protocolVersion: 1 });
  await client.request("authenticate", { token: "the-secret-token" });
  assert.equal(await supervisor.supervise({ tool: "x", args: {} }), APPROVE, "bound and deciding");

  toServer.end(); // the supervisor's connection closes
  await tick();

  assert.equal(await supervisor.supervise({ tool: "x", args: {} }), PASS, "unbound on disconnect — the human decides again");
});

test("a former binder's late disconnect does not unbind its successor", async () => {
  // The reconnect-wedge: a supervisor's flaky socket reconnects (a fresh bind
  // displaces the old one), then the old socket finally closes. Its disconnect
  // must not release the live connection, or supervision wedges closed silently.
  const supervisor = createExternalSupervisor({ timeoutMs: 5000 });
  const token = "t";
  const mk = (review) => {
    const toServer = new PassThrough();
    const toClient = new PassThrough();
    createSupervisorAcpPushServer({ input: toServer, output: toClient, supervisor, token });
    const client = createPeer({ input: toClient, output: toServer });
    client.on("supervisor/review", review);
    return { toServer, client };
  };

  const a = mk(() => ({ verdict: "reject" })); // the old, soon-to-drop supervisor
  await a.client.request("initialize", { protocolVersion: 1 });
  await a.client.request("authenticate", { token });

  const b = mk(() => ({ verdict: "approve" })); // the reconnection that displaces A
  await b.client.request("initialize", { protocolVersion: 1 });
  await b.client.request("authenticate", { token });
  assert.equal(await supervisor.supervise({ tool: "x", args: {} }), APPROVE, "B holds the seat after reconnect");

  a.toServer.end(); // A's stale socket finally closes
  await tick();

  assert.equal(await supervisor.supervise({ tool: "x", args: {} }), APPROVE, "B still decides — A's late close did not unbind it");
});

test("a review the agent never answers resolves to PASS on the seam's timeout", async () => {
  // The agent binds but stalls forever; the seam's own timeout must cover it so a
  // silent reviewer never hangs the gate.
  const supervisor = createExternalSupervisor({ timeoutMs: 20 });
  const toServer = new PassThrough();
  const toClient = new PassThrough();
  createSupervisorAcpPushServer({ input: toServer, output: toClient, supervisor, token: "t" });
  const client = createPeer({ input: toClient, output: toServer });
  client.on("supervisor/review", () => new Promise(() => {})); // never resolves
  await client.request("initialize", { protocolVersion: 1 });
  await client.request("authenticate", { token: "t" });

  // The seam's timer is unref'd (right for production, where the server holds the
  // loop open); keep one ref'd handle alive so this isolated test does not drain
  // the event loop before the 20ms deferral fires.
  const keepAlive = setInterval(() => {}, 1000);
  try {
    assert.equal(await supervisor.supervise({ tool: "x", args: {} }), PASS, "a stalled reviewer times out to a deferral");
  } finally {
    clearInterval(keepAlive);
  }
});

test("over real TCP: the token binds a supervising agent that decides end to end", async () => {
  const { startBridge } = await import("../src/bridge.js");
  const { connect } = await import("node:net");

  const bridge = await startBridge({
    agent: "claude",
    supervisorAcpPush: true,
    input: new PassThrough(),
    output: new PassThrough(),
    log: () => {},
  });
  try {
    assert.ok(bridge.supervisorAcpPushPort > 0, "the push endpoint bound a port");
    assert.ok(bridge.supervisorAcpPushToken, "a token was minted");

    const socket = connect(bridge.supervisorAcpPushPort, "127.0.0.1");
    await new Promise((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    const client = createPeer({ input: socket, output: socket });
    client.on("supervisor/review", () => ({ verdict: "approve" }));

    await client.request("initialize", { protocolVersion: 1 });

    // Before the token, nothing is bound: a decision falls through to the human.
    assert.equal(await bridge.supervisorPush.supervise({ tool: "x", args: {} }), PASS, "reaching the port is not authority");

    await client.request("authenticate", { token: bridge.supervisorAcpPushToken });
    assert.equal(
      await bridge.supervisorPush.supervise({ tool: "run_command", args: {} }),
      APPROVE,
      "the token makes it the decider, over the wire",
    );

    socket.destroy();
  } finally {
    await bridge.close();
  }
});

test("bridge.close() completes with a push supervisor still connected", async () => {
  const { startBridge } = await import("../src/bridge.js");
  const { connect } = await import("node:net");

  const bridge = await startBridge({
    agent: "claude",
    supervisorAcpPush: true,
    input: new PassThrough(),
    output: new PassThrough(),
    log: () => {},
  });
  const socket = connect(bridge.supervisorAcpPushPort, "127.0.0.1");
  await new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  await bridge.close();
  socket.destroy();
  assert.ok(true, "close resolved with a socket held open");
});
