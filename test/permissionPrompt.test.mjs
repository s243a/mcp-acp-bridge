/**
 * Reading a permission prompt off the terminal.
 *
 * The second permission channel: tools the bridge never sees, and grants that
 * quietly stop matching, both surface here as a prompt agy is blocked on. The
 * risk is answering one that is only half painted, so these tests pin when a
 * prompt counts as readable.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { parsePermissionPrompt } from "../src/ptySession.js";

const ESC = "\u001b";

/** The prompt as agy actually renders it, escapes and all. */
const PERMISSION_SCREEN = [
  `${ESC}[33m●${ESC}[m ${ESC}[33;1mCallMcpTool${ESC}[37;22m()${ESC}[m`,
  `${ESC}[33;1mMCP${ESC}[m`,
  `${ESC}[90m──────────────────────────────────────────────${ESC}[m`,
  `${ESC}[37mmcp-acp-bridge/next_task${ESC}[m`,
  "",
  `${ESC}[1mDo you want to proceed?${ESC}[m`,
  `${ESC}[94m> 1. Yes${ESC}[m`,
  "  2. Yes, and always allow 'mcp-acp-bridge/next_task' in this conversation",
  "  3. Yes, and always allow 'mcp-acp-bridge/next_task' (Persist to settings.json)",
  "  4. No",
  "  5. No, and always deny 'mcp-acp-bridge/next_task' in this conversation",
  "  6. No, and always deny 'mcp-acp-bridge/next_task' (Persist to settings.json)",
].join("\r\n");

test("a permission prompt is read as a tool and its choices", () => {
  const prompt = parsePermissionPrompt(PERMISSION_SCREEN);

  assert.equal(prompt.tool, "mcp-acp-bridge/next_task");
  assert.deepEqual(
    prompt.options.map((option) => [option.digit, option.kind]),
    [
      ["1", "allow"],
      ["2", "allow_always"],
      ["3", "allow_always"],
      ["4", "deny"],
      ["5", "deny_always"],
      ["6", "deny_always"],
    ],
  );
});

test("a half-painted prompt is not answered", () => {
  // A TUI paints in pieces. Pressing a digit against a partial prompt presses
  // whatever lands on that digit a moment later.
  const partial = PERMISSION_SCREEN.split("  4. No")[0];
  assert.equal(parsePermissionPrompt(partial), null);
});

test("no prompt on screen is not a prompt", () => {
  assert.equal(parsePermissionPrompt(`? for shortcutsGemini 3.7 Flash · high`), null);
  assert.equal(parsePermissionPrompt(""), null);
});

test("a built-in tool is named the same way an MCP one is", () => {
  // The built-ins are the channel's reason to exist: they never reach the gate.
  const screen = PERMISSION_SCREEN.replaceAll("mcp-acp-bridge/next_task", "RunCommand");
  assert.equal(parsePermissionPrompt(screen).tool, "RunCommand");
});

test("the newest prompt wins when an older one is still in the buffer", () => {
  const older = PERMISSION_SCREEN.replaceAll("mcp-acp-bridge/next_task", "read_file");
  const prompt = parsePermissionPrompt(`${older}\r\n${PERMISSION_SCREEN}`);
  assert.equal(prompt.tool, "mcp-acp-bridge/next_task");
});
