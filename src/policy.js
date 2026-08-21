/**
 * Permission policy for gated tool calls.
 *
 * Asking a human about every call is unusable — a subagent doing forty reads
 * becomes forty prompts nobody can meaningfully answer. Asking about none is
 * not a gate at all. The policy sits between: decide by *consequence*, so reads
 * flow and writes, commands and network stop for a human.
 *
 * Three verdicts, and the naming is deliberate:
 *   allow — proceed without asking
 *   ask   — raise a permission request and wait
 *   deny  — refuse without asking
 *
 * Everything unmatched is `ask`. A policy that cannot classify a call must not
 * silently permit it, and a malformed config falls back to asking about
 * everything rather than inheriting whatever the file happened to contain.
 */

import { DenyReason } from "./gate.js";

export const VERDICTS = new Set(["allow", "ask", "deny"]);

/**
 * Read-only tools common across coding agents. Used by the `reads` preset;
 * matching is on the tool name the agent actually calls, so this is a
 * convenience list rather than a security boundary.
 */
export const COMMON_READ_TOOLS = [
  "view_file",
  "read_file",
  "list_dir",
  "list_resources",
  "grep",
  "grep_search",
  "find_by_name",
  "read_resource",
];

export const PRESETS = {
  /** Ask about everything. The safe default and the supervision posture. */
  "review-everything": { rules: [], default: "ask" },
  /** Let reads through; stop for anything that changes something. */
  "review-consequential": {
    rules: [{ tools: COMMON_READ_TOOLS, action: "allow" }],
    default: "ask",
  },
  /** Approve everything. Only sensible when something else is the gate. */
  "allow-all": { rules: [], default: "allow" },
};

/** `write_*` matches a rule of `write_`; `*` matches anything. */
function matches(pattern, tool) {
  if (pattern === "*") return true;
  if (pattern.endsWith("*")) return tool.startsWith(pattern.slice(0, -1));
  return pattern === tool;
}

/**
 * Build a policy from a preset name, an explicit object, or both.
 *
 * @param {string|{rules?: Array, default?: string}} [source]
 * @param {{log?: (msg: string) => void}} [options]
 */
export function makePolicy(source, options = {}) {
  const log = options.log ?? (() => {});
  let config;

  if (typeof source === "string") {
    config = PRESETS[source];
    if (!config) {
      log(`[policy] unknown preset '${source}', falling back to review-everything`);
      config = PRESETS["review-everything"];
    }
  } else if (source && typeof source === "object") {
    config = source;
  } else {
    config = PRESETS["review-everything"];
  }

  const rules = Array.isArray(config.rules) ? config.rules : [];
  const fallback = VERDICTS.has(config.default) ? config.default : "ask";
  if (config.default !== undefined && !VERDICTS.has(config.default)) {
    log(`[policy] invalid default '${config.default}', using ask`);
  }

  /** @returns {{verdict: "allow"|"ask"|"deny", reason: string}} */
  function decide(call) {
    const tool = String(call?.tool ?? "");
    for (const rule of rules) {
      if (!VERDICTS.has(rule?.action)) continue;
      const patterns = Array.isArray(rule.tools) ? rule.tools : [rule.tools];
      if (patterns.some((pattern) => typeof pattern === "string" && matches(pattern, tool))) {
        // The prefix wraps a custom reason rather than being replaced by one:
        // without it a rule carrying its own text fell through to the
        // human-refusal branch, and the agent was told a person had refused.
        return {
          verdict: rule.action,
          reason: `${DenyReason.POLICY}: ${rule.reason ?? `rule for ${tool}`}`,
        };
      }
    }
    return { verdict: fallback, reason: `${DenyReason.POLICY}: default (${fallback})` };
  }

  return { decide, describe: () => ({ rules, default: fallback }) };
}

/**
 * Wrap a decider so the policy runs first.
 *
 * `allow` and `deny` never reach the human — that is the entire point — while
 * `ask` defers to the underlying decider, which is what raises the ACP request.
 */
export function withPolicy(policyOrResolver, decide, { onDecision } = {}) {
  // A resolver lets each session carry its own policy, which is what makes the
  // review setting changeable per turn rather than fixed at startup.
  const resolve =
    typeof policyOrResolver === "function" ? policyOrResolver : () => policyOrResolver;

  return async function policyAwareDecide(call) {
    const { verdict, reason } = resolve(call).decide(call);
    if (verdict === "allow") {
      onDecision?.({ ...call, verdict, reason });
      return { allow: true, reason };
    }
    if (verdict === "deny") {
      onDecision?.({ ...call, verdict, reason });
      return { allow: false, reason };
    }
    onDecision?.({ ...call, verdict, reason });
    return decide(call);
  };
}
