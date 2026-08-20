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
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const AGY_CONFIG_DIR = ".gemini";
const AGY_CLI_DIR = "antigravity-cli";
/**
 * Interactive agy reads MCP servers from here, NOT from the workspace's
 * settings.json — verified from agy's own log, which reports
 * "Failed to extract MCP specs from file://$HOME/.gemini/config/mcp_config.json".
 * Print mode reads the workspace file; interactive mode does not.
 */
const AGY_SHARED_CONFIG_DIR = "config";
const AGY_MCP_CONFIG = "mcp_config.json";

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
  trustedWorkspaces = [],
  mcpServers = null,
  allowRules = [],
  denyRules = [],
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
  linkChildren(join(realHome, AGY_CONFIG_DIR), join(dir, AGY_CONFIG_DIR), [
    AGY_CLI_DIR,
    ...(mcpServers ? [AGY_SHARED_CONFIG_DIR] : []),
  ]);
  if (mcpServers) writeSharedMcpConfig({ realHome, dir, mcpServers, log });
  linkChildren(sourceCli, targetCli, ["settings.json"]);

  const settings = {
    ...extraSettings,
    // A workspace agy does not trust is one whose .gemini/settings.json it
    // ignores — including the MCP servers registered there. Interactive
    // sessions then report "MCP Tools: none configured" and the turn has no way
    // to arrive.
    ...(trustedWorkspaces.length
      ? { trustedWorkspaces: [...new Set([...(extraSettings.trustedWorkspaces ?? []), ...trustedWorkspaces])] }
      : {}),
    permissions: {
      ...(extraSettings.permissions ?? {}),
      // Interactive agy prompts for every MCP call and blocks until answered,
      // which nothing on our side can do. Rules take the form
      // `mcp(<server>/<tool>)`, matching agy's own `mcp(chrome-devtools/*)`.
      // These apply in interactive mode only: headless auto-denies instead.
      ...(allowRules.length || extraSettings.permissions?.allow
        ? { allow: [...allowRules, ...(extraSettings.permissions?.allow ?? [])] }
        : {}),
      // Denying a built-in is what makes an MCP equivalent authoritative:
      // told to prefer a tool, an agent may still reach for its own, and only
      // a rule stops it. Deny wins over allow, and holds even where
      // permissions are otherwise skipped.
      deny: [
        ...buildDenyRules(denyPaths),
        ...denyRules,
        ...(extraSettings.permissions?.deny ?? []),
      ],
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

/**
 * Write the shared MCP config interactive agy actually reads.
 *
 * The user's own file is merged in when it parses — and quietly skipped when it
 * does not, which is worth knowing about: a JSON comment in that file makes agy
 * load no MCP servers at all, silently, for every interactive session.
 */
function writeSharedMcpConfig({ realHome, dir, mcpServers, log }) {
  const sourceDir = join(realHome, AGY_CONFIG_DIR, AGY_SHARED_CONFIG_DIR);
  const targetDir = join(dir, AGY_CONFIG_DIR, AGY_SHARED_CONFIG_DIR);
  mkdirSync(targetDir, { recursive: true });
  // Keep the rest of the shared config; only mcp_config.json is ours.
  linkChildren(sourceDir, targetDir, [AGY_MCP_CONFIG]);

  let existing = {};
  try {
    existing = JSON.parse(readFileSync(join(sourceDir, AGY_MCP_CONFIG), "utf8"));
  } catch (error) {
    if (existsSync(join(sourceDir, AGY_MCP_CONFIG))) {
      log(`[home] ignoring unparseable ${AGY_MCP_CONFIG}: ${error?.message}`);
    }
  }

  const merged = {
    ...existing,
    mcpServers: { ...(existing.mcpServers ?? {}), ...mcpServers },
  };
  writeFileSync(join(targetDir, AGY_MCP_CONFIG), `${JSON.stringify(merged, null, 2)}\n`, "utf8");
  log(`[home] wrote shared MCP config with ${Object.keys(mcpServers).join(", ")}`);
}
