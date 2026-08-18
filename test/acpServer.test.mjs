/**
 * The ACP surface, exercised by a client peer wired over in-memory streams.
 *
 * The property under test is the translation both ways: a held tool call
 * becomes a permission request, and the client's answer becomes an allow or a
 * deny — including every way an answer can fail to be an approval.
 */
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { test } from "node:test";

import { createAcpServer, PERMISSION_OPTIONS } from "../src/acpServer.js";
import { createPeer } from "../src/jsonRpc.js";
import { makeGate } from "../src/gate.js";

/** Wire a server and a client peer to each other. */
function connect({ runTurn = async () => ({}) } = {}) {
  const toServer = new PassThrough();
  const toClient = new PassThrough();

  const server = createAcpServer({ input: toServer, output: toClient, runTurn });
  const client = createPeer({ input: toClient, output: toServer });
  const updates = [];
  client.on("session/update", (params) => updates.push(params));

  return { server, client, updates };
}

async function newSession(client) {
  await client.request("initialize", { protocolVersion: 1 });
  const { sessionId } = await client.request("session/new", { cwd: "/tmp" });
  return sessionId;
}

test("initialize does not claim a version above ours", async () => {
  const { client } = connect();
  const result = await client.request("initialize", { protocolVersion: 99 });
  assert.equal(result.protocolVersion, 1);
});

test("a held call becomes a permission request the client can allow", async () => {
  const { server, client, updates } = connect();
  const sessionId = await newSession(client);

  client.on("session/request_permission", (params) => {
    assert.equal(params.sessionId, sessionId);
    assert.deepEqual(
      params.options.map((o) => o.optionId),
      PERMISSION_OPTIONS.map((o) => o.optionId),
    );
    return { outcome: { outcome: "selected", optionId: "allow-once" } };
  });

  const gate = makeGate(server.decide);
  const decision = await gate({ sessionId, tool: "write_file", args: { path: "a.txt" } });

  assert.equal(decision.allow, true);
  const kinds = updates.map((u) => u.update.sessionUpdate);
  assert.deepEqual(kinds, ["tool_call", "tool_call_update"]);
  assert.equal(updates[1].update.status, "in_progress");
});

test("a denied answer blocks the call and marks it failed", async () => {
  const { server, client, updates } = connect();
  const sessionId = await newSession(client);

  client.on("session/request_permission", () => ({
    outcome: { outcome: "selected", optionId: "reject-once" },
  }));

  const decision = await makeGate(server.decide)({ sessionId, tool: "rm", args: {} });
  assert.equal(decision.allow, false);
  assert.equal(updates.at(-1).update.status, "failed");
});

test("a cancelled permission request is a denial", async () => {
  const { server, client } = connect();
  const sessionId = await newSession(client);
  client.on("session/request_permission", () => ({ outcome: { outcome: "cancelled" } }));

  const decision = await makeGate(server.decide)({ sessionId, tool: "rm", args: {} });
  assert.equal(decision.allow, false);
});

test("an unrecognised outcome is a denial, not an approval", async () => {
  const { server, client } = connect();
  const sessionId = await newSession(client);
  client.on("session/request_permission", () => ({ outcome: { outcome: "who knows" } }));

  const decision = await makeGate(server.decide)({ sessionId, tool: "rm", args: {} });
  assert.equal(decision.allow, false);
});

test("allow-always stops re-asking for the same tool", async () => {
  const { server, client } = connect();
  const sessionId = await newSession(client);

  let asked = 0;
  client.on("session/request_permission", () => {
    asked += 1;
    return { outcome: { outcome: "selected", optionId: "allow-always" } };
  });

  const gate = makeGate(server.decide);
  assert.equal((await gate({ sessionId, tool: "read_file", args: {} })).allow, true);
  assert.equal((await gate({ sessionId, tool: "read_file", args: {} })).allow, true);
  assert.equal(asked, 1, "second call must not re-ask");

  // A different tool is still gated.
  assert.equal((await gate({ sessionId, tool: "write_file", args: {} })).allow, true);
  assert.equal(asked, 2);
});

test("a turn streams assistant text as agent_message_chunk", async () => {
  const { client, updates } = connect({
    runTurn: async ({ emitText }) => {
      emitText("hello ");
      emitText("world");
      return { stopReason: "end_turn" };
    },
  });
  const sessionId = await newSession(client);

  const result = await client.request("session/prompt", {
    sessionId,
    prompt: [{ type: "text", text: "hi" }],
  });

  assert.equal(result.stopReason, "end_turn");
  const text = updates
    .filter((u) => u.update.sessionUpdate === "agent_message_chunk")
    .map((u) => u.update.content.text)
    .join("");
  assert.equal(text, "hello world");
});

test("prompting an unknown session is an invalid-params error", async () => {
  const { client } = connect();
  await client.request("initialize", {});
  await assert.rejects(
    () => client.request("session/prompt", { sessionId: "nope", prompt: [] }),
    /unknown session/,
  );
});

test("cancel ends the turn with stopReason cancelled", async () => {
  const { client } = connect({
    runTurn: ({ signal }) =>
      new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted")));
      }),
  });
  const sessionId = await newSession(client);

  const turn = client.request("session/prompt", {
    sessionId,
    prompt: [{ type: "text", text: "long job" }],
  });
  // Let the turn start before cancelling it.
  await new Promise((r) => setImmediate(r));
  client.notify("session/cancel", { sessionId });

  assert.equal((await turn).stopReason, "cancelled");
});
