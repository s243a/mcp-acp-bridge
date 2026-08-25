/**
 * agy stream-json translation.
 *
 * Fixtures are real lines captured from agy 1.1.13. The rule under test is that
 * anything not understood becomes null rather than a guess — a client showing
 * invented tool activity is worse than one showing none.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { buildInitialPrompt, getAdapter, MAX_RULES_CHARS, parseAgyLine, workspaceRules } from "../src/agents.js";

test("assistant text becomes a text record", () => {
  const record = parseAgyLine(
    JSON.stringify({
      event: "step_update",
      step_update: { step_index: 2, state: "DONE", step_type: "agent_response", text_delta: "banana\n" },
    }),
  );
  assert.deepEqual(record, { kind: "text", text: "banana\n" });
});

test("an agent_response carrying only usage is not a text event", () => {
  const record = parseAgyLine(
    JSON.stringify({
      event: "step_update",
      step_update: { step_index: 2, state: "DONE", step_type: "agent_response", usage: { total_tokens: 5 } },
    }),
  );
  assert.equal(record, null);
});

test("a tool step carries its name, arguments and status", () => {
  const record = parseAgyLine(
    JSON.stringify({
      event: "step_update",
      step_update: {
        step_index: 3,
        state: "ACTIVE",
        step_type: "tool",
        tool_name: "write_to_file",
        tool_info: { name: "write_to_file", parameters: { TargetFile: "/tmp/x/hello.txt" } },
      },
    }),
  );
  assert.equal(record.kind, "tool");
  assert.equal(record.name, "write_to_file");
  assert.equal(record.status, "in_progress");
  assert.deepEqual(record.args, { TargetFile: "/tmp/x/hello.txt" });
});

test("the ACTIVE and DONE halves of one call share an id", () => {
  const line = (state) =>
    JSON.stringify({
      event: "step_update",
      step_update: { step_index: 3, state, step_type: "tool", tool_name: "write_to_file" },
    });
  const active = parseAgyLine(line("ACTIVE"));
  const done = parseAgyLine(line("DONE"));
  assert.equal(active.id, done.id, "a client must be able to update the same call");
  assert.equal(done.status, "completed");
});

test("the result reports success and keeps the agent's own status", () => {
  const record = parseAgyLine(
    JSON.stringify({
      event: "result",
      result: { status: "SUCCESS", response: "done\n", usage: { total_tokens: 10 } },
    }),
  );
  assert.equal(record.kind, "result");
  assert.equal(record.ok, true);
  assert.equal(record.text, "done\n");
  assert.equal(record.agentStatus, "SUCCESS");
});

test("the agent's status is never presented as an ACP stop reason", () => {
  // ACP accepts only these; forwarding "success" leaves a validating client
  // waiting forever on a prompt that already finished.
  const ACP_STOP_REASONS = new Set([
    "end_turn",
    "cancelled",
    "max_tokens",
    "max_turn_requests",
    "refusal",
  ]);
  for (const status of ["SUCCESS", "ERROR", "CANCELLED"]) {
    const record = parseAgyLine(
      JSON.stringify({ event: "result", result: { status, response: "" } }),
    );
    assert.equal(record.stopReason, undefined, "must not claim an ACP stop reason");
    assert.equal(ACP_STOP_REASONS.has(record.agentStatus), false);
  }
});

test("a non-success result is not reported as ok", () => {
  const record = parseAgyLine(
    JSON.stringify({ event: "result", result: { status: "ERROR", response: "" } }),
  );
  assert.equal(record.ok, false);
});

test("unparseable and unknown lines are dropped, never guessed at", () => {
  assert.equal(parseAgyLine("not json"), null);
  assert.equal(parseAgyLine(JSON.stringify({ event: "something_new" })), null);
  assert.equal(
    parseAgyLine(JSON.stringify({ event: "step_update", step_update: { step_type: "checkpoint" } })),
    null,
  );
});

test("an initial prompt rides in argv so the first turn is never typed", () => {
  const dual = getAdapter("agy-dual");
  assert.deepEqual(dual.buildSessionArgs({ cwd: "/w" }), ["--add-dir", "/w"]);
  assert.deepEqual(
    dual.buildSessionArgs({ cwd: "/w", initialPrompt: "go" }),
    ["--add-dir", "/w", "-i", "go"],
    "-i runs the prompt and keeps the session interactive",
  );
});

test("dual mode grants the built-ins it cannot be asked about, and no more", () => {
  const granted = getAdapter("agy-dual").autoApprove;

  // A confirmation agy raises for its own tools has no one to answer it.
  assert.ok(granted.includes("command(*)"));
  assert.ok(granted.includes("read_file(*)"));
  assert.ok(granted.includes("write_file(*)"));

  // The riskier verbs still stop, which a blanket skip would not do.
  for (const verb of ["unsandboxed(*)", "escalate_admin(*)", "execute_url(*)"]) {
    assert.ok(!granted.includes(verb), `${verb} should still require approval`);
  }
});

test("the initial prompt carries the workspace's rules, so reading them costs no tool call", () => {
  const files = { "/w/GEMINI.md": "# Rules\nFence command output." };
  const readFile = (path) => {
    if (!(path in files)) throw new Error("ENOENT");
    return files[path];
  };

  const prompt = buildInitialPrompt("NUDGE.", "/w", { readFile });
  assert.match(prompt, /GEMINI\.md for this workspace/);
  assert.match(prompt, /Fence command output\./);
  assert.ok(prompt.endsWith("NUDGE."), "the task instruction stays last");

  // AGENTS.md is the fallback name, and absence is not an error: a workspace
  // without rules gets the bare nudge rather than a failed session.
  delete files["/w/GEMINI.md"];
  files["/w/AGENTS.md"] = "# Other";
  assert.match(buildInitialPrompt("NUDGE.", "/w", { readFile }), /AGENTS\.md for this workspace/);

  delete files["/w/AGENTS.md"];
  assert.equal(buildInitialPrompt("NUDGE.", "/w", { readFile }), "NUDGE.");
});

test("oversized rules are truncated rather than pushed whole into argv", () => {
  const readFile = () => "x".repeat(MAX_RULES_CHARS + 500);
  const rules = workspaceRules("/w", { readFile });
  assert.equal(rules.truncated, true);
  assert.ok(rules.text.length < MAX_RULES_CHARS + 20);
  assert.match(rules.text, /truncated/);
});

// --- codex adapter (print-mode, MCP endpoint injected as a config override) ---

test("codex is a selectable print-mode adapter", () => {
  const codex = getAdapter("codex");
  assert.equal(codex.command, "codex");
  assert.equal(typeof codex.buildArgs, "function");
  assert.equal(typeof codex.parseLine, "function");
});

test("codex-mcp is a selectable mcp-server adapter (bridge is codex's MCP client)", () => {
  const cx = getAdapter("codex-mcp");
  assert.equal(cx.command, "codex");
  assert.equal(cx.mcpServer, true);
  assert.equal(cx.sandbox, "workspace-write");
  assert.equal(cx.approvalPolicy, "untrusted");
});

test("codex buildArgs injects the bridge MCP endpoint from the mcpConfig url", () => {
  const codex = getAdapter("codex");
  const mcpConfig = JSON.stringify({ mcpServers: { bridge: { type: "http", url: "http://127.0.0.1:9000/mcp" } } });
  const args = codex.buildArgs({ prompt: "hi", mcpConfig });
  assert.deepEqual(args.slice(0, 5), ["exec", "--json", "--color", "never", "--skip-git-repo-check"]);
  // The HTTP endpoint is a `-c` TOML override, not a config file — codex's form.
  assert.ok(args.includes('mcp_servers.bridge.url="http://127.0.0.1:9000/mcp"'), "endpoint injected as -c override");
  assert.ok(args.includes("mcp_servers.bridge.enabled=true"));
  assert.ok(args.includes("read-only"), "restrictToMcp confines codex's own shell");
  assert.equal(args[args.length - 1], "hi", "the prompt is the final arg");
});

test("codex buildArgs still runs with no usable endpoint", () => {
  const codex = getAdapter("codex");
  const args = codex.buildArgs({ prompt: "hi", mcpConfig: "not json" });
  assert.ok(!args.some((a) => a.startsWith("mcp_servers")), "no MCP override without a url");
  assert.equal(args[args.length - 1], "hi");
});

test("codex parseLine: agent_message is the answer, turn.completed ends it, noise is null", () => {
  const codex = getAdapter("codex");
  // Lines captured from a real `codex exec --json` run.
  assert.equal(codex.parseLine('{"type":"thread.started","thread_id":"x"}'), null);
  assert.equal(codex.parseLine('{"type":"turn.started"}'), null);
  assert.deepEqual(
    codex.parseLine('{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"PONG"}}'),
    { kind: "text", text: "PONG" },
  );
  assert.deepEqual(codex.parseLine('{"type":"turn.completed","usage":{"input_tokens":5,"output_tokens":1}}'), {
    kind: "result",
    ok: true,
    usage: { input_tokens: 5, output_tokens: 1 },
  });
  assert.equal(codex.parseLine("not json"), null);
});
