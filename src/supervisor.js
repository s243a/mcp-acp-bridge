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

/** Its answer, and how much of it we trust. */
const readVerdict = (raw) => {
  const value = String(raw ?? "").trim().toLowerCase();
  if (value.startsWith(APPROVE)) return APPROVE;
  if (value.startsWith(REJECT)) return REJECT;
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
export function withSupervisor(supervise, decide, { log = () => {} } = {}) {
  return async function supervisedDecide(call) {
    let verdict;
    try {
      verdict = readVerdict(await supervise(call));
    } catch (error) {
      // A supervisor that fails is a supervisor that abstains. It must never
      // fail *open*: the safe direction is the human, not allow.
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
    return decide(call);
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

  const supervise = (call) =>
    new Promise((resolve) => {
      if (!handler) return resolve(PASS); // nobody bound yet — the human decides
      const timer = setTimeout(() => resolve(PASS), timeoutMs);
      timer.unref?.();
      Promise.resolve(handler(call)).then(
        (verdict) => {
          clearTimeout(timer);
          resolve(verdict);
        },
        () => {
          clearTimeout(timer);
          resolve(PASS);
        },
      );
    });

  return {
    supervise,
    /** The MCP/ACP surface calls this to become the decider. */
    bind: (fn) => {
      handler = fn;
    },
    unbind: () => {
      handler = null;
    },
  };
}
