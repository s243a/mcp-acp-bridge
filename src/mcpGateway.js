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
import { randomUUID, randomBytes } from "node:crypto";
import { createServer } from "node:http";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { allowAll } from "./gate.js";

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

  function openSession({ sessionId = randomUUID() } = {}) {
    const token = randomBytes(24).toString("base64url");
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

      const decision = await gate(call);
      if (!decision.allow) {
        onToolCall?.({ ...call, phase: "denied", reason: decision.reason });
        // Legible to the agent so it can adapt rather than retry blindly.
        return errorResult(`permission denied: ${decision.reason}`);
      }

      try {
        const output = await tool.handler(args ?? {});
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

  function listen(port = 0, host = "127.0.0.1") {
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

    return new Promise((resolve) => {
      http.listen(port, host, () => {
        const { port: boundPort } = http.address();
        resolve({
          port: boundPort,
          url: (token) => `http://${host}:${boundPort}/mcp/${token}`,
          close: () => new Promise((done) => http.close(done)),
        });
      });
    });
  }

  return { openSession, closeSession, handleRequest, listen };
}

function errorResult(text) {
  return { content: [{ type: "text", text: `Error: ${text}` }], isError: true };
}

function stringify(value) {
  return typeof value === "string" ? value : JSON.stringify(value);
}
