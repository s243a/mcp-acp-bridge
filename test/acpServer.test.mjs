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
function connect({ runTurn = async () => ({}), onSetModel, mayRemember } = {}) {
  const toServer = new PassThrough();
  const toClient = new PassThrough();

  const server = createAcpServer({ input: toServer, output: toClient, runTurn, onSetModel, mayRemember });
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
      // Nothing is rememberable unless a host says so, so the middle option is
      // absent here — see the tests below for both halves of that.
      PERMISSION_OPTIONS.filter((o) => o.optionId !== "allow-always").map((o) => o.optionId),
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
  // Only for tools a policy says may be remembered; the default is none.
  const { server, client } = connect({ mayRemember: () => true });
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

test("a failing turn closes as a refusal, never as a transport error", async () => {
  // A JSON-RPC error is not a turn outcome. Clients that only settle on a
  // result wait forever on a turn that already ended.
  const { client, updates } = connect({
    runTurn: async () => {
      throw new Error("agent exited 1");
    },
  });
  const sessionId = await newSession(client);

  const result = await client.request("session/prompt", {
    sessionId,
    prompt: [{ type: "text", text: "do a thing" }],
  });

  assert.equal(result.stopReason, "refusal");
  const said = updates
    .filter((u) => u.update.sessionUpdate === "agent_message_chunk")
    .map((u) => u.update.content.text)
    .join("");
  assert.match(said, /agent exited 1/, "the reason must reach the transcript");
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

test("a model choice is passed through to the agent", async () => {
  const seen = [];
  const { client } = connect({ onSetModel: (input) => seen.push(input) });
  const sessionId = await newSession(client);

  const response = await client.request("session/set_model", {
    sessionId,
    modelId: "gemini-3.7-pro",
  });

  // Only the agent knows what a model id means, so the surface just relays it.
  assert.deepEqual(response, {});
  assert.deepEqual(seen, [{ sessionId, modelId: "gemini-3.7-pro" }]);
});

test("a terminal-channel request is answerable, and says why it looks odd", async () => {
  const { server, client, updates } = connect();
  const sessionId = await newSession(client);

  let card = null;
  client.on("session/request_permission", (params) => {
    card = params.toolCall;
    return { outcome: { outcome: "selected", optionId: "allow-once" } };
  });

  const gate = makeGate((call) => server.decide(call));
  const decision = await gate({ sessionId, tool: "RunCommand", args: {}, viaTerminal: true });

  // The point of the channel: the user can still approve.
  assert.equal(decision.allow, true);

  // And is told the route was not the intended one.
  assert.match(card.title, /asked on the terminal/);
  const said = updates
    .map((update) => update.update?.content?.text ?? "")
    .join("");
  assert.match(said, /rather than through the tool channel/);
  assert.match(said, /permission rule no longer matches/);
});

test("an ordinary request carries no such notice", async () => {
  const { server, client, updates } = connect();
  const sessionId = await newSession(client);

  let card = null;
  client.on("session/request_permission", (params) => {
    card = params.toolCall;
    return { outcome: { outcome: "selected", optionId: "allow-once" } };
  });

  const gate = makeGate((call) => server.decide(call));
  await gate({ sessionId, tool: "RunCommand", args: {} });

  assert.equal(card.title, "RunCommand");
  const said = updates.map((update) => update.update?.content?.text ?? "").join("");
  assert.doesNotMatch(said, /tool channel/);
});

test("allow-always is withheld where it has no boundary", async () => {
  const confined = new Set(["read_file", "write_file"]);
  const { server, client } = connect({ mayRemember: ({ tool }) => confined.has(tool) });
  const sessionId = await newSession(client);

  /** @type {Record<string, string[]>} */
  const offered = {};
  client.on("session/request_permission", (params) => {
    offered[params.toolCall.title.split(" ")[0]] = params.options.map((o) => o.optionId);
    // Answer with it regardless of what was offered — a client may send
    // anything, so the question has to be asked again when recording.
    return { outcome: { outcome: "selected", optionId: "allow-always" } };
  });

  const gate = makeGate(server.decide);
  await gate({ sessionId, tool: "read_file", args: { path: "notes.md" } });
  await gate({ sessionId, tool: "run_command", args: { command: "ls -la" } });

  assert.ok(offered.read_file.includes("allow-always"), "a confined tool may be remembered");
  assert.ok(!offered.run_command.includes("allow-always"), "a shell has no boundary to remember");

  // And the unoffered answer was not honoured: the next command asks again.
  let askedAgain = false;
  client.on("session/request_permission", () => {
    askedAgain = true;
    return { outcome: { outcome: "selected", optionId: "reject-once" } };
  });
  await gate({ sessionId, tool: "run_command", args: { command: "rm -rf /" } });
  assert.equal(askedAgain, true, "answering allow-always for an unoffered tool must not stick");
});

test("a remembered allow does not outlive the policy that permitted it", async () => {
  let permitted = true;
  const { server, client } = connect({ mayRemember: () => permitted });
  const sessionId = await newSession(client);

  let asked = 0;
  client.on("session/request_permission", () => {
    asked += 1;
    return { outcome: { outcome: "selected", optionId: "allow-always" } };
  });

  const gate = makeGate(server.decide);
  await gate({ sessionId, tool: "read_file", args: {} });
  await gate({ sessionId, tool: "read_file", args: {} });
  assert.equal(asked, 1, "remembered while the policy permits it");

  // The session's policy is replaced — which per-origin policy makes ordinary.
  permitted = false;
  await gate({ sessionId, tool: "read_file", args: {} });
  assert.equal(asked, 2, "and asks again once it no longer would");
});
