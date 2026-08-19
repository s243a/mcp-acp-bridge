/**
 * Per-workspace MCP registration.
 *
 * Some agents take no MCP flag and read their servers from a workspace file.
 * agy reads `<workspace>/.gemini/settings.json`, which is what makes a
 * *per-session* endpoint possible for an agent with no per-session switch: the
 * workspace is the session boundary.
 *
 * This writes into the user's project, so it behaves like a guest. An existing
 * file is merged, never replaced; only our own server key is touched; and the
 * previous state is restored on release, including deleting a file we created.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/** The key we own inside `mcpServers`. Nothing else is ours to change. */
export const BRIDGE_SERVER_KEY = "mcp-acp-bridge";

export function mcpSettingsPath(workspace) {
  return join(workspace, ".gemini", "settings.json");
}

/**
 * Merge our server into an existing settings object without disturbing it.
 * Exported for tests: the merge is the part that must not lose a user's config.
 */
export function mergeBridgeServer(existing, { url, key = BRIDGE_SERVER_KEY }) {
  const base = existing && typeof existing === "object" ? existing : {};
  const servers = base.mcpServers && typeof base.mcpServers === "object" ? base.mcpServers : {};
  return {
    ...base,
    mcpServers: {
      ...servers,
      [key]: {
        url,
        type: "http",
        // The path token in the URL is the session secret; `trust` spares the
        // user a second approval for tools this bridge is already gating.
        trust: true,
      },
    },
  };
}

/** Remove our server, returning null when nothing of ours was there. */
export function removeBridgeServer(existing, key = BRIDGE_SERVER_KEY) {
  if (!existing?.mcpServers || !(key in existing.mcpServers)) return null;
  const { [key]: _removed, ...rest } = existing.mcpServers;
  return { ...existing, mcpServers: rest };
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Register this session's MCP endpoint in the workspace.
 *
 * @returns {{release: () => void}} restores exactly what was there before.
 */
export function registerWorkspaceMcp({ workspace, url, key = BRIDGE_SERVER_KEY, log = () => {} }) {
  const path = mcpSettingsPath(workspace);
  const existedBefore = existsSync(path);
  const original = existedBefore ? readFileSync(path, "utf8") : null;

  mkdirSync(dirname(path), { recursive: true });
  const merged = mergeBridgeServer(existedBefore ? readJson(path) : null, { url, key });
  writeFileSync(path, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
  log(`[workspace] registered MCP endpoint in ${path}`);

  let released = false;
  return {
    release() {
      if (released) return;
      released = true;
      try {
        if (!existedBefore) {
          // We created it; leave no trace in the user's project.
          rmSync(path, { force: true });
          log(`[workspace] removed ${path}`);
          return;
        }
        writeFileSync(path, original, "utf8");
        log(`[workspace] restored ${path}`);
      } catch (error) {
        log(`[workspace] could not restore ${path}: ${error?.message}`);
      }
    },
  };
}

/**
 * Guidance dropped into an isolated workspace.
 *
 * An agent handed tools with no explanation will reach for its built-ins first.
 * Saying what the tools are for — and that the directory is deliberately empty —
 * costs a few hundred tokens once and saves a confused turn.
 */
function agentsMarkdown(toolNames) {
  const list = toolNames.length
    ? toolNames.map((name) => `- \`${name}\``).join("\n")
    : "- (none advertised yet)";
  return `# Working in this session

This directory is intentionally empty. That is deliberate — it is not a broken
checkout.

Everything you need is exposed through the **mcp-acp-bridge** MCP server, which
is already registered for this workspace:

${list}

Those tools are reviewed before they run: a person may be asked to approve each
call, and may decline. A refusal is an answer, not an error — say what you were
trying to do and why, and let them decide rather than retrying or working around
it.

Prefer these tools over your built-in file and shell tools. The built-ins are
not connected to anything here.
`;
}

/**
 * Prepare the directory the agent will run in.
 *
 * `isolated` gives the agent an empty directory holding only the MCP
 * registration, so the obvious material for its built-in file tools is absent
 * and gated MCP tools are the path of least resistance.
 *
 * This is NOT a security boundary, and must not be described as one. Verified
 * against agy 1.1.13: with permissions skipped it read a file outside its
 * workspace by absolute path, and `--sandbox` did not prevent that either —
 * agy's sandbox restricts the terminal, not file access. Isolation shapes what
 * the agent reaches for; only OS-level confinement decides what it *can* reach.
 *
 * `project` runs in the caller's directory: richer context, at the cost of
 * prompt-free reads and writes there.
 *
 * @returns {{dir: string, release: () => void}}
 */
export function prepareWorkspace({
  mode = "project",
  projectDir,
  url,
  toolNames = [],
  key = BRIDGE_SERVER_KEY,
  log = () => {},
}) {
  if (mode !== "isolated") {
    const registration = registerWorkspaceMcp({ workspace: projectDir, url, key, log });
    // Deliberately no AGENTS.md here: the project may have its own, and
    // overwriting a user's instructions would be worse than staying quiet.
    return { dir: projectDir, release: registration.release };
  }

  const dir = mkdtempSync(join(tmpdir(), "acp-bridge-ws-"));
  registerWorkspaceMcp({ workspace: dir, url, key, log });
  writeFileSync(join(dir, "AGENTS.md"), agentsMarkdown(toolNames), "utf8");
  log(`[workspace] isolated workspace at ${dir}`);

  let released = false;
  return {
    dir,
    release() {
      if (released) return;
      released = true;
      try {
        rmSync(dir, { recursive: true, force: true });
        log(`[workspace] removed isolated workspace ${dir}`);
      } catch (error) {
        log(`[workspace] could not remove ${dir}: ${error?.message}`);
      }
    },
  };
}
