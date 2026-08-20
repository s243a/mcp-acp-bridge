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
const ARROW_DOWN = "\u001b[B";
const ARROW_UP = "\u001b[A";
const PICKER_MARKER = "Switch Model";
const PICKER_END = "Effort";
const PERMISSION_MARKER = "Do you want to proceed?";

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
 * Read a permission prompt agy has raised on screen.
 *
 * The second permission channel. Tools routed through the bridge are decided by
 * the gate, but agy's own tools never pass through it, and a standing grant can
 * silently stop matching — a renamed verb, a new one, a rule agy no longer
 * honours. Either way the turn stops dead waiting for a keystroke, so the
 * prompt is worth catching wherever it appears.
 *
 * Returns the tool being asked about and the numbered choices, each tagged with
 * what answering it means:
 *
 *   allow / deny        — this once
 *   allow_always / deny_always — remembered, for the conversation or on disk
 *
 * Null unless the prompt is fully rendered, since a TUI paints it in pieces and
 * answering half a prompt presses the wrong key.
 */
export function parsePermissionPrompt(screen) {
  const plain = stripAnsi(screen);
  const marker = plain.lastIndexOf(PERMISSION_MARKER);
  if (marker === -1) return null;

  const lines = plain.slice(marker + PERMISSION_MARKER.length).split("\n");
  const options = [];
  for (const rawLine of lines) {
    const line = stripAnsi(rawLine).replace(/\s+$/, "");
    const match = /^\s*>?\s*(\d+)\.\s+(.*)$/.exec(line);
    if (!match) continue;
    const [, digit, label] = match;
    const text = label.trim();
    if (!text) continue;
    const yes = /^yes\b/i.test(text);
    const remembered = /always/i.test(text);
    options.push({
      digit,
      label: text,
      kind: yes ? (remembered ? "allow_always" : "allow") : remembered ? "deny_always" : "deny",
    });
  }

  // Both a yes and a no must be on screen: fewer means a half-painted prompt.
  const hasYes = options.some((option) => option.kind.startsWith("allow"));
  const hasNo = options.some((option) => option.kind.startsWith("deny"));
  if (!hasYes || !hasNo) return null;

  // The tool is named on the last non-empty line before the question.
  const before = plain.slice(0, marker).split("\n").map((line) => stripAnsi(line).trim());
  const tool = before.reverse().find((line) => line.length > 0 && !line.startsWith("─")) ?? "";

  return { tool, options };
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


/**
 * Read agy's model picker off the screen.
 *
 * The picker is a list between its title and the effort slider, with `>`
 * marking the highlighted row. Returns the visible model names and where the
 * cursor sits, which is all that is needed to walk to another entry.
 */
export function parseModelPicker(screen) {
  const plain = stripAnsi(screen);
  const start = plain.lastIndexOf(PICKER_MARKER);
  if (start === -1) return null;

  const items = [];
  let cursor = 0;
  for (const rawLine of plain.slice(start + PICKER_MARKER.length).split("\n")) {
    const line = rawLine.replace(/\s+$/, "");
    if (!line.trim()) continue;
    if (line.includes(PICKER_END)) break;
    const selected = line.trimStart().startsWith(">");
    // "(current)" marks the active model; it is not part of its name.
    const name = line.replace(/^\s*>?\s*/, "").replace(/\s*\(current\)\s*$/, "").trim();
    if (!name) continue;
    if (selected) cursor = items.length;
    items.push(name);
  }
  return items.length ? { items, cursor } : null;
}

export function createPtySession({
  command,
  args = [],
  cwd,
  env,
  onText,
  onPermission,
  log = () => {},
  startupTimeoutMs = 60_000,
  turnTimeoutMs = 600_000,
  settleMs = 2_500,
  cancelSettleMs = 1_500,
}) {
  let child = null;
  let buffer = "";
  let active = null;
  const queue = [];
  let ready = false;
  let readyWaiters = [];
  let settleTimer = null;
  // Everything before this has already been answered. Tracking a position
  // rather than the last prompt's text lets the same tool ask twice.
  let permissionCursor = 0;
  let answering = false;

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
      answerPermissionPrompt();
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

  /**
   * Answer a permission prompt agy is blocked on.
   *
   * A prompt is only answered once — the screen keeps repainting it, and the
   * digit is a keystroke, so a second press would land on whatever replaced it.
   * The decision is the caller's; a caller that declines to decide leaves the
   * prompt alone rather than guessing at an approval.
   */
  function answerPermissionPrompt() {
    if (!onPermission || answering) return;
    const prompt = parsePermissionPrompt(buffer.slice(permissionCursor));
    if (!prompt) return;

    answering = true;
    permissionCursor = buffer.length;
    log(`[pty] permission prompt for ${prompt.tool}`);
    Promise.resolve(onPermission(prompt))
      .then((kind) => {
        const choice = prompt.options.find((option) => option.kind === kind);
        if (!choice) {
          log(`[pty] no option for "${kind}"; leaving the prompt for a human`);
          return;
        }
        log(`[pty] answering ${prompt.tool} with ${choice.digit} (${choice.kind})`);
        child?.write(`${choice.digit}\r`);
      })
      .catch((error) => {
        // Never guess on failure: an unanswered prompt stalls one turn, where a
        // wrong approval runs something nobody agreed to.
        log(`[pty] permission decision failed: ${error?.message ?? error}`);
      })
      .finally(() => {
        answering = false;
      });
  }

  function waitForPicker(timeoutMs = 8_000) {
    const deadline = Date.now() + timeoutMs;
    return new Promise((resolve) => {
      const poll = () => {
        const picker = parseModelPicker(buffer);
        if (picker) return resolve(picker);
        if (Date.now() > deadline) return resolve(null);
        setTimeout(poll, 120);
      };
      poll();
    });
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
            // Retiring the turn is what keeps the session usable — a cancelled
            // turn left active blocks every later one behind it forever.
            if (active === turn) {
              log("[pty] sending ESC to cancel");
              child?.write(ESC);
              clearTimeout(turn.timer);
              active = null;
              reject(new Error("cancelled"));
              // agy needs a beat to unwind back to its prompt; pumping into a
              // still-working screen would type the next turn into the void.
              setTimeout(pump, cancelSettleMs);
              return;
            }
            const queued = queue.indexOf(turn);
            if (queued !== -1) queue.splice(queued, 1);
            reject(new Error("cancelled"));
          },
          { once: true },
        );
        queue.push(turn);
        pump();
      });
    },
    /** Send a slash command, e.g. `/clear`. */
    sendCommand(text) {
      start();
      return whenReady().then(() => {
        log(`[pty] command ${text}`);
        child.write(`${text}\r`);
      });
    },
    /**
     * Switch model through agy's picker.
     *
     * `/model <name>` is not a setter — the argument is ignored and the picker
     * opens regardless, so the only way to choose is to walk the list the way a
     * user would. Names are matched loosely because the screen may abbreviate.
     */
    async selectModel(name) {
      start();
      await whenReady();
      log(`[pty] opening the model picker for ${name}`);
      buffer = "";
      child.write("/model\r");

      const picker = await waitForPicker();
      if (!picker) {
        child.write(ESC);
        throw new Error("the model picker did not open");
      }

      const wanted = String(name).toLowerCase().trim();
      const target = picker.items.findIndex((item) => {
        const candidate = item.toLowerCase();
        return candidate === wanted || candidate.startsWith(wanted) || wanted.startsWith(candidate);
      });
      if (target === -1) {
        // Leaving the picker open would swallow the next turn's keystrokes.
        child.write(ESC);
        throw new Error(`no model matching "${name}" (offered: ${picker.items.join(", ")})`);
      }

      const steps = target - picker.cursor;
      for (let i = 0; i < Math.abs(steps); i += 1) {
        child.write(steps > 0 ? ARROW_DOWN : ARROW_UP);
        await new Promise((resolve) => setTimeout(resolve, 60));
      }
      child.write("\r");
      log(`[pty] selected ${picker.items[target]}`);
      return picker.items[target];
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
