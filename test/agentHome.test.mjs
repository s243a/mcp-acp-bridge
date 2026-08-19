/**
 * Per-session agent HOME.
 *
 * The mechanism is verified live elsewhere; these tests guard the parts that
 * would quietly stop protecting anything: the rule syntax agy actually honours,
 * and that we mirror the real config rather than mutating it.
 */
import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { buildDenyRules, defaultDenyPaths, prepareAgentHome } from "../src/agentHome.js";

function fakeHome() {
  const home = mkdtempSync(join(tmpdir(), "fake-home-"));
  const cli = join(home, ".gemini", "antigravity-cli");
  mkdirSync(cli, { recursive: true });
  writeFileSync(join(cli, "antigravity-oauth-token"), "token", "utf8");
  writeFileSync(join(cli, "settings.json"), JSON.stringify({ model: "theirs" }), "utf8");
  return home;
}

test("rules use the action(target) syntax agy honours", () => {
  // read(...) and view_file(...) are silently ignored; read_file(...) is not.
  assert.deepEqual(buildDenyRules(["/tmp"]), ["read_file(/tmp)", "write_file(/tmp)"]);
});

test("defaults cover credentials and agent configuration", () => {
  const paths = defaultDenyPaths("/home/someone");
  assert.ok(paths.includes("/home/someone/.ssh"));
  assert.ok(paths.includes("/home/someone/.gemini"));
  assert.ok(paths.includes("/etc"));
});

test("the real settings file is never touched", () => {
  const home = fakeHome();
  const theirs = join(home, ".gemini", "antigravity-cli", "settings.json");
  const before = readFileSync(theirs, "utf8");

  const session = prepareAgentHome({ realHome: home, denyPaths: ["/tmp"] });
  assert.equal(readFileSync(theirs, "utf8"), before, "a user's settings are not ours to edit");

  const generated = JSON.parse(
    readFileSync(join(session.dir, ".gemini", "antigravity-cli", "settings.json"), "utf8"),
  );
  assert.deepEqual(generated.permissions.deny, ["read_file(/tmp)", "write_file(/tmp)"]);
  session.release();
});

test("credentials are mirrored by symlink, not copied", () => {
  const home = fakeHome();
  const session = prepareAgentHome({ realHome: home, denyPaths: [] });
  const token = join(session.dir, ".gemini", "antigravity-cli", "antigravity-oauth-token");

  assert.ok(lstatSync(token).isSymbolicLink(), "a copied credential is a credential left behind");
  session.release();
  assert.equal(existsSync(session.dir), false);
  assert.equal(existsSync(join(home, ".gemini", "antigravity-cli", "antigravity-oauth-token")), true,
    "releasing the session must not follow links into the real config");
});

test("no agy config to mirror means no override, not a broken environment", () => {
  const empty = mkdtempSync(join(tmpdir(), "no-agy-"));
  assert.equal(prepareAgentHome({ realHome: empty }), null);
});
