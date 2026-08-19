/**
 * Workspace MCP registration.
 *
 * This writes into someone's project directory, so the tests are mostly about
 * restraint: never lose a config that was already there, never touch a key that
 * is not ours, and leave nothing behind on release.
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import {
  BRIDGE_SERVER_KEY,
  mcpSettingsPath,
  mergeBridgeServer,
  registerWorkspaceMcp,
  removeBridgeServer,
} from "../src/workspaceConfig.js";

const workspace = () => mkdtempSync(join(tmpdir(), "ws-cfg-"));
const read = (dir) => JSON.parse(readFileSync(mcpSettingsPath(dir), "utf8"));

test("merging keeps every server the user already had", () => {
  const merged = mergeBridgeServer(
    { mcpServers: { scirepl: { url: "http://localhost:8087/mcp", type: "http" } } },
    { url: "http://127.0.0.1:1/mcp/tok" },
  );
  assert.equal(merged.mcpServers.scirepl.url, "http://localhost:8087/mcp");
  assert.equal(merged.mcpServers[BRIDGE_SERVER_KEY].url, "http://127.0.0.1:1/mcp/tok");
});

test("merging preserves unrelated top-level settings", () => {
  const merged = mergeBridgeServer({ model: "some-model", trustedWorkspaces: ["/a"] }, { url: "u" });
  assert.equal(merged.model, "some-model");
  assert.deepEqual(merged.trustedWorkspaces, ["/a"]);
});

test("removing ours leaves the rest untouched", () => {
  const merged = mergeBridgeServer({ mcpServers: { other: { url: "x" } } }, { url: "u" });
  const cleaned = removeBridgeServer(merged);
  assert.deepEqual(Object.keys(cleaned.mcpServers), ["other"]);
});

test("removing reports nothing to do when our key is absent", () => {
  assert.equal(removeBridgeServer({ mcpServers: { other: {} } }), null);
});

test("registering in an empty workspace creates the file and release deletes it", () => {
  const dir = workspace();
  const handle = registerWorkspaceMcp({ workspace: dir, url: "http://127.0.0.1:9/mcp/tok" });

  assert.equal(read(dir).mcpServers[BRIDGE_SERVER_KEY].url, "http://127.0.0.1:9/mcp/tok");
  handle.release();
  assert.equal(existsSync(mcpSettingsPath(dir)), false, "a file we created must not be left behind");
});

test("an existing config is restored byte for byte on release", () => {
  const dir = workspace();
  const path = mcpSettingsPath(dir);
  mkdirSync(dirname(path), { recursive: true });
  const original = '{\n  "mcpServers": {\n    "scirepl": { "url": "http://localhost:8087/mcp" }\n  }\n}\n';
  writeFileSync(path, original, "utf8");

  const handle = registerWorkspaceMcp({ workspace: dir, url: "http://127.0.0.1:9/mcp/tok" });
  assert.ok(read(dir).mcpServers[BRIDGE_SERVER_KEY], "ours is present while the session runs");
  assert.ok(read(dir).mcpServers.scirepl, "theirs survives alongside");

  handle.release();
  assert.equal(readFileSync(path, "utf8"), original, "the user's file must come back unchanged");
});

test("release is idempotent", () => {
  const dir = workspace();
  const handle = registerWorkspaceMcp({ workspace: dir, url: "u" });
  handle.release();
  handle.release();
  assert.equal(existsSync(mcpSettingsPath(dir)), false);
});
