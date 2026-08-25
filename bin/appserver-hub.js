#!/usr/bin/env node
/**
 * Share one `codex app-server` process among several clients.
 *
 * codex's app-server is single-client over stdio; its own managed daemon would
 * multiplex it, but that path needs the standalone installer and an
 * undocumented socket handshake. This is a small stand-in: one app-server, a TCP
 * port, and N clients. Requests are id-remapped so each client's responses find
 * their way home; notifications are broadcast to everyone. The point is the
 * thing a single stdio pipe cannot do — a second client that watches, and
 * steers, a turn the first client is running.
 *
 * The hub does the one `initialize` the app-server expects; clients skip it and
 * go straight to thread/turn/... Loopback by default, so what reaches it is a
 * peerhailer tunnel and the fabric authenticates.
 *
 *   appserver-hub --listen 9212 -- codex app-server
 */
import net from "node:net";
import { spawn } from "node:child_process";

function parse(argv) {
  const o = { host: "127.0.0.1", cmd: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") { o.cmd = argv.slice(i + 1); break; }
    else if (a === "--listen") o.port = Number(argv[++i]);
    else if (a === "--host") o.host = argv[++i];
  }
  return o;
}
const opts = parse(process.argv.slice(2));
if (!Number.isFinite(opts.port) || opts.cmd.length === 0) {
  process.stderr.write("usage: appserver-hub --listen <port> [--host 127.0.0.1] -- <app-server command...>\n");
  process.exit(2);
}
const log = (m) => process.stderr.write(`[appserver-hub] ${m}\n`);

const agent = spawn(opts.cmd[0], opts.cmd.slice(1), { stdio: ["pipe", "pipe", "pipe"] });
agent.stderr.setEncoding("utf8");
agent.stderr.on("data", () => {});
agent.on("exit", (c, s) => { log(`app-server exited (${s ?? c})`); process.exit(1); });

const clients = new Set();
const routes = new Map(); // agent-facing id -> { socket, origId }
let gid = 0;

// Line-framed JSON from the app-server: responses route home, notifications broadcast.
let abuf = "";
agent.stdout.setEncoding("utf8");
agent.stdout.on("data", (d) => {
  abuf += d;
  let i;
  while ((i = abuf.indexOf("\n")) !== -1) {
    const line = abuf.slice(0, i).trim();
    abuf = abuf.slice(i + 1);
    if (!line) continue;
    let m;
    try { m = JSON.parse(line); } catch { continue; }
    if (m.id !== undefined && m.method === undefined) {
      // a response — send it back to whoever asked (the hub's own init is dropped)
      const route = routes.get(m.id);
      if (route) {
        routes.delete(m.id);
        route.socket.write(JSON.stringify({ ...m, id: route.origId }) + "\n");
      }
      return;
    }
    // notification, or an agent-originated request: everyone sees it
    for (const s of clients) s.write(line + "\n");
  }
});

// One initialize, from the hub; its response is dropped (id has no route).
agent.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: `hub-init`, method: "initialize", params: { clientInfo: { name: "appserver-hub", version: "0" } } }) + "\n");

const server = net.createServer((socket) => {
  clients.add(socket);
  log(`client connected (${clients.size})`);
  let cbuf = "";
  socket.setEncoding("utf8");
  socket.on("data", (d) => {
    cbuf += d;
    let i;
    while ((i = cbuf.indexOf("\n")) !== -1) {
      const line = cbuf.slice(0, i).trim();
      cbuf = cbuf.slice(i + 1);
      if (!line) continue;
      let m;
      try { m = JSON.parse(line); } catch { continue; }
      if (m.method !== undefined && m.id !== undefined) {
        // a request from this client — remap its id so the response comes home
        const id = `g${++gid}`;
        routes.set(id, { socket, origId: m.id });
        agent.stdin.write(JSON.stringify({ ...m, id }) + "\n");
      } else {
        // a notification, or a response to an agent request — pass through as-is
        agent.stdin.write(line + "\n");
      }
    }
  });
  const drop = () => { clients.delete(socket); log(`client gone (${clients.size})`); };
  socket.on("close", drop);
  socket.on("error", drop);
});
server.listen(opts.port, opts.host, () => {
  log(`sharing "${opts.cmd.join(" ")}" for ACP-app-server clients on ${opts.host}:${server.address().port}`);
  if (opts.host !== "127.0.0.1" && opts.host !== "localhost") log(`warning: ${opts.host} is not loopback`);
});
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { try { agent.kill("SIGTERM"); } catch {} server.close(() => process.exit(0)); });
