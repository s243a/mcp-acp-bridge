#!/usr/bin/env node
/**
 * CLI entry point. Speaks ACP on stdio, so any ACP client can launch it.
 *
 * Positional arguments that name a transport — `acp`, `agent`, `stdio` — are
 * accepted and ignored. That is deliberate: it lets the bridge stand in for
 * another agent binary in a client that hardcodes those arguments, which is how
 * we drive T3 Code without first writing a T3 provider driver.
 *
 *   mcp-acp-bridge [--agent <name>] [--cwd <dir>] [--timeout-ms <n>] [--codex-approval untrusted|on-request|never] [--codex-sandbox ...]
 *                  [--policy <preset|file.json>] [--skip-agent-permissions]
 *
 * Presets: review-everything (default), review-consequential, allow-all.
 */
import { existsSync, readFileSync } from "node:fs";

import { startBridge } from "../src/bridge.js";
import { getAdapter } from "../src/agents.js";
import { createSpawnSupervisor } from "../src/supervisor.js";
import { parseTimingProfile } from "../src/supervisorTiming.js";

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
      case "--announce-port":
        // Print the bound port as one JSON line `{"port":N}` to stdout once
        // listening. For a launcher that started us with `--listen 0` (an
        // ephemeral OS-assigned port) and needs the real number back — e.g.
        // peerhailer's service plugin in report mode, which reads this so the
        // port it hands a caller is one we actually bound, not one we were told.
        options.announcePort = true;
        break;
      case "--supervisor":
        // A command run per decision — the call on stdin, `approve|reject|pass`
        // on stdout. It cannot fail open. The two late-binding modes (MCP, ACP)
        // are in docs/supervisor.md.
        options.supervisor = argv[++i];
        break;
      case "--require-supervisor":
        // When the supervisor is absent — crashed, timed out, not yet bound —
        // refuse rather than fall through to the human. For unattended
        // operation where the supervisor is the only intended reviewer.
        options.requireSupervisor = true;
        break;
      case "--supervisor-mcp":
        // A seat a supervisor claims over MCP, instead of a per-decision command.
        // The bridge prints a supervisor session URL; a client connected there
        // claims the seat and answers pending decisions. See docs/supervisor.md.
        options.seatSupervisor = true;
        break;
      case "--supervisor-mcp-port": {
        // Pin the MCP seat to a fixed port and a known path (/mcp/supervisor) so
        // it can be reached over a tunnel — the credential is then the tunnel
        // capability, not the URL's secrecy. Implies --supervisor-mcp. One fixed
        // port ⇒ one supervised worker process.
        const value = Number(argv[++i]);
        if (!Number.isInteger(value) || value < 0 || value > 65535) {
          process.stderr.write("mcp-acp-bridge: --supervisor-mcp-port must be a port number\n");
          process.exit(2);
        }
        options.supervisorMcpPort = value;
        options.seatSupervisor = true;
        break;
      }
      case "--supervisor-acp": {
        // The same seat, over ACP, for a supervisor that is itself an agent. The
        // bridge opens a TCP endpoint (an optional port follows, else ephemeral)
        // a supervisor ACP client connects to; its disconnect frees the seat.
        const next = argv[i + 1];
        if (typeof next === "string" && /^\d+$/.test(next)) {
          options.supervisorAcp = Number(next);
          i += 1;
        } else {
          options.supervisorAcp = true;
        }
        break;
      }
      case "--supervisor-acp-push": {
        // The push shape: instead of the agent polling a seat, the bridge sends
        // each deferred decision to the agent as a `supervisor/review` request
        // and takes its reply as the verdict. Opens a TCP endpoint (an optional
        // port follows, else ephemeral); its disconnect returns decisions to the
        // human. See docs/supervisor.md.
        const next = argv[i + 1];
        if (typeof next === "string" && /^\d+$/.test(next)) {
          options.supervisorAcpPush = Number(next);
          i += 1;
        } else {
          options.supervisorAcpPush = true;
        }
        break;
      }
      case "--supervisor-timing":
        // Shape the supervisor's response latency to look human: a JSON profile
        // {min,max,dist,...} clipped to [min,max]. See src/supervisorTiming.js.
        try {
          options.supervisorTiming = parseTimingProfile(argv[++i]);
        } catch (error) {
          process.stderr.write(`mcp-acp-bridge: --supervisor-timing ${error.message}\n`);
          process.exit(2);
        }
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
      case "--codex-approval": {
        // codex-mcp only: untrusted (gate every command), on-request (codex asks
        // only to escalate), or never (codex's auto mode — runs unattended, no
        // cards). The equivalent of choosing Claude's auto vs review.
        const v = argv[++i];
        if (!["untrusted", "on-request", "never"].includes(v)) {
          process.stderr.write(`mcp-acp-bridge: --codex-approval must be untrusted|on-request|never\n`);
          process.exit(2);
        }
        options.codexApprovalPolicy = v;
        break;
      }
      case "--codex-sandbox": {
        const v = argv[++i];
        if (!["read-only", "workspace-write", "danger-full-access"].includes(v)) {
          process.stderr.write(`mcp-acp-bridge: --codex-sandbox must be read-only|workspace-write|danger-full-access\n`);
          process.exit(2);
        }
        options.codexSandbox = v;
        break;
      }
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
  const agentName = options.agent ?? process.env.BRIDGE_AGENT ?? "claude";
  // Validate the agent *before* binding a port. In listen mode the adapter is
  // otherwise resolved per connection, so an unknown `--agent` would listen
  // happily and then fail silently on the first connection (logged to stderr,
  // the socket left hanging). Fail loud, at startup, with the list of known
  // agents — `--agent gemini`/`codex` are not adapters (gemini runs via `agy`).
  getAdapter(agentName);
  const tcp = createTcpBridge({
    host,
    port: options.listen,
    agent: agentName,
    cwd: options.cwd ?? process.cwd(),
    codexApprovalPolicy: options.codexApprovalPolicy,
    codexSandbox: options.codexSandbox,
    supervisorTiming: options.supervisorTiming,
    policy: resolvePolicy(options.policy ?? process.env.BRIDGE_POLICY),
    // A supervisor here supervises every per-connection bridge. Without this a
    // `--listen` bridge silently ignored `--supervisor` — the exact deployment
    // the service plugin spawns, and the one that most wants review.
    ...(options.supervisor
      ? {
          supervisor: createSpawnSupervisor({ command: options.supervisor, args: [] }),
          whenSupervisorAbsent: options.requireSupervisor ? "deny" : "human",
        }
      : {}),
    log,
  });
  const { port } = await tcp.listen();
  log(`[bridge] listening for ACP on ${host}:${port}`);
  // stdout is otherwise silent in listen mode (ACP rides the TCP socket, logs
  // go to stderr), so a launcher can read this one line unambiguously.
  if (options.announcePort) process.stdout.write(`${JSON.stringify({ port })}\n`);
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
    seatSupervisor: options.seatSupervisor,
    supervisorAcp: options.supervisorAcp,
    supervisorAcpPush: options.supervisorAcpPush,
    supervisorMcpPort: options.supervisorMcpPort,
    supervisorTiming: options.supervisorTiming,
    ...(options.supervisor
      ? {
          supervisor: createSpawnSupervisor({ command: options.supervisor, args: [] }),
          whenSupervisorAbsent: options.requireSupervisor ? "deny" : "human",
        }
      : {}),
    cwd: options.cwd ?? process.cwd(),
    codexApprovalPolicy: options.codexApprovalPolicy,
    codexSandbox: options.codexSandbox,
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
