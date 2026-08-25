#!/usr/bin/env node
/**
 * Serve a stdio ACP agent over a loopback TCP port, so a peerhailer tunnel can
 * carry it.
 *
 * This is the ACP-native path, and the counterpart to the bridge. The bridge
 * translates ACP<->MCP and gates the MCP tool channel, which is how it reaches
 * an agent that does not speak ACP (agy) — at the cost of seeing only MCP tools.
 * When an agent *does* have an ACP adapter (claude via @zed-industries/
 * claude-code-acp, codex via @zed-industries/codex-acp), there is nothing to
 * translate: the adapter already speaks ACP and already surfaces the agent's own
 * native permissions. All that is missing is a way to reach its stdio from
 * across the fabric. That is this: a dumb byte forwarder, one adapter process per
 * connection, socket <-> stdio. No gate of its own — the adapter carries the
 * agent's.
 *
 * Loopback by default, deliberately: what may reach it is the peerhailer tunnel,
 * and the fabric is what authenticates. Binding it outward would expose an
 * unauthenticated agent, the same mistake as binding the bridge outward.
 *
 *   acp-passthrough --listen 9110 -- npx -y @zed-industries/claude-code-acp
 *   acp-passthrough --listen 9111 -- npx -y @zed-industries/codex-acp
 */
import net from "node:net";
import { spawn } from "node:child_process";

function parseArgs(argv) {
  const opts = { host: "127.0.0.1", max: 8, command: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") {
      opts.command = argv.slice(i + 1);
      break;
    }
    if (a === "--listen") opts.port = Number(argv[++i]);
    else if (a === "--host") opts.host = argv[++i];
    else if (a === "--max") opts.max = Number(argv[++i]);
    else if (a === "-h" || a === "--help") opts.help = true;
    else process.stderr.write(`acp-passthrough: ignoring unknown option ${a}\n`);
  }
  return opts;
}

const opts = parseArgs(process.argv.slice(2));
if (opts.help || !Number.isFinite(opts.port) || opts.command.length === 0) {
  process.stderr.write(
    "usage: acp-passthrough --listen <port> [--host 127.0.0.1] [--max 8] -- <acp-adapter command...>\n",
  );
  process.exit(opts.help ? 0 : 2);
}

const log = (m) => process.stderr.write(`[acp-passthrough] ${m}\n`);
let live = 0;

const server = net.createServer((socket) => {
  if (live >= opts.max) {
    // Each connection spawns a whole agent; refuse rather than thrash the box.
    log(`refused a connection: at the ${opts.max}-agent limit`);
    socket.destroy();
    return;
  }
  live++;
  const [cmd, ...args] = opts.command;
  const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
  log(`connection up (${live}/${opts.max}) — spawned ${cmd}`);

  // Raw bytes both ways. ACP is newline-delimited JSON-RPC; a byte pipe keeps
  // its framing untouched, so nothing here parses the protocol.
  socket.pipe(child.stdin);
  child.stdout.pipe(socket);
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (d) => process.stderr.write(d));

  const done = (why) => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    if (!socket.destroyed) socket.destroy();
  };
  // A dropped socket ends the agent behind it: an agent nobody can reach is one
  // nobody can review, and leaving it running spends the machine.
  socket.on("close", () => done("socket closed"));
  socket.on("error", (e) => done(`socket error: ${e.message}`));
  child.on("exit", (code, sig) => {
    log(`adapter exited (${sig ?? code})`);
    if (!socket.destroyed) socket.end();
  });
  child.on("error", (e) => {
    log(`failed to launch '${cmd}': ${e.message}`);
    if (!socket.destroyed) socket.destroy();
  });
  socket.on("close", () => {
    live--;
  });
});

server.on("error", (e) => {
  log(`listen error: ${e.message}`);
  process.exit(1);
});

server.listen(opts.port, opts.host, () => {
  const { port } = server.address();
  log(`listening for ACP on ${opts.host}:${port} — adapter: ${opts.command.join(" ")}`);
  if (opts.host !== "127.0.0.1" && opts.host !== "localhost") {
    log(`warning: ${opts.host} is not loopback — this agent has no authentication of its own`);
  }
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => server.close(() => process.exit(0)));
}
