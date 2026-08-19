/**
 * An agent driven through a pseudo-terminal.
 *
 * The structured stdio channel cannot carry an interrupt or a slash command: it
 * is busy carrying data. A PTY can, which is the whole reason this exists —
 * ESC actually stops a turn, and `/model` actually changes one, instead of the
 * bridge killing the process and calling it cancellation.
 *
 * What it costs is prose. A TUI redraws, so the answer arrives shredded across
 * spinner frames and cursor moves rather than as clean deltas. What comes out
 * of here is a best-effort reconstruction and should be treated as such; the
 * stream-json profiles remain the better choice when reading matters more than
 * steering.
 *
 * MCP is unaffected either way — it is an HTTP connection, not a stdio one — so
 * tool calls the agent makes through the bridge stay structured and gateable
 * even here.
 */
import pty from "node-pty";

/** agy's status line is an explicit state machine; far better than guessing at idle. */
const WORKING_MARKER = "esc to cancel";
const IDLE_MARKER = "? for shortcuts";

/**
 * Words the TUI animates, which redraws shred into fragments like "enerat" or
 * "ting..". Any contiguous piece of one is chrome, not content.
 */
const ANIMATED_WORDS = ["Generating...", "Signing in...", "Verifying..."];

function isAnimationFragment(line) {
  if (line.length < 2 || line.length > 16) return false;
  return ANIMATED_WORDS.some((word) => word.includes(line));
}

/** Terminal chrome that is never part of an answer. */
const CHROME = [
  /^[\s⣾⣷⣯⣟⡿⢿⣻⣽]*$/u,
  /^─+$/u,
  /^>\s*$/u,
  /^\?\s*for shortcuts/u,
  /^esc to cancel/u,
  /^└\s*Tip:/u,
  /Generating\.\.\./u,
  /^[▄▀\s]+/u,
  // The status line: model name and reasoning effort.
  /^Gemini\s.*·\s*(high|medium|low)/iu,
];

const ESC = "\u001b";

export function stripAnsi(text) {
  // Anchored on the escape character itself. Matching the bare bracket forms
  // would eat `>` and `=` out of the agent's own prose.
  return text
    .replace(new RegExp(`${ESC}\\][^\\u0007]*\\u0007?`, "g"), "")
    // CSI: parameter bytes, then optional intermediates (agy emits `ESC[0 q`),
    // then the final byte.
    .replace(new RegExp(`${ESC}\\[[0-9;?=><]*[ -/]*[@-~]`, "g"), "")
    .replace(new RegExp(`${ESC}[()][AB0]`, "g"), "")
    .replace(new RegExp(`${ESC}[=>]`, "g"), "")
    // Two-character escapes: ESC M (reverse index) and friends move the cursor
    // during a redraw and are not part of any answer.
    .replace(new RegExp(`${ESC}[@-Z\\\\^_]`, "g"), "")
    // Backspace and bell are how a redraw erases; keeping them corrupts text.
    .replace(/[\u0008\u0007]/g, "");
}


/**
 * Recover the answer from a turn's worth of terminal output.
 *
 * Deliberately conservative: drop what is recognisably chrome and keep the
 * rest. Inventing structure the terminal did not clearly show would be worse
 * than handing back something slightly ragged.
 */
export function extractAnswer(raw, { fromWorkingMarker = true } = {}) {
  // The worst mangling is the echo of what we typed: the terminal reflows the
  // input line as it is entered, so it arrives shredded. Everything before the
  // agent starts working is input, not answer — dropping it removes most of the
  // damage without needing to emulate a screen.
  if (fromWorkingMarker) {
    const plain = stripAnsi(raw);
    const started = plain.indexOf(WORKING_MARKER);
    if (started !== -1) return extractAnswer(plain.slice(started + WORKING_MARKER.length), {
      fromWorkingMarker: false,
    });
  }
  const seen = new Set();
  const lines = [];
  for (const line of stripAnsi(raw).split(/\r?\n/)) {
    const trimmed = line.replace(/\r/g, "").trim();
    if (!trimmed) continue;
    if (CHROME.some((pattern) => pattern.test(trimmed))) continue;
    if (isAnimationFragment(trimmed)) continue;
    // Redraws repeat lines verbatim; keep the first sighting only.
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    lines.push(trimmed);
  }
  return lines.join("\n");
}

export function createPtySession({
  command,
  args = [],
  cwd,
  env,
  onText,
  log = () => {},
  startupTimeoutMs = 60_000,
  turnTimeoutMs = 600_000,
  settleMs = 2_500,
}) {
  let child = null;
  let buffer = "";
  let active = null;
  const queue = [];
  let ready = false;
  let readyWaiters = [];
  let settleTimer = null;

  function start() {
    if (child) return;
    log(`[pty] starting ${command}`);
    child = pty.spawn(command, args, {
      name: "xterm-256color",
      cols: 120,
      rows: 40,
      cwd,
      env: { ...process.env, ...env },
    });

    child.onData((data) => {
      if (process.env.BRIDGE_PTY_DEBUG) process.stderr.write(data);
      buffer += data;
      const plain = stripAnsi(buffer);

      if (!ready) {
        // The prompt renders before sign-in finishes, so the idle marker alone
        // is not readiness. Submitting during sign-in gets the turn answered
        // with "verifying your account eligibility" instead of a response.
        // Wait for the marker AND for output to stop changing.
        if (!plain.includes(IDLE_MARKER) || settleTimer) return;
        // A fixed grace period from the first sighting, not a quiet period:
        // the status line animates continuously, so output never goes silent.
        settleTimer = setTimeout(() => {
          ready = true;
          buffer = "";
          log("[pty] agent ready");
          readyWaiters.splice(0).forEach((resolve) => resolve());
        }, settleMs);
        return;
      }
      if (!active) return;
      active.output += data;

      // Seeing the working marker first, then idle, is a completed turn. Idle
      // alone could just be the prompt we started from.
      if (!active.sawWorking && plain.includes(WORKING_MARKER)) active.sawWorking = true;
      if (active.sawWorking && plain.includes(IDLE_MARKER)) finishTurn();
    });

    child.onExit(({ exitCode }) => {
      child = null;
      ready = false;
      const waiting = active ? [active, ...queue] : [...queue];
      active = null;
      queue.length = 0;
      for (const turn of waiting) turn.reject(new Error(`${command} exited (${exitCode})`));
    });
  }

  function finishTurn() {
    const turn = active;
    active = null;
    clearTimeout(turn.timer);
    const cleaned = extractAnswer(turn.output);
    if (cleaned) onText?.(cleaned);
    turn.resolve({ text: cleaned });
    pump();
  }

  function whenReady() {
    if (ready) return Promise.resolve();
    return new Promise((resolve, reject) => {
      readyWaiters.push(resolve);
      setTimeout(() => reject(new Error(`${command} did not become ready`)), startupTimeoutMs);
    });
  }

  function pump() {
    if (active || queue.length === 0) return;
    start();
    whenReady().then(
      () => {
        if (active || queue.length === 0) return;
        active = queue.shift();
        active.timer = setTimeout(() => {
          if (active) finishTurn();
        }, turnTimeoutMs);
        buffer = "";
        child.write(`${active.prompt}\r`);
      },
      (error) => {
        queue.splice(0).forEach((turn) => turn.reject(error));
      },
    );
  }

  return {
    /**
     * Launch without a typed turn. Callers that deliver the first prompt as a
     * command-line argument need the process running with nothing queued.
     */
    start() {
      start();
    },
    prompt(text, { signal } = {}) {
      return new Promise((resolve, reject) => {
        const turn = { prompt: text, output: "", sawWorking: false, resolve, reject, timer: null };
        signal?.addEventListener(
          "abort",
          () => {
            // The point of this transport: stop the turn, keep the session.
            if (active === turn) {
              log("[pty] sending ESC to cancel");
              child?.write(ESC);
            }
            reject(new Error("cancelled"));
          },
          { once: true },
        );
        queue.push(turn);
        pump();
      });
    },
    /** Send a slash command, e.g. `/model gemini-3-pro`. */
    sendCommand(text) {
      start();
      return whenReady().then(() => {
        log(`[pty] command ${text}`);
        child.write(`${text}\r`);
      });
    },
    running: () => child !== null,
    stop() {
      queue.length = 0;
      active = null;
      if (!child) return;
      child.kill();
      child = null;
    },
  };
}
