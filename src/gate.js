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
