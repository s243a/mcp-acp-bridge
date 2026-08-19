/**
 * A per-session agent HOME carrying generated deny rules.
 *
 * agy reads permissions from `$HOME/.gemini/antigravity-cli/settings.json`, and
 * those rules hold even under `--dangerously-skip-permissions` — verified on
 * 1.1.13, where a denied path returned BLOCKED while the workspace stayed fully
 * writable.
 *
 * Writing them into the user's real settings would be wrong twice over: it
 * mutates a file we do not own, and two concurrent sessions would fight over
 * it. So each session gets its own HOME instead — every entry symlinked from
 * the real one, except `settings.json`, which we generate. The agent keeps its
 * credentials and caches; only the rules change.
 *
 * Note the limits before relying on this. It is a DENYLIST: it blocks what you
 * name, and cannot express "only the workspace". A path nobody thought to deny
 * is permitted. For a real boundary, put the whole process inside an OS-level
 * sandbox; this is defence in depth for the paths that would hurt most.
 */
import { existsSync, mkdirSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const AGY_CONFIG_DIR = ".gemini";
const AGY_CLI_DIR = "antigravity-cli";

/**
 * Paths worth denying by default: credentials, shell and agent configuration,
 * and the places secrets habitually live. Deliberately short — a default that
 * broke ordinary work would be turned off, and then protect nothing.
 */
export function defaultDenyPaths(home = homedir()) {
  return [
    join(home, ".ssh"),
    join(home, ".aws"),
    join(home, ".config"),
    join(home, ".gnupg"),
    join(home, ".netrc"),
    join(home, ".gemini"),
    "/etc",
  ];
}

/** agy's rule syntax is `action(target)`; a directory target is recursive. */
export function buildDenyRules(paths) {
  return paths.flatMap((path) => [`read_file(${path})`, `write_file(${path})`]);
}

/**
 * @returns {{dir: string, release: () => void} | null} null when the real HOME
 * has no agy configuration to mirror, in which case the caller should run
 * without an override rather than hand the agent a broken environment.
 */
export function prepareAgentHome({
  realHome = homedir(),
  denyPaths = defaultDenyPaths(realHome),
  extraSettings = {},
  log = () => {},
} = {}) {
  const sourceCli = join(realHome, AGY_CONFIG_DIR, AGY_CLI_DIR);
  if (!existsSync(sourceCli)) {
    log(`[home] no agy config at ${sourceCli}; running with the inherited HOME`);
    return null;
  }

  const dir = mkdtempAgentHome();
  const targetCli = join(dir, AGY_CONFIG_DIR, AGY_CLI_DIR);
  mkdirSync(targetCli, { recursive: true });

  // Mirror by symlink so the agent keeps its credentials, caches and
  // conversation history; only settings.json is ours.
  linkChildren(join(realHome, AGY_CONFIG_DIR), join(dir, AGY_CONFIG_DIR), [AGY_CLI_DIR]);
  linkChildren(sourceCli, targetCli, ["settings.json"]);

  const settings = {
    ...extraSettings,
    permissions: {
      ...(extraSettings.permissions ?? {}),
      deny: [...buildDenyRules(denyPaths), ...(extraSettings.permissions?.deny ?? [])],
    },
  };
  writeFileSync(join(targetCli, "settings.json"), `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  log(`[home] session HOME ${dir} denying ${denyPaths.length} paths`);

  let released = false;
  return {
    dir,
    release() {
      if (released) return;
      released = true;
      try {
        // Only symlinks and one generated file live here, so removing the tree
        // cannot reach the real configuration it points at.
        rmSync(dir, { recursive: true, force: true });
      } catch (error) {
        log(`[home] could not remove ${dir}: ${error?.message}`);
      }
    },
  };
}

function mkdtempAgentHome() {
  const dir = join(tmpdir(), `acp-bridge-home-${Math.random().toString(36).slice(2, 10)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function linkChildren(from, to, skip) {
  if (!existsSync(from)) return;
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from)) {
    if (skip.includes(entry)) continue;
    try {
      symlinkSync(join(from, entry), join(to, entry));
    } catch {
      // An entry that cannot be linked is not worth failing the session over.
    }
  }
}
