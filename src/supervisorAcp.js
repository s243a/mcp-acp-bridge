/**
 * The ACP surface of the supervisor seat — for a supervisor that is an agent.
 *
 * The same seat and adapter as the MCP surface (`supervisorTools`), over ACP
 * methods a connected client calls: `supervisor/claim`, `supervisor/pending`,
 * `supervisor/decide`, `supervisor/release`, `supervisor/force_release`. The
 * client is a *separate* ACP connection from the one driving the agent — a
 * larger agent watching a smaller one's calls — and the connection becomes an
 * operator session only after it presents the token the bridge printed to the
 * operator's console. Reaching the loopback port is not authority: the agent can
 * reach it too, so without the token a connection supervises nothing.
 *
 * The one thing ACP has that stateless MCP does not: a **disconnect signal**. A
 * closed connection frees the seat immediately, so a supervisor that drops does
 * not wedge it — the recovery MCP needs `force_release` for happens on its own
 * here. That is the reason the adapter carried a `disconnect` hook all along.
 *
 * Pull, not push: the client polls `supervisor/pending` and posts
 * `supervisor/decide`, reusing the seat's queue unchanged rather than the bridge
 * pushing each decision as a request. A push variant (offer each decision as an
 * ACP request the agent answers, via `createExternalSupervisor`) is the more
 * agent-idiomatic shape and is possible on the same seat; pull is chosen here so
 * one hardened seat serves both transports with no second decision path.
 *
 * @module supervisorAcp
 */
import { createPeer } from "./jsonRpc.js";
import { PROTOCOL_VERSION } from "./acpServer.js";

/**
 * @param {{
 *   input: NodeJS.ReadableStream,
 *   output: NodeJS.WritableStream,
 *   adapter: ReturnType<import("./supervisorAdapter.js").createSupervisorAdapter>,
 *   session: string,
 *   token: string,
 *   onAuthenticated?: (session: string) => void,
 *   log?: (message: string) => void,
 *   onError?: (error: any, method: string) => void,
 * }} options
 */
export function createSupervisorAcpServer({ input, output, adapter, session, token, onAuthenticated, log = () => {}, onError }) {
  const peer = createPeer({ input, output, onError });
  let authenticated = false;

  // A minimal ACP handshake, so a real client can `initialize`/`authenticate`
  // before it supervises. We advertise nothing to run — this endpoint is not an
  // agent, it is a reviewer's console.
  peer.on("initialize", async (params) => ({
    protocolVersion: Number.isInteger(params?.protocolVersion)
      ? Math.min(params.protocolVersion, PROTOCOL_VERSION)
      : PROTOCOL_VERSION,
    agentCapabilities: { loadSession: false, promptCapabilities: { image: false, audio: false } },
    authMethods: [{ id: "token", name: "supervisor token" }],
  }));

  // The credential the *agent* does not have. Reaching this port is not
  // authority: the port is loopback, and a loopback port is reachable by any
  // local process — including the supervised agent, which runs here with
  // shell-class tools. So a connection becomes an operator only after presenting
  // the token the bridge printed to the operator's console (its stderr), which
  // the agent cannot read. Without it, this session is never added to the
  // operator set, so `claim` and every other method are refused. A missing or
  // wrong token authenticates nobody — fail closed.
  peer.on("authenticate", async (params) => {
    if (!token || params?.token !== token) {
      throw new Error("supervisor authentication failed: present the token from the bridge's console");
    }
    if (!authenticated) {
      authenticated = true;
      onAuthenticated?.(session);
    }
    return {};
  });

  peer.on("supervisor/claim", async () => adapter.claim(session));
  peer.on("supervisor/pending", async () => ({ pending: adapter.pending(session) }));
  peer.on("supervisor/decide", async (params) =>
    adapter.decide(session, String(params?.id ?? ""), String(params?.verdict ?? "")),
  );
  peer.on("supervisor/release", async () => adapter.release(session));
  peer.on("supervisor/force_release", async () => adapter.forceRelease(session));

  let gone = false;
  const disconnect = () => {
    if (gone) return;
    gone = true;
    // The seat is freed the moment the connection ends — ACP's advantage.
    adapter.disconnect(session);
    log("[supervisor] acp connection closed; seat released if it was held");
  };
  input.on?.("end", disconnect);
  input.on?.("close", disconnect);

  return {
    peer,
    session,
    close: () => {
      peer.close();
      disconnect();
    },
  };
}
