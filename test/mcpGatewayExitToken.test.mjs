/**
 * The optional exit-token guard on a fixed supervisor seat.
 *
 * When listen() is given an exit token, the gateway fronts the port with a raw
 * preamble sniff: a connection reaching the protected /mcp/supervisor path must
 * have opened with `PHT/1 <token>` (which the peerhailer tunnel writes). An
 * agent's own session, on a different path, is untouched — no preamble needed.
 *
 * The preamble is below the HTTP/MCP layer, so these tests speak raw sockets and
 * assert only on the status line: 403 means the guard refused; anything else
 * means the request passed the guard (and failed later on its own merits).
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { connect } from "node:net";

import { createGateway } from "../src/mcpGateway.js";

const TOKEN = "s3cr3t-exit";

const gateway = createGateway({ tools: [] });
// The supervisor session sits on the protected fixed path; an agent session is a
// normal random path.
gateway.openSession({ token: "supervisor" });
const agent = gateway.openSession();

// A short sniff timeout so the stall test need not wait the 10s default; legit
// requests arrive in milliseconds and never trip it.
const server = await gateway.listen(0, "127.0.0.1", { exitToken: TOKEN, protectedToken: "supervisor", sniffTimeoutMs: 700 });
after(() => server.close());

/**
 * Open a raw socket, optionally write a `PHT/1 <preamble>` line, POST to `path`,
 * and resolve the HTTP status code.
 */
function statusFor(path, preamble) {
  return new Promise((resolve, reject) => {
    const socket = connect(server.port, "127.0.0.1", () => {
      if (preamble) socket.write(`PHT/1 ${preamble}\r\n`);
      const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
      socket.write(
        `POST ${path} HTTP/1.1\r\n` +
          `Host: 127.0.0.1\r\n` +
          `Content-Type: application/json\r\n` +
          `Accept: application/json\r\n` +
          `Content-Length: ${Buffer.byteLength(body)}\r\n` +
          `Connection: close\r\n\r\n` +
          body,
      );
    });
    let buf = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buf += chunk;
    });
    socket.on("error", reject);
    socket.on("close", () => {
      const m = /^HTTP\/1\.1 (\d{3})/.exec(buf);
      resolve(m ? Number(m[1]) : null);
    });
  });
}

test("the supervisor path is refused with no preamble", async () => {
  assert.equal(await statusFor("/mcp/supervisor"), 403);
});

test("the supervisor path is refused with the wrong token", async () => {
  assert.equal(await statusFor("/mcp/supervisor", "not-the-token"), 403);
});

test("the supervisor path passes the guard with the right token", async () => {
  const status = await statusFor("/mcp/supervisor", TOKEN);
  assert.notEqual(status, 403, "the correct preamble clears the guard");
});

test("an agent session is untouched — no preamble needed", async () => {
  const status = await statusFor(`/mcp/${agent.token}`);
  assert.notEqual(status, 403, "the unprotected path never demands the preamble");
});

test("a socket that connects and stalls is closed, not pinned (finding 1)", async () => {
  const closedWithin = await new Promise((resolve) => {
    const socket = connect(server.port, "127.0.0.1", () => {
      // Send fewer bytes than the prefix, then nothing — the classic stall.
      socket.write("PH");
    });
    const started = Date.now();
    socket.on("error", () => {});
    socket.on("close", () => resolve(Date.now() - started));
    setTimeout(() => resolve(null), 3000);
  });
  assert.ok(closedWithin !== null && closedWithin < 2000, `the stalled socket was closed (in ${closedWithin}ms)`);
});

test("an unknown session is a 404, not a guard 403", async () => {
  assert.equal(await statusFor("/mcp/nope-nobody"), 404);
});
