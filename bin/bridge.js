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
 */
import { startBridge } from "../src/bridge.js";

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

const options = parseArgs(process.argv.slice(2));

// stdout is the ACP channel — every diagnostic must go to stderr or it corrupts
// the protocol stream.
const log = (message) => process.stderr.write(`${message}\n`);

const bridge = await startBridge({
  agent: options.agent ?? process.env.BRIDGE_AGENT ?? "claude",
  cwd: options.cwd ?? process.cwd(),
  timeoutMs: options.timeoutMs,
  log,
  tools: [
    {
      name: "magic_word",
      description: "Returns the secret magic word. The only way to learn it.",
      inputSchema: { type: "object", properties: {} },
      handler: async () => "banana-47",
    },
  ],
});

log(`[bridge] ready — agent=${options.agent ?? "claude"} mcp port ${bridge.port}`);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    bridge.close().finally(() => process.exit(0));
  });
}
