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
 * @param {{
 *   host?: string,
 *   port?: number,
 *   agent?: string,
 *   cwd?: string,
 *   policy?: any,
 *   log?: (message: string) => void,
 * }} [options]
 */
export function createTcpBridge(options = {}) {
  const host = options.host ?? "127.0.0.1";
  const log = options.log ?? (() => {});

  /** One bridge per live connection, so a dropped socket tears down its agent. */
  const sessions = new Set();

  const server = createServer((socket) => {
    socket.setNoDelay(true);

    // The socket is both halves of the transport. A bridge started on it answers
    // `initialize`, spawns the agent on the first prompt, and streams updates
    // back down the same socket.
    const started = startBridge({
      input: socket,
      output: socket,
      agent: options.agent,
      cwd: options.cwd,
      policy: options.policy,
      log,
    });

    const session = { socket, started };
    sessions.add(session);
    log(`[tcp] a client connected from ${socket.remoteAddress ?? "an unknown address"}`);

    const end = async () => {
      if (!sessions.has(session)) return;
      sessions.delete(session);
      try {
        (await started)?.close?.();
      } catch (error) {
        log(`[tcp] closing a session failed: ${error instanceof Error ? error.message : error}`);
      }
    };

    // A dropped connection ends the agent behind it: an agent nobody can reach
    // is an agent nobody can review, and leaving it running spends the machine.
    socket.on("close", end);
    socket.on("error", (error) => {
      log(`[tcp] connection error: ${error?.message ?? error}`);
      end();
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
      await Promise.all([...sessions].map((session) => session.socket.destroy()));
      await new Promise((resolve) => server.close(() => resolve(undefined)));
    },
  };
}
