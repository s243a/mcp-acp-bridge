/**
 * Carrying a turn over MCP instead of over the terminal.
 *
 * Typing a prompt into a TUI and reading the answer back off the screen is the
 * fragile part of driving an agent through a terminal: input is echoed and
 * reflowed as it is entered, and output is shredded by redraws. Both problems
 * disappear if the turn travels over MCP, which is structured by construction.
 *
 * Two tools do it. `next_task` hands the agent the prompt; `submit_result`
 * hands the answer back. The terminal is then left carrying only what nothing
 * else can carry — a nudge to start, ESC to interrupt, and slash commands.
 *
 * These are transport, not actions, so they are never gated. Asking a human to
 * approve "may the agent read its instructions" would be asking about the wrong
 * thing, and a denial would strand the turn rather than prevent anything.
 */

export const TASK_TOOL = "next_task";
export const RESULT_TOOL = "submit_result";

/** Tool names that carry the turn itself and must bypass review. */
export const TRANSPORT_TOOLS = new Set([TASK_TOOL, RESULT_TOOL]);

export function createTaskChannel({ log = () => {}, waitTimeoutMs = 600_000 } = {}) {
  /** sessionId -> { prompt, resolve, reject, delivered, timer } */
  const pending = new Map();

  function toolDefinitions() {
    return [
      {
        name: TASK_TOOL,
        description:
          "Get the task you are being asked to carry out. Call this first, before doing anything else. Returns the request text.",
        inputSchema: { type: "object", properties: {} },
        handler: async (_args, context) => takeTask(context?.sessionId),
      },
      {
        name: RESULT_TOOL,
        description:
          "Report the finished answer for the task you were given. Call this exactly once when the work is complete, with your full response as `result`.",
        inputSchema: {
          type: "object",
          properties: {
            result: { type: "string", description: "The complete answer for the user." },
          },
          required: ["result"],
        },
        handler: async (args, context) => submit(context?.sessionId, args?.result ?? ""),
      },
    ];
  }

  /** Queue a turn and wait for the agent to submit its answer. */
  function runTurn(sessionId, prompt, { signal } = {}) {
    return new Promise((resolve, reject) => {
      const entry = {
        prompt,
        resolve,
        reject,
        delivered: false,
        timer: setTimeout(() => {
          pending.delete(sessionId);
          reject(new Error(`agent did not submit a result within ${waitTimeoutMs}ms`));
        }, waitTimeoutMs),
      };
      pending.set(sessionId, entry);
      signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(entry.timer);
          pending.delete(sessionId);
          reject(new Error("cancelled"));
        },
        { once: true },
      );
    });
  }

  function takeTask(sessionId) {
    const entry = pending.get(sessionId);
    if (!entry) {
      // Not an error: an agent that asks again after finishing should be told
      // there is nothing to do, not handed the last task a second time.
      return "No task is pending. Wait to be asked.";
    }
    entry.delivered = true;
    log(`[task] delivered to ${sessionId}`);
    return entry.prompt;
  }

  function submit(sessionId, result) {
    const entry = pending.get(sessionId);
    if (!entry) return "No task was pending; nothing to submit.";

    // An empty answer is worse than a wrong one: the turn completes, there is
    // nothing to render, and the user sees silence with no way to tell whether
    // anything ran at all. Ask once — agents do submit blank results, and the
    // retry usually carries the answer they meant to send.
    if (result.trim().length === 0 && !entry.askedForContent) {
      entry.askedForContent = true;
      log(`[task] empty result for ${sessionId}; asking again`);
      return (
        "Your result was empty, so nothing was reported. " +
        "Call submit_result again with your full answer as `result`."
      );
    }

    clearTimeout(entry.timer);
    pending.delete(sessionId);
    log(`[task] result submitted for ${sessionId} (${result.length} chars)`);
    // Taken the second time whatever it says, so a stubbornly silent agent ends
    // its turn instead of hanging; the caller reports the emptiness.
    entry.resolve({ text: result, empty: result.trim().length === 0 });
    return "Result recorded. Stop here and wait for the next task.";
  }

  return {
    toolDefinitions,
    runTurn,
    hasPending: (sessionId) => pending.has(sessionId),
    /** Whether the agent has actually fetched the task it was given. */
    wasDelivered: (sessionId) => pending.get(sessionId)?.delivered === true,
  };
}
