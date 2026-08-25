/**
 * The bridge, reachable over a TCP socket instead of over stdio.
 *
 * By default a client (T3 Code, Zed) spawns the bridge as a subprocess and talks
 * to it over stdin/stdout. That is fine when the client and the agent live on
 * the same machine. The moment the agent should run *elsewhere* — a phone
 * driving an agent at home — something has to carry the ACP conversation across
 * a network, and stdio does not cross a network.
 *
 * The ACP server already speaks newline-delimited JSON-RPC over any duplex
 * stream, and a TCP socket is a duplex stream. So this is small: listen, and for
 * each connection start a bridge whose input and output *are* the socket. One
 * connection is one ACP session with its own agent subprocess.
 *
 * It carries no security of its own, deliberately. It binds where it is told,
 * and what may reach that address is the caller's decision — a loopback bind
 * behind a peerhailer tunnel, so the peer fabric authenticates the client and
 * this only ever sees an authenticated local connection. Binding it to a public
 * interface would expose an unauthenticated agent to the network, which is the
 * same mistake as binding the control API outward, and just as much the
 * operator's to avoid.
 *
 * @module tcpBridge
 */
import { createServer } from "node:net";

import { startBridge } from "./bridge.js";

/**
 * How many agents this machine will run at once.
 *
 * Every connection opens its own gateway HTTP server before an agent even
 * exists, so an unbounded number of connections is an unbounded number of
 * listening ports and file descriptors — and it takes no malice, a client with a
 * reconnect loop does it. An agent is heavy, so this is deliberately small.
 */
export const MAX_SESSIONS = 8;

/** A connection nobody speaks on ties up an agent; a partition never sends FIN. */
export const IDLE_MS = 30 * 60_000;

/**
 * @param {{
 *   host?: string,
 *   port?: number,
 *   agent?: string,
 *   cwd?: string,
 *   policy?: any,
 *   supervisor?: (call: any) => Promise<string>,
 *   whenSupervisorAbsent?: string,
 *   log?: (message: string) => void,
 *   startBridgeImpl?: typeof startBridge,
 * }} [options]
 */
export function createTcpBridge(options = {}) {
  const host = options.host ?? "127.0.0.1";
  const log = options.log ?? (() => {});
  // Injectable so a test can hold startup open and prove that teardown and
  // `close()` do not wait on it.
  const spawnBridge = options.startBridgeImpl ?? startBridge;

  /** One bridge per live connection, so a dropped socket tears down its agent. */
  const sessions = new Set();

  const server = createServer((socket) => {
    socket.setNoDelay(true);

    if (sessions.size >= MAX_SESSIONS) {
      log(`[tcp] refusing a connection: already running ${sessions.size} sessions`);
      socket.destroy();
      return;
    }

    // Keepalive so a network partition — which sends no FIN — does not leave an
    // agent running for hours, and an idle timeout sized to a human reviewing
    // prompts rather than to a busy protocol.
    socket.setKeepAlive(true, 60_000);
    // `setTimeout` on a socket is the idle timeout, and it is unref'd by Node
    // when it fires; the concern is only the socket handle itself, which `end`
    // destroys.
    socket.setTimeout(IDLE_MS, () => {
      log(`[tcp] a session went idle; ending it`);
      socket.destroy();
    });

    // The socket is both halves of the transport. A bridge started on it answers
    // `initialize`, spawns the agent on the first prompt, and streams updates
    // back down the same socket.
    const started = spawnBridge({
      input: socket,
      output: socket,
      agent: options.agent,
      cwd: options.cwd,
      policy: options.policy,
      codexApprovalPolicy: options.codexApprovalPolicy,
      codexSandbox: options.codexSandbox,
      // The supervisor and its absent-policy reach each per-connection bridge —
      // without this, `--supervisor` on a `--listen` bridge was silently
      // dropped, so the deployment shape the service plugin spawns ran every
      // `ask` straight to the remote agent's client, unsupervised.
      supervisor: options.supervisor,
      whenSupervisorAbsent: options.whenSupervisorAbsent,
      log,
    });

    /** @type {{socket: import("node:net").Socket, bridge: any, ended: boolean, end: () => Promise<void>}} */
    const session = { socket, bridge: null, ended: false, end: async () => {} };
    sessions.add(session);
    log(`[tcp] a client connected from ${socket.remoteAddress ?? "an unknown address"}`);

    // Startup runs on its own. When it settles, either the session is still live
    // and we hold the bridge, or it already ended and we close the bridge the
    // moment it exists — so a bridge that finishes starting *after* teardown
    // still gets stopped rather than leaked.
    started.then(
      (bridge) => {
        session.bridge = bridge;
        if (session.ended) bridge?.close?.();
      },
      (error) => {
        // A startup failure (a bad agent, a workspace that will not prepare) used
        // to be logged and the socket left open, so the client hung with no reply.
        // Close it, so the failure reaches the client as a closed connection
        // rather than silence.
        log(`[tcp] a session failed to start: ${error instanceof Error ? error.message : error}`);
        session.ended = true;
        socket.destroy();
      },
    );

    // Teardown never awaits startup — that is what turned the previous fix for
    // "close returns too early" into "close may never return", when a bridge
    // that hangs in `startBridge` made every `end()` await it forever. It closes
    // the bridge if startup has produced one, and marks the session ended so the
    // continuation above closes it if startup is still in flight.
    session.end = async () => {
      if (!sessions.has(session)) return;
      sessions.delete(session);
      session.ended = true;
      try {
        await session.bridge?.close?.();
      } catch (error) {
        log(`[tcp] closing a session failed: ${error instanceof Error ? error.message : error}`);
      }
    };

    // A dropped connection ends the agent behind it: an agent nobody can reach
    // is an agent nobody can review, and leaving it running spends the machine.
    socket.on("close", () => session.end());
    socket.on("error", (error) => {
      log(`[tcp] connection error: ${error?.message ?? error}`);
      session.end();
    });
  });

  return {
    server,
    /**
     * Loopback unless told otherwise, for the same reason everything sensitive
     * here defaults to loopback: an unauthenticated agent has no business on a
     * network by accident.
     */
    listen: () =>
      new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(options.port ?? 0, host, () => {
          const address = /** @type {import("node:net").AddressInfo} */ (server.address());
          log(`[tcp] the bridge answers on ${host}:${address.port}`);
          resolve({ host, port: address.port });
        });
      }),
    close: async () => {
      // Stop accepting, then force every live session down and wait for the
      // agents to die. Destroying the socket first is deliberate: `server.close`
      // waits for open connections to end on their own, and a client that has
      // not hung up would otherwise make this hang — so the sessions are torn
      // down rather than waited on. `end()` is what awaits the agent, since
      // `socket.destroy()` returns synchronously and awaiting it awaits nothing.
      server.close();
      await Promise.all(
        [...sessions].map((session) => {
          session.socket.destroy();
          return session.end();
        }),
      );
    },
  };
}
