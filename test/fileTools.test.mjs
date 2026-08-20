/**
 * File tools, and the boundary they are supposed to hold.
 *
 * The gate decides whether a write happens; confinement decides where it can
 * land. These test the second, because an approved write should still be unable
 * to escape the workspace — the reviewer said yes to a path, not to a target it
 * could not see.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { confineToWorkspace, createFileTools } from "../src/fileTools.js";

const workspace = () => mkdtempSync(join(tmpdir(), "acp-files-"));
const toolsFor = (root) => {
  const [read, write] = createFileTools({ resolveCwd: () => root });
  return { read, write };
};

test("a relative path resolves inside the workspace", () => {
  const root = workspace();
  const { path, error } = confineToWorkspace(root, "src/app.js");
  assert.equal(error, undefined);
  assert.ok(path.startsWith(root));
});

test("climbing out with .. is refused", () => {
  const root = workspace();
  const { error } = confineToWorkspace(root, "../escape.txt");
  assert.match(error, /outside the workspace/);
});

test("an absolute path elsewhere is refused", () => {
  const root = workspace();
  const { error } = confineToWorkspace(root, "/etc/passwd");
  assert.match(error, /outside the workspace/);
});

test("a symlink pointing out of the workspace is refused", () => {
  // The interesting case: the path *is* inside, and still resolves outside.
  const root = workspace();
  const outside = workspace();
  writeFileSync(join(outside, "secret.txt"), "secret", "utf8");
  symlinkSync(join(outside, "secret.txt"), join(root, "link.txt"));

  const { error } = confineToWorkspace(root, "link.txt");
  assert.match(error, /outside the workspace/);
});

test("a file that does not exist yet is judged by its directory", () => {
  const root = workspace();
  mkdirSync(join(root, "src"), { recursive: true });
  const { path, error } = confineToWorkspace(root, "src/new-file.js");
  assert.equal(error, undefined);
  assert.ok(path.startsWith(root));
});

test("reading returns the file, writing creates it and its parents", async () => {
  const root = workspace();
  const { read, write } = toolsFor(root);

  const wrote = await write.handler({ path: "deep/nested/note.md", content: "hello" }, {});
  assert.match(wrote, /Wrote 5 characters/);
  assert.equal(readFileSync(join(root, "deep/nested/note.md"), "utf8"), "hello");

  assert.equal(await read.handler({ path: "deep/nested/note.md" }, {}), "hello");
});

test("an escape is reported rather than performed", async () => {
  const root = workspace();
  const outside = workspace();
  const { read, write } = toolsFor(root);

  const target = join(outside, "canary.txt");
  const denied = await write.handler({ path: target, content: "CANARY" }, {});
  assert.match(denied, /outside the workspace/);
  assert.throws(() => readFileSync(target, "utf8"), "the write must not have happened");

  assert.match(await read.handler({ path: "/etc/hostname" }, {}), /outside the workspace/);
});

test("a missing file explains itself instead of throwing", async () => {
  const { read } = toolsFor(workspace());
  assert.match(await read.handler({ path: "absent.txt" }, {}), /could not read/);
});

test("a directory is not a file", async () => {
  const root = workspace();
  mkdirSync(join(root, "src"), { recursive: true });
  const { read } = toolsFor(root);
  assert.match(await read.handler({ path: "src" }, {}), /is a directory/);
});
