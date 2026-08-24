/**
 * The ACP supervisor, *push* shape — the bridge asks, the agent answers.
 *
 * The pull surface (`supervisorAcp.js`) has the supervising agent poll
 * `supervisor/pending` and post `supervisor/decide` against the seat's queue.
 * This is the other way round and the more agent-idiomatic one: each decision
 * the gate defers becomes a `supervisor/review` **request** the bridge sends to
 * the agent, and the agent's reply is the verdict — exactly how the bridge
 * already raises `session/request_permission` to an ACP client.
 *
 * It sits on `createExternalSupervisor` (the push seam) rather than the seat: on
 * authentication the connection *becomes* the decider (`bind`), and its close
 * releases it (`unbind`). The seam's generation token means a verdict still in
 * flight when the supervisor drops is discarded, not honoured — fail-closed, as
 * the whole design demands. A verdict the agent never sends resolves to PASS on
 * the seam's own timeout, so a slow or silent reviewer never hangs the gate.
 *
 * Same door credential as the pull surface: reaching the loopback port is not
 * authority, since the supervised agent can reach it too — the connection binds
 * as the decider only after presenting the token the bridge printed to its
 * console, which the agent cannot read.
 *
 * @module supervisorAcpPush
 */
import { createPeer } from "./jsonRpc.js";
import { PROTOCOL_VERSION } from "./acpServer.js";
import { readVerdict, PASS } from "./supervisor.js";

/**
 * @param {{
 *   input: NodeJS.ReadableStream,
 *   output: NodeJS.WritableStream,
 *   supervisor: ReturnType<import("./supervisor.js").createExternalSupervisor>,
 *   token: string,
 *   log?: (message: string) => void,
 *   onError?: (error: any, method: string) => void,
 * }} options
 */
export function createSupervisorAcpPushServer({ input, output, supervisor, token, log = () => {}, onError }) {
  const peer = createPeer({ input, output, onError });
  let bound = false;

  peer.on("initialize", async (params) => ({
    protocolVersion: Number.isInteger(params?.protocolVersion)
      ? Math.min(params.protocolVersion, PROTOCOL_VERSION)
      : PROTOCOL_VERSION,
    agentCapabilities: { loadSession: false, promptCapabilities: { image: false, audio: false } },
    authMethods: [{ id: "token", name: "supervisor token" }],
  }));

  // Each deferred decision, pushed to the agent as a request. Its reply's
  // `verdict` (or a bare verdict string) is read through the same `readVerdict`
  // the whole supervisor uses, so `approve` is the only thing that approves.
  // Any failure — the agent errored, sent nothing readable — is a deferral, and
  // the seam's timeout covers a reply that never comes.
  /** @param {any} call */
  const review = (call) =>
    peer
      .request("supervisor/review", { tool: call?.tool, args: call?.args })
      .then((res) => readVerdict(typeof res === "string" ? res : res?.verdict ?? ""))
      .catch(() => PASS);

  peer.on("authenticate", async (params) => {
    if (!token || params?.token !== token) {
      throw new Error("supervisor authentication failed: present the token from the bridge's console");
    }
    if (!bound) {
      bound = true;
      supervisor.bind(review); // this connection is now the decider
      log("[supervisor] an ACP supervisor bound (push)");
    }
    return {};
  });

  let gone = false;
  const disconnect = () => {
    if (gone) return;
    gone = true;
    if (bound) {
      supervisor.unbind(); // decisions fall back to the human; in-flight answers are voided
      bound = false;
    }
    log("[supervisor] acp push connection closed; unbound");
  };
  input.on?.("end", disconnect);
  input.on?.("close", disconnect);

  return {
    peer,
    close: () => {
      peer.close();
      disconnect();
    },
  };
}
