/**
 * Newline-delimited JSON-RPC 2.0 over a duplex stream.
 *
 * ACP runs over stdio this way: one JSON object per line, requests and
 * notifications flowing both directions. Small enough to own rather than
 * depend on, and owning it keeps the framing rules explicit.
 */
import { appendFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

export const ErrorCode = {
  PARSE: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL: -32603,
};

export function createPeer({ input, output, onError }) {
  const handlers = new Map();
  const pending = new Map();
  let buffer = "";
  let closed = false;

  input.setEncoding("utf8");
  input.on("data", (chunk) => {
    buffer += chunk;
    // A partial trailing line stays in the buffer until its newline arrives.
    let index;
    while ((index = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line) dispatch(line);
    }
  });

  input.on("end", () => {
    closed = true;
    for (const { reject } of pending.values()) {
      reject(new Error("connection closed"));
    }
    pending.clear();
  });

  function send(message) {
    if (closed) return;
    const line = JSON.stringify(message);
    if (process.env.BRIDGE_WIRE_LOG) {
      try {
        appendFileSync(process.env.BRIDGE_WIRE_LOG, `OUT ${line}\n`);
      } catch {}
    }
    output.write(`${line}\n`);
  }

  function dispatch(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      send({ jsonrpc: "2.0", id: null, error: { code: ErrorCode.PARSE, message: "parse error" } });
      return;
    }

    // A response to something we sent.
    if (message.id !== undefined && message.method === undefined) {
      const waiter = pending.get(message.id);
      if (!waiter) return;
      pending.delete(message.id);
      if (message.error) waiter.reject(Object.assign(new Error(message.error.message), message.error));
      else waiter.resolve(message.result);
      return;
    }

    if (typeof message.method !== "string") return;

    const handler = handlers.get(message.method);
    const isNotification = message.id === undefined || message.id === null;

    if (!handler) {
      if (!isNotification) {
        send({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: ErrorCode.METHOD_NOT_FOUND, message: `unknown method: ${message.method}` },
        });
      }
      return;
    }

    Promise.resolve()
      .then(() => handler(message.params ?? {}))
      .then(
        (result) => {
          if (!isNotification) send({ jsonrpc: "2.0", id: message.id, result: result ?? {} });
        },
        (error) => {
          onError?.(error, message.method);
          if (!isNotification) {
            send({
              jsonrpc: "2.0",
              id: message.id,
              error: {
                code: Number.isInteger(error?.code) ? error.code : ErrorCode.INTERNAL,
                message: String(error?.message ?? error),
              },
            });
          }
        },
      );
  }

  return {
    /** Register a handler. Returning a value answers a request; notifications ignore it. */
    on(method, handler) {
      handlers.set(method, handler);
      return this;
    },
    notify(method, params) {
      send({ jsonrpc: "2.0", method, params });
    },
    request(method, params) {
      const id = randomUUID();
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        send({ jsonrpc: "2.0", id, method, params });
      });
    },
    close() {
      closed = true;
    },
    get pendingCount() {
      return pending.size;
    },
  };
}
