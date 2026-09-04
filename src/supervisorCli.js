/**
 * Translate the CLI's supervisor flags into bridge options.
 *
 * The absent-supervisor policy is independent of how the supervisor is
 * reached. In particular, MCP and ACP supervisors are late-bound and therefore
 * do not set `options.supervisor`; tying the policy to that field silently
 * changed `--require-supervisor` back to the human-fallback default.
 */
import { createSpawnSupervisor, WHEN_ABSENT } from "./supervisor.js";

/**
 * @param {{supervisor?: string, requireSupervisor?: boolean}} options
 * @param {{createSpawnSupervisorImpl?: typeof createSpawnSupervisor}} [deps]
 */
export function makeSupervisorCliOptions(
  options = {},
  { createSpawnSupervisorImpl = createSpawnSupervisor } = {},
) {
  const resolved = {
    whenSupervisorAbsent: options.requireSupervisor ? WHEN_ABSENT.DENY : WHEN_ABSENT.HUMAN,
  };

  if (options.supervisor) {
    resolved.supervisor = createSpawnSupervisorImpl({ command: options.supervisor, args: [] });
  }

  return resolved;
}
