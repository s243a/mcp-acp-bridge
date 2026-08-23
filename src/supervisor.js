/**
 * A supervisor: a decider that sits between the policy and the human.
 *
 * The seam is the one `withPolicy` already leaves. When policy says neither
 * allow nor deny but *ask*, the question falls through to a decider — the human,
 * today. A supervisor is another implementation of that fall-through, so this is
 * a wrapper rather than new plumbing.
 *
 * It answers three ways, and the third is the whole point: **approve, reject, or
 * pass to the human.** A supervisor that must decide everything is one that will
 * be wrong about something; one that can defer handles the routine and escalates
 * what it does not recognise. The failure this is built to avoid is the
 * supervisor that quietly approves rather than admitting it is unsure — so an
 * unavailable supervisor, a malformed verdict, an unknown answer, and a timeout
 * all resolve to *pass to the human*, never to allow.
 *
 * Three ways to supply the verdict, the last two late-bound:
 *
 *   - **spawn** — a command run per decision, given the call on stdin, whose
 *     stdout is the verdict. Built here.
 *   - **mcp / acp** — a client that connected to the bridge and answers over
 *     that channel. Designed in `docs/supervisor.md`; this exposes the seam
 *     (`createExternalSupervisor`) they plug a queue into.
 *
 * @module supervisor
 */
import { spawn } from "node:child_process";

/** A verdict the supervisor could not produce is not an approval. */
export const PASS = "pass";
export const APPROVE = "approve";
export const REJECT = "reject";

/** A supervisor gets this long to answer before the human is asked instead. */
export const DEFAULT_SUPERVISOR_MS = 20_000;

/**
 * What an *absent* supervisor means — configured, but crashed, timed out, or
 * (in the late-binding modes) not yet connected.
 *
 * `human` is the default and the lenient posture: the agent keeps working,
 * reviewed by whoever is present, and if nobody is the gate timeout denies
 * anyway. `deny` is the strict posture — "nothing runs unwatched": while the
 * supervisor is not answering, refuse rather than fall through. This is the
 * choice for unattended operation where the supervisor is the *only* intended
 * reviewer, so its silence must not become the human's silence-then-timeout with
 * a longer window than you wanted.
 *
 * Note what neither option is: **approve**. An absent supervisor can send a call
 * to the human or refuse it; it can never let it through. That is not
 * configurable, because a supervisor that fails open is the one thing the whole
 * design exists to prevent.
 */
export const WHEN_ABSENT = { HUMAN: "human", DENY: "deny" };

/** Its answer, and how much of it we trust. */
const readVerdict = (raw) => {
  // The first token, not a prefix. `startsWith("approve")` accepted
  // `approveNOT` — a string-matching bug that fails toward *allow*, the wrong
  // direction for a component whose whole invariant is fail-closed. `approve
  // because it is a read` still works; `approvelol` no longer does.
  const word = String(raw ?? "").trim().toLowerCase().split(/\s/)[0];
  if (word === APPROVE) return APPROVE;
  if (word === REJECT) return REJECT;
  // Anything else — `pass`, empty, garbage — is a deferral. Unknown is not
  // consent.
  return PASS;
};

/**
 * Wrap a decider so a supervisor sees the call first.
 *
 * `decide` is the human fall-through this ultimately protects. `supervise` is
 * the supervisor: `(call) => Promise<"approve" | "reject" | "pass">`. Approve
 * and reject are final; pass hands the call to `decide`, unchanged.
 *
 * @param {(call: any) => Promise<string>} supervise
 * @param {(call: any) => Promise<{allow: boolean, reason?: string}>} decide
 * @param {{log?: (message: string) => void}} [options]
 */
export function withSupervisor(supervise, decide, { log = () => {}, whenAbsent = WHEN_ABSENT.HUMAN } = {}) {
  // A typo in the plumbing that silently turned strict back into lenient would
  // be a security downgrade nobody chose — so an unknown value is refused here,
  // where the operator can see it, rather than degraded.
  if (whenAbsent !== WHEN_ABSENT.HUMAN && whenAbsent !== WHEN_ABSENT.DENY) {
    throw new Error(`unknown whenAbsent '${whenAbsent}' — use 'human' or 'deny'`);
  }
  // An abstention resolves to whichever the operator chose — the human, or a
  // refusal — but never to an approval. `supervise` returns `pass` for every way
  // it could not decide, so this is where `pass` is interpreted.
  const onAbsent = (call) => {
    if (whenAbsent === WHEN_ABSENT.DENY) {
      return { allow: false, reason: "denied-by-policy: no supervisor available" };
    }
    return decide(call);
  };

  return async function supervisedDecide(call) {
    let verdict;
    try {
      verdict = readVerdict(await supervise(call));
    } catch (error) {
      // A supervisor that fails is a supervisor that abstains. It must never
      // fail *open*: the safe direction is what the operator chose, never allow.
      log(`[supervisor] abstained: ${error instanceof Error ? error.message : error}`);
      verdict = PASS;
    }

    if (verdict === APPROVE) {
      log(`[supervisor] approved ${call?.tool}`);
      return { allow: true, reason: "approved by supervisor" };
    }
    if (verdict === REJECT) {
      log(`[supervisor] rejected ${call?.tool}`);
      // A supervisor's refusal is not a person's — the agent should be told a
      // policy decided, not that a human refused, so it does not rescind on the
      // reviewer's behalf. `denied-by-policy` is the reason the message layer
      // reads as "no person saw this".
      return { allow: false, reason: "denied-by-policy: supervisor rejected" };
    }
    // `pass`: the supervisor abstained, deliberately or by failing. What that
    // means is the operator's choice — see `whenAbsent`.
    return onAbsent(call);
  };
}

/**
 * A supervisor that runs a command per decision.
 *
 * The call is written to the command's stdin as one JSON line; its stdout, read
 * to completion, is the verdict. Everything about *what* the command does — how
 * much of the conversation it reads, which model it asks, whether it is a script
 * or an agent — is behind that boundary, exactly as a declared command's body
 * is. What is fixed here is the contract: JSON in, `approve|reject|pass` out,
 * and silence means pass.
 *
 * @param {{
 *   command: string,
 *   args?: string[],
 *   timeoutMs?: number,
 *   spawnImpl?: typeof spawn,
 *   now?: () => number,
 * }} config
 */
export function createSpawnSupervisor({ command, args = [], timeoutMs = DEFAULT_SUPERVISOR_MS, spawnImpl = spawn }) {
  /** @param {any} call */
  return (call) =>
    new Promise((resolve) => {
      let settled = false;
      const finish = (verdict) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(verdict);
      };

      const child = spawnImpl(command, args, { stdio: ["pipe", "pipe", "pipe"] });
      let out = "";

      // The whole reason this exists: a supervisor that takes too long is one
      // the human should answer instead, and a slow supervisor must not become a
      // slow *deny*. It resolves to pass.
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        finish(PASS);
      }, timeoutMs);
      timer.unref?.();

      child.stdout?.on("data", (chunk) => (out += String(chunk)));
      child.on("error", () => finish(PASS));
      child.on("close", () => finish(out));

      // The call, redacted to what a verdict needs — a supervisor decides on the
      // tool and its arguments, not on the session's internals.
      try {
        child.stdin?.end(`${JSON.stringify({ tool: call?.tool, args: call?.args })}\n`);
      } catch {
        finish(PASS);
      }
    });
}

/**
 * A supervisor whose verdicts arrive out of band — the late-binding shape.
 *
 * A caller (an MCP tool the bridge exposes, an ACP client that connected)
 * registers a resolver; each decision is handed to it and awaits its answer,
 * bounded by the same timeout and the same fail-to-pass rule. Built as a seam
 * now; the MCP and ACP surfaces that feed it are designed in
 * `docs/supervisor.md`.
 *
 * @param {{timeoutMs?: number}} [options]
 */
export function createExternalSupervisor({ timeoutMs = DEFAULT_SUPERVISOR_MS } = {}) {
  /** @type {((call: any) => Promise<string>) | null} */
  let handler = null;
  // Bumped by every bind and unbind. A decision captures the generation it began
  // under and abstains if it changed — so a verdict from a handler that has been
  // released or replaced is discarded rather than honoured. Without this,
  // `unbind()` returned but a still-pending answer from the former seat-holder
  // could approve a call for up to the whole timeout: the seat was released, the
  // authority was not.
  let generation = 0;

  const supervise = (call) =>
    new Promise((resolve) => {
      const current = handler;
      const born = generation;
      if (!current) return resolve(PASS); // nobody bound — the human decides
      const timer = setTimeout(() => resolve(PASS), timeoutMs);
      timer.unref?.();
      const settle = (verdict) => {
        clearTimeout(timer);
        // The seat changed hands while this was pending: the answer is stale, so
        // abstain. Fail-closed, as the invariant demands.
        resolve(born === generation ? verdict : PASS);
      };
      Promise.resolve(current(call)).then(settle, () => settle(PASS));
    });

  return {
    supervise,
    /** The MCP/ACP surface calls this to become the decider. */
    bind: (fn) => {
      handler = fn;
      generation += 1;
    },
    unbind: () => {
      handler = null;
      generation += 1;
    },
  };
}
