#!/usr/bin/env node
/**
 * Expose codex's app-server DAEMON as a plain newline-JSON-RPC TCP port.
 *
 * The daemon's control socket speaks JSON-RPC over a WebSocket carried on a unix
 * socket (`client_async("ws://localhost/")` in codex's app-server-daemon crate).
 * `codex app-server proxy` relays raw bytes and so never sends the WebSocket
 * upgrade — which is why a JSON-RPC client gets a clean close / "broken pipe".
 * This does the upgrade: per TCP connection it opens one WebSocket to the daemon
 * socket and relays newline-framed JSON-RPC <-> WebSocket text frames. Auth is
 * only enforced on non-loopback listeners, so the local unix socket needs none.
 *
 * With this, ordinary clients — and a peerhailer tunnel — reach the real shared
 * daemon, which multiplexes one app-server across many clients natively.
 *
 *   appserver-ws-bridge --listen 9213 --sock ~/.codex/app-server-control/app-server-control.sock
 */
import net from "node:net";
import { randomBytes } from "node:crypto";

function parse(argv) {
  const o = { host: "127.0.0.1" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--listen") o.port = Number(argv[++i]);
    else if (a === "--sock") o.sock = argv[++i];
    else if (a === "--host") o.host = argv[++i];
  }
  return o;
}
const opts = parse(process.argv.slice(2));
if (!Number.isFinite(opts.port) || !opts.sock) {
  process.stderr.write("usage: appserver-ws-bridge --listen <port> --sock <daemon-unix-socket> [--host 127.0.0.1]\n");
  process.exit(2);
}
const log = (m) => process.stderr.write(`[appserver-ws-bridge] ${m}\n`);

// A client->server WebSocket text frame (RFC 6455: client frames are masked).
function wsFrame(text) {
  const p = Buffer.from(text);
  const mask = randomBytes(4);
  const n = p.length;
  let hdr;
  if (n < 126) hdr = Buffer.from([0x81, 0x80 | n]);
  else if (n < 65536) hdr = Buffer.from([0x81, 0xfe, (n >> 8) & 255, n & 255]);
  else {
    hdr = Buffer.alloc(10);
    hdr[0] = 0x81;
    hdr[1] = 0xff;
    hdr.writeBigUInt64BE(BigInt(n), 2);
  }
  const masked = Buffer.alloc(n);
  for (let i = 0; i < n; i++) masked[i] = p[i] ^ mask[i % 4];
  return Buffer.concat([hdr, mask, masked]);
}

// Decode server->client frames (unmasked). Yields complete text payloads,
// leaving any partial frame in the returned remainder. Handles ping/close.
function wsDecode(buf, onText, onClose) {
  let off = 0;
  while (buf.length - off >= 2) {
    const b0 = buf[off];
    const opcode = b0 & 0x0f;
    const len0 = buf[off + 1] & 0x7f;
    let hlen = 2;
    let len = len0;
    if (len0 === 126) {
      if (buf.length - off < 4) break;
      len = buf.readUInt16BE(off + 2);
      hlen = 4;
    } else if (len0 === 127) {
      if (buf.length - off < 10) break;
      len = Number(buf.readBigUInt64BE(off + 2));
      hlen = 10;
    }
    if (buf.length - off < hlen + len) break;
    const payload = buf.slice(off + hlen, off + hlen + len);
    off += hlen + len;
    if (opcode === 0x8) {
      onClose?.();
      return buf.slice(off);
    }
    if (opcode === 0x1 || opcode === 0x0) onText(payload.toString("utf8"));
    // ping/pong (0x9/0xA) ignored; the daemon does not require pongs here
  }
  return buf.slice(off);
}

const server = net.createServer((tcp) => {
  const ws = net.connect(opts.sock);
  let phase = "handshake";
  let wsbuf = Buffer.alloc(0);
  let tcpline = "";
  const key = randomBytes(16).toString("base64");

  ws.on("connect", () =>
    ws.write(`GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`),
  );
  ws.on("data", (d) => {
    wsbuf = Buffer.concat([wsbuf, d]);
    if (phase === "handshake") {
      const i = wsbuf.indexOf("\r\n\r\n");
      if (i === -1) return;
      if (!/101/.test(wsbuf.slice(0, i).toString())) {
        log("daemon did not accept the WebSocket upgrade");
        tcp.destroy();
        ws.destroy();
        return;
      }
      wsbuf = wsbuf.slice(i + 4);
      phase = "ws";
    }
    // daemon -> client: unwrap WS frames into newline JSON-RPC
    wsbuf = wsDecode(
      wsbuf,
      (text) => tcp.write(text.endsWith("\n") ? text : text + "\n"),
      () => tcp.end(),
    );
  });
  // client -> daemon: each newline JSON-RPC line becomes a masked WS text frame
  tcp.setEncoding("utf8");
  tcp.on("data", (d) => {
    tcpline += d;
    let i;
    while ((i = tcpline.indexOf("\n")) !== -1) {
      const line = tcpline.slice(0, i).trim();
      tcpline = tcpline.slice(i + 1);
      if (line && phase === "ws") ws.write(wsFrame(line));
      else if (line) {
        // still upgrading — hold briefly, then flush (handshake is sub-ms local)
        const held = line;
        setTimeout(() => phase === "ws" && ws.write(wsFrame(held)), 25);
      }
    }
  });
  const end = () => {
    if (!tcp.destroyed) tcp.destroy();
    if (!ws.destroyed) ws.destroy();
  };
  tcp.on("close", end);
  tcp.on("error", end);
  ws.on("close", end);
  ws.on("error", (e) => {
    log(`daemon socket error: ${e.message}`);
    end();
  });
});
server.listen(opts.port, opts.host, () => {
  log(`bridging daemon ${opts.sock} to newline JSON-RPC on ${opts.host}:${server.address().port}`);
  if (opts.host !== "127.0.0.1" && opts.host !== "localhost") log(`warning: ${opts.host} is not loopback`);
});
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => server.close(() => process.exit(0)));
