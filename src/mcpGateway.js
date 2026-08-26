/**
 * The MCP side of the bridge: a path-scoped, gated MCP server.
 *
 * One HTTP listener serves many sessions. Each session gets its own opaque
 * path — `/mcp/<token>` — and the agent is handed that URL and nothing else, so
 * every call arriving on it belongs to that session by construction.
 *
 * That is deliberate. Deriving session identity from MCP transport state would
 * mean depending on `Mcp-Session-Id`, which the 2026-07-28 revision removes;
 * routing on the path works identically across revisions AND makes it
 * impossible for a second agent's calls to land on the first agent's session.
 *
 * The transport runs stateless (`sessionIdGenerator: undefined`), so no
 * handshake is required and none is assumed.
 */
import { randomUUID, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { createServer as createNetServer } from "node:net";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { allowAll, denialMessage } from "./gate.js";
import { TRANSPORT_TOOLS } from "./taskChannel.js";

const SERVER_INFO = { name: "mcp-acp-bridge", version: "0.0.1" };

/**
 * @param {{
 *   tools?: Array<{name: string, description?: string, inputSchema?: object,
 *                  handler: (args: unknown) => Promise<unknown>}>,
 *   gate?: Function,
 *   onToolCall?: Function,
 * }} [options]
 */
export function createGateway(options = {}) {
  const tools = new Map((options.tools ?? []).map((tool) => [tool.name, tool]));
  const gate = options.gate ?? allowAll;
  const onToolCall = options.onToolCall;

  /** token -> session record */
  const sessions = new Map();

  // Set by listen() when an exit token is configured: the tunnel writes a
  // `PHT/1 <token>` preamble on connect, we verify it at the raw socket, and the
  // protected session's path refuses any request that did not arrive verified.
  /** @type {{ token: string, protectedToken: string } | null} */
  let exitGuard = null;

  function openSession({ sessionId = randomUUID(), token = randomBytes(24).toString("base64url") } = {}) {
    // A caller may pin the token (hence the URL path) — used to expose the
    // supervisor seat at a known /mcp/<name> when its port is fixed, so it can be
    // reached over a capability-gated tunnel without conveying a random secret.
    sessions.set(token, { sessionId, token });
    return { sessionId, token, path: `/mcp/${token}` };
  }

  function closeSession(token) {
    return sessions.delete(token);
  }

  function buildServer(session) {
    const server = new Server(SERVER_INFO, { capabilities: { tools: {} } });

    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [...tools.values()].map(({ name, description, inputSchema }) => ({
        name,
        description: description ?? "",
        inputSchema: inputSchema ?? { type: "object", properties: {} },
      })),
    }));

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      const tool = tools.get(name);
      if (!tool) {
        return errorResult(`tool '${name}' is not available`);
      }

      const call = { sessionId: session.sessionId, tool: name, args: args ?? {} };
      onToolCall?.({ ...call, phase: "requested" });

      // Transport tools carry the turn itself. Asking a human whether the agent
      // may read its own instructions asks about the wrong thing, and a denial
      // would strand the turn rather than prevent anything. `bypassGate` tools
      // are the same shape one family further out — the supervisor's own console,
      // which must not be a reviewed action or it reviews itself into a spiral.
      const decision = TRANSPORT_TOOLS.has(name) || tool.bypassGate ? { allow: true } : await gate(call);
      if (!decision.allow) {
        onToolCall?.({ ...call, phase: "denied", reason: decision.reason });
        // Says who refused and whether trying again is worth anything.
        return errorResult(denialMessage(decision.reason));
      }

      try {
        // Handlers receive the session so a tool can answer per-session — which
        // is what lets one endpoint serve a turn to the right conversation.
        const output = await tool.handler(args ?? {}, { sessionId: session.sessionId });
        onToolCall?.({ ...call, phase: "completed" });
        return { content: [{ type: "text", text: stringify(output) }] };
      } catch (error) {
        onToolCall?.({ ...call, phase: "failed", reason: error?.message });
        return errorResult(String(error?.message ?? error));
      }
    });

    return server;
  }

  /** Handle one HTTP request. Returns false if the path is not ours. */
  async function handleRequest(req, res) {
    const url = new URL(req.url, "http://localhost");
    const match = /^\/mcp\/([A-Za-z0-9_-]+)$/.exec(url.pathname);
    if (!match) return false;

    const session = sessions.get(match[1]);
    if (!session) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unknown session" }));
      return true;
    }

    // The protected (supervisor) path is reachable only over a connection that
    // presented the tunnel's exit token; an agent's own session, on a different
    // path, is untouched. A direct loopback hit on the seat without the preamble
    // is refused here, so the tunnel capability is the credential end to end.
    if (exitGuard && match[1] === exitGuard.protectedToken && !req.socket.phtVerified) {
      res.writeHead(403, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "supervisor seat requires the tunnel exit token" }));
      return true;
    }

    // Stateless: a new server and transport per request, no Mcp-Session-Id
    // issued and no initialize handshake required.
    const server = buildServer(session);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });

    res.on("close", () => {
      transport.close().catch(() => {});
      server.close().catch(() => {});
    });

    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
    return true;
  }

  function listen(port = 0, host = "127.0.0.1", guard = {}) {
    const exitToken = typeof guard.exitToken === "string" && guard.exitToken.length > 0 ? guard.exitToken : null;
    if (exitToken) exitGuard = { token: exitToken, protectedToken: guard.protectedToken };
    const http = createServer((req, res) => {
      handleRequest(req, res).then(
        (handled) => {
          if (!handled) {
            res.writeHead(404).end();
          }
        },
        (error) => {
          if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: String(error?.message ?? error) }));
        },
      );
    });

    // Without an exit token the HTTP server binds the port directly. With one, a
    // thin net server peeks the first line: a `PHT/1 <token>` preamble (written
    // by the peerhailer tunnel on connect) is verified and stripped, the socket
    // marked, and the remaining bytes — the real HTTP request — handed on. A
    // connection with no preamble still reaches HTTP; only the protected path
    // refuses it. The preamble never reaches the HTTP parser.
    const front = exitToken ? createNetServer((socket) => sniffPreamble(socket, exitToken, http)) : http;

    return new Promise((resolve) => {
      front.listen(port, host, () => {
        const { port: boundPort } = front.address();
        resolve({
          port: boundPort,
          url: (token) => `http://${host}:${boundPort}/mcp/${token}`,
          close: () =>
            new Promise((done) => {
              // Force-close keep-alive sockets rather than waiting for the peer:
              // `http.close` alone waits for idle, and an MCP client polling over
              // keep-alive keeps it open past when the bridge is done with it.
              http.close(() => {
                if (front === http) return done(undefined);
                front.close(() => done(undefined));
                front.closeAllConnections?.();
              });
              http.closeAllConnections?.();
            }),
        });
      });
    });
  }

  return { openSession, closeSession, handleRequest, listen };
}

/**
 * Peek a `PHT/1 <token>\r\n` preamble off a freshly connected socket, verify it,
 * and hand the socket (with the preamble consumed and the rest un-shifted back)
 * to the HTTP server. A connection whose first bytes are not the preamble is
 * passed straight through — its `phtVerified` stays false, so only the protected
 * path treats it differently. Buffers across TCP segment boundaries; caps the
 * unmatched wait so a silent or oversized opener cannot pin memory.
 * @param {import("node:net").Socket} socket
 * @param {string} exitToken
 * @param {import("node:http").Server} http
 */
function sniffPreamble(socket, exitToken, http) {
  const PREFIX = "PHT/1 ";
  const MAX_LINE = 512;
  let buf = Buffer.alloc(0);
  const hand = () => http.emit("connection", socket);
  const onData = (/** @type {Buffer} */ chunk) => {
    buf = Buffer.concat([buf, chunk]);
    // Undecided until we have at least the prefix length.
    if (buf.length < PREFIX.length) return;
    if (buf.subarray(0, PREFIX.length).toString() !== PREFIX) {
      socket.removeListener("data", onData);
      socket.unshift(buf);
      hand();
      return;
    }
    const nl = buf.indexOf(0x0a);
    if (nl < 0) {
      if (buf.length > MAX_LINE) socket.destroy();
      return; // wait for the newline
    }
    const token = buf.subarray(PREFIX.length, nl).toString().trim();
    if (tokensEqual(token, exitToken)) socket.phtVerified = true;
    socket.removeListener("data", onData);
    const rest = buf.subarray(nl + 1);
    if (rest.length) socket.unshift(rest);
    hand();
  };
  socket.on("data", onData);
  socket.on("error", () => socket.destroy());
}

/** Constant-time token compare that also guards differing lengths. */
function tokensEqual(a, b) {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function errorResult(text) {
  return { content: [{ type: "text", text: `Error: ${text}` }], isError: true };
}

function stringify(value) {
  return typeof value === "string" ? value : JSON.stringify(value);
}
