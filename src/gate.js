/**
 * The permission gate.
 *
 * Every tool call the agent makes is held here until a decider answers. In the
 * real bridge the decider raises an ACP `session/request_permission` and waits
 * for the client; in tests it is a plain function.
 *
 * Two rules are load-bearing and must not be relaxed:
 *   - a decision that does not arrive in time is a DENY, never an allow;
 *   - a decider that throws is a DENY, so a broken client cannot open the gate.
 */

export const DEFAULT_TIMEOUT_MS = 120_000;

/** Reasons a call was denied, for logs and for the message handed to the agent. */
export const DenyReason = {
  CLIENT: "denied-by-client",
  TIMEOUT: "no-decision-before-timeout",
  ERROR: "decider-failed",
};

/**
 * Wrap a decider into a gate function.
 *
 * @param {(call: {sessionId: string, tool: string, args: unknown}) =>
 *          Promise<{allow: boolean, reason?: string}>} decide
 * @param {{timeoutMs?: number, onDecision?: Function}} [options]
 */
export function makeGate(decide, options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const onDecision = options.onDecision;

  return async function gate(call) {
    let verdict;
    try {
      verdict = await withTimeout(decide(call), timeoutMs);
    } catch (error) {
      verdict =
        error instanceof GateTimeout
          ? { allow: false, reason: DenyReason.TIMEOUT }
          : { allow: false, reason: `${DenyReason.ERROR}: ${error?.message ?? error}` };
    }

    // A decider returning nothing, or a non-object, is not an approval.
    const decision =
      verdict && typeof verdict === "object" && verdict.allow === true
        ? { allow: true, reason: verdict.reason }
        : { allow: false, reason: verdict?.reason ?? DenyReason.CLIENT };

    onDecision?.({ ...call, ...decision });
    return decision;
  };
}

/**
 * What the agent is told when a call does not go through.
 *
 * The distinction that matters is whether a *person* refused. A terse
 * "permission denied" reads to an agent as a failure worth working around, and
 * it does: a denied `find … -name '*.md'` came straight back with double quotes
 * instead of single, asking a second time for the same thing. A refusal is not
 * a syntax error, and re-asking spends the reviewer's attention rather than the
 * agent's. A timeout is genuinely different — nobody said no — so it is the one
 * case where trying again is reasonable.
 *
 * @param {string | undefined} reason
 */
export function denialMessage(reason) {
  const detail = reason ?? DenyReason.CLIENT;
  if (detail.startsWith(DenyReason.TIMEOUT)) {
    return `No decision arrived in time (${detail}). Nobody refused; you may try once more.`;
  }
  if (detail.startsWith(DenyReason.ERROR)) {
    return `The reviewer could not be reached (${detail}). Do not retry; report this to the user.`;
  }
  return (
    `A human reviewer refused this call (${detail}). Do not run it again, and do not retry a ` +
    `reworded or requoted variant — the answer will be the same. Say what you were trying to ` +
    `achieve and ask the user how they would like to proceed.`
  );
}

class GateTimeout extends Error {}

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new GateTimeout()), ms);
    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** A gate that allows everything. Tests and local development only. */
export const allowAll = makeGate(async () => ({ allow: true }));

/** A gate that denies everything, with the reason surfaced to the agent. */
export const denyAll = makeGate(async () => ({ allow: false, reason: "denied by policy" }));
