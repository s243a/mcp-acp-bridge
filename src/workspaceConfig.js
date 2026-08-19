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
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
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
