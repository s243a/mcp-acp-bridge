#!/usr/bin/env node
/**
 * CLI entry point. Speaks ACP on stdio, so any ACP client can launch it.
 *
 * Positional arguments that name a transport — `acp`, `agent`, `stdio` — are
 * accepted and ignored. That is deliberate: it lets the bridge stand in for
 * another agent binary in a client that hardcodes those arguments, which is how
 * we drive T3 Code without first writing a T3 provider driver.
 *
 *   mcp-acp-bridge [--agent <name>] [--cwd <dir>] [--timeout-ms <n>]
 *                  [--policy <preset|file.json>] [--skip-agent-permissions]
 *
 * Presets: review-everything (default), review-consequential, allow-all.
 */
import { existsSync, readFileSync } from "node:fs";

import { startBridge } from "../src/bridge.js";
import { createSpawnSupervisor } from "../src/supervisor.js";

const TRANSPORT_WORDS = new Set(["acp", "agent", "stdio"]);

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (TRANSPORT_WORDS.has(arg)) continue;
    switch (arg) {
      case "--agent":
        options.agent = argv[++i];
        break;
      case "--cwd":
        options.cwd = argv[++i];
        break;
      case "--timeout-ms":
        options.timeoutMs = Number(argv[++i]);
        break;
      case "--workspace-mode":
        // isolated: an empty directory holding only the MCP registration.
        // project: the real directory, with prompt-free reads and writes there.
        options.workspaceMode = argv[++i];
        break;
      case "--listen":
        // Answer ACP on a TCP port instead of over stdio. For an agent that
        // should run somewhere a stdio client cannot reach — reached in practice
        // through a peerhailer tunnel, which authenticates the client so this
        // only ever sees a local connection.
        options.listen = Number(argv[++i]);
        break;
      case "--listen-host":
        options.listenHost = argv[++i];
        break;
      case "--supervisor":
        // A command run per decision — the call on stdin, `approve|reject|pass`
        // on stdout. Silence or slowness passes to the human; it cannot fail
        // open. The two late-binding modes (MCP, ACP) are in docs/supervisor.md.
        options.supervisor = argv[++i];
        break;
      case "--policy":
        // A preset name, or a path to a JSON file holding {rules, default}.
        options.policy = argv[++i];
        break;
      case "--skip-agent-permissions":
        // The agent stops prompting; whatever gates the MCP channel becomes the
        // only review. Explicit because it leaves built-in tools unsupervised.
        options.skipAgentPermissions = true;
        break;
      case "-e":
      case "--api-endpoint":
        ++i; // accepted and ignored, for binaries whose clients pass one
        break;
      default:
        if (arg.startsWith("-")) {
          process.stderr.write(`mcp-acp-bridge: ignoring unknown option ${arg}\n`);
        }
    }
  }
  return options;
}

/**
 * Probe mode.
 *
 * Clients health-check an agent binary before using it, and a binary that
 * answers nothing looks broken. T3 Code runs `<binary> agent about` with an 8s
 * budget and parses `Key<2+ spaces>Value` lines; other clients use --version.
 * Answering both keeps the bridge usable as a stand-in.
 */
const rawArgs = process.argv.slice(2);
if (rawArgs.includes("about") || rawArgs.includes("--version") || rawArgs.includes("-v")) {
  const { version } = await import("../package.json", { with: { type: "json" } }).then(
    (m) => m.default,
  );
  process.stdout.write(
    [
      `CLI Version         ${version}-mcp-acp-bridge`,
      `User Email          bridge@localhost`,
      "",
    ].join("\n"),
  );
  process.exit(0);
}

const options = parseArgs(rawArgs);

/** A policy argument naming a readable file is loaded; otherwise it is a preset. */
function resolvePolicy(value) {
  if (!value) return undefined;
  if (!existsSync(value)) return value;
  try {
    return JSON.parse(readFileSync(value, "utf8"));
  } catch (error) {
    // Falling back to the safe default beats running with a policy we could not
    // parse and cannot vouch for.
    process.stderr.write(
      `mcp-acp-bridge: could not read policy ${value} (${error.message}); asking about everything\n`,
    );
    return "review-everything";
  }
}

// stdout is the ACP channel — every diagnostic must go to stderr or it corrupts
// the protocol stream.
const log = (message) => process.stderr.write(`${message}\n`);

// A bad agent name or an unimplemented profile is a user error, not a crash;
// print the reason rather than a stack trace.
// A TCP listener rather than stdio, when asked. It carries no auth of its own,
// so it binds loopback unless told otherwise, and it warns if told otherwise.
if (Number.isFinite(options.listen)) {
  const { createTcpBridge } = await import("../src/tcpBridge.js");
  const host = options.listenHost ?? "127.0.0.1";
  const tcp = createTcpBridge({
    host,
    port: options.listen,
    agent: options.agent ?? process.env.BRIDGE_AGENT ?? "claude",
    cwd: options.cwd ?? process.cwd(),
    policy: resolvePolicy(options.policy ?? process.env.BRIDGE_POLICY),
    log,
  });
  const { port } = await tcp.listen();
  log(`[bridge] listening for ACP on ${host}:${port}`);
  if (host !== "127.0.0.1" && host !== "localhost") {
    log(`[bridge] warning: ${host} is not loopback — this agent has no authentication of its own`);
  }
  process.on("SIGINT", () => tcp.close().finally(() => process.exit(0)));
  process.on("SIGTERM", () => tcp.close().finally(() => process.exit(0)));
} else {

let bridge;
try {
  bridge = await startBridge({
    agent: options.agent ?? process.env.BRIDGE_AGENT ?? "claude",
    ...(options.supervisor
      ? { supervisor: createSpawnSupervisor({ command: options.supervisor, args: [] }) }
      : {}),
    cwd: options.cwd ?? process.cwd(),
    timeoutMs: options.timeoutMs,
      policy: resolvePolicy(options.policy ?? process.env.BRIDGE_POLICY),
    workspaceMode: options.workspaceMode ?? process.env.BRIDGE_WORKSPACE_MODE,
    skipAgentPermissions:
      options.skipAgentPermissions === true || process.env.BRIDGE_SKIP_AGENT_PERMISSIONS === "1",
    log,
  });
} catch (error) {
  process.stderr.write(`mcp-acp-bridge: ${error.message}\n`);
  process.exit(1);
}


const described = bridge.policy.describe();
log(
  `[bridge] ready — agent=${options.agent ?? "claude"} mcp port ${bridge.port} ` +
    `policy=${described.rules.length} rules, default ${described.default}`,
);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    bridge.close().finally(() => process.exit(0));
  });
}

} // end stdio transport
