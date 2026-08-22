/**
 * The ACP side of the bridge.
 *
 * Presents as an ACP agent to a client (T3 Code, Zed, …) while the real work
 * happens in a CLI subprocess that knows nothing about ACP. Three jobs:
 *
 *   - answer `initialize`, `session/new`, `session/prompt`, `session/cancel`;
 *   - push `session/update` notifications as the agent produces output;
 *   - raise `session/request_permission` when the gate holds a tool call, and
 *     translate the client's answer back into an allow/deny.
 *
 * That last one is the whole point of the project: a tool call the agent makes
 * over MCP becomes an approval card in a GUI, for an agent that has no idea
 * approvals exist.
 */
import { randomUUID } from "node:crypto";

import { createPeer } from "./jsonRpc.js";

export const PROTOCOL_VERSION = 1;

/** ACP option kinds, in the order a client should present them. */
export const PERMISSION_OPTIONS = [
  { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
  { optionId: "allow-always", name: "Allow for this session", kind: "allow_always" },
  { optionId: "reject-once", name: "Deny", kind: "reject_once" },
];

/**
 * The choices offered for one call.
 *
 * "Allow for this session" is withheld where it has no boundary. The label
 * describes *duration* and says nothing about *breadth* — clicking it on a card
 * reading `run_command ls -la` does not allow `ls`, it stops the review of
 * commands entirely, and the later ones are never shown. For a confined tool
 * that is a bounded promise; for a shell it is not one at all.
 *
 * Which tools qualify is policy, and policy is resolved from the *call* — the
 * session it belongs to, and through that the origin that opened it and the
 * workspace it targets. Never from how the payload arrived: a turn that came
 * down a tunnel and one typed at this machine are the same question, and a
 * setting keyed on transport would answer them differently for no reason a
 * person could defend.
 *
 * @param {(call: {sessionId: string, tool: string}) => boolean} mayRemember
 * @param {{sessionId: string, tool: string}} call
 */
export function optionsFor(mayRemember, call) {
  return mayRemember(call)
    ? PERMISSION_OPTIONS
    : PERMISSION_OPTIONS.filter((option) => option.optionId !== "allow-always");
}

const ALLOWING_OPTIONS = new Set(["allow-once", "allow-always"]);

/**
 * @param {{
 *   input?: NodeJS.ReadableStream,
 *   output?: NodeJS.WritableStream,
 *   runTurn: (ctx: {sessionId: string, prompt: string, signal: AbortSignal,
 *                   emitText: (t: string) => void}) => Promise<{stopReason?: string} | void>,
 *   createSession?: (opts: {cwd?: string}) => Promise<{sessionId: string}> | {sessionId: string},
 *   onSessionEnd?: (sessionId: string) => void,
 * }} options
 */
export function createAcpServer(options) {
  // Whether a tool may be remembered is a policy question, the bridge holds the
  // policy, and the policy is per session — which is what makes it answerable by
  // source and destination later rather than by transport. Defaulting to "no"
  // keeps a host that never wires this from handing out session-wide permission
  // by omission.
  const mayRemember = options.mayRemember ?? (() => false);

  const peer = createPeer({
    input: options.input ?? process.stdin,
    output: options.output ?? process.stdout,
    onError: options.onError,
  });

  /** sessionId -> { abort, alwaysAllowed:Set<string> } */
  const sessions = new Map();

  peer.on("initialize", async (params) => ({
    // Echo the client's version when we can speak it; otherwise state ours.
    protocolVersion: Number.isInteger(params?.protocolVersion)
      ? Math.min(params.protocolVersion, PROTOCOL_VERSION)
      : PROTOCOL_VERSION,
    agentCapabilities: { loadSession: false, promptCapabilities: { image: false, audio: false } },
    authMethods: [],
  }));

  // Clients authenticate unconditionally even when we advertise no methods
  // (T3 Code does this). Accepting is correct: the agent subprocess owns its
  // own credentials, so there is nothing for the bridge to authenticate.
  peer.on("authenticate", async () => ({}));

  peer.on("session/new", async (params) => {
    const created = (await options.createSession?.({ cwd: params?.cwd })) ?? {
      sessionId: randomUUID(),
    };
    sessions.set(created.sessionId, {
      abort: null,
      alwaysAllowed: new Set(),
      review: options.defaultReview ?? "review-everything",
    });
    // Clients discover the model list from the session response and treat an
    // absent one as a broken agent, so always advertise at least one.
    return {
      sessionId: created.sessionId,
      models: modelState(),
      configOptions: configOptions(options.defaultReview),
    };
  });

  peer.on("session/prompt", async (params) => {
    const sessionId = params?.sessionId;
    const session = sessions.get(sessionId);
    if (!session) {
      throw Object.assign(new Error(`unknown session: ${sessionId}`), { code: -32602 });
    }

    const controller = new AbortController();
    session.abort = controller;

    try {
      // First sighting of a tool id is a tool_call; later ones update it.
      const announced = new Set();
      const result = await options.runTurn({
        sessionId,
        prompt: promptToText(params.prompt),
        signal: controller.signal,
        emitText: (text) => emitAgentText(sessionId, text),
        emitTool: (record) => {
          const toolCall = {
            toolCallId: record.id,
            // Same reasoning as the approval card: a transcript full of bare
            // tool names says what kind of thing happened and never what.
            title: describeCall({ tool: record.name, args: record.args }),
            kind: "other",
            status: record.status,
            rawInput: record.args ?? {},
            content: [
              { type: "content", content: { type: "text", text: prettyArgs(record.args) } },
            ],
          };
          if (announced.has(record.id)) {
            emitToolCallUpdate(sessionId, { toolCallId: record.id, status: record.status });
          } else {
            announced.add(record.id);
            emitToolCall(sessionId, toolCall);
          }
        },
      });
      return { stopReason: result?.stopReason ?? "end_turn" };
    } catch (error) {
      if (controller.signal.aborted) return { stopReason: "cancelled" };

      // An agent that fails its turn is a RESULT, not a transport failure.
      // Answering with a JSON-RPC error leaves clients that do not treat one as
      // a turn outcome waiting forever on a turn that already ended — observed
      // against T3 Code, where a denied `run_command` hung the thread on
      // "Working" indefinitely. Report it as a refusal and say why in the
      // transcript, so the turn closes and the user can see the reason.
      const detail = String(error?.message ?? error);
      options.onError?.(error, "session/prompt");
      emitAgentText(sessionId, `\n[agent failed: ${detail}]\n`);
      return { stopReason: "refusal" };
    } finally {
      session.abort = null;
    }
  });

  // Clients change per-turn settings through config options; the bridge treats
  // an unknown option as a no-op rather than an error, so a client offering more
  // pickers than this agent understands still works.
  peer.on("session/set_config_option", async (params) => {
    const session = sessions.get(params?.sessionId);
    if (params?.configId === "review" && typeof params?.value === "string" && session) {
      session.review = params.value;
    }
    options.onConfigOption?.({
      sessionId: params?.sessionId,
      configId: params?.configId,
      value: params?.value,
    });
    // The full set, with current values — an empty response fails the client's
    // schema and ends the session.
    return { configOptions: configOptions(session?.review) };
  });

  peer.on("session/set_model", async (params) => {
    // The client picks from a list it was given; only the agent knows how to
    // act on it, so this is a pass-through rather than a validated choice.
    await options.onSetModel?.({ sessionId: params?.sessionId, modelId: params?.modelId });
    return {};
  });

  peer.on("session/cancel", (params) => {
    sessions.get(params?.sessionId)?.abort?.abort();
  });

  function emitAgentText(sessionId, text) {
    if (!text) return;
    peer.notify("session/update", {
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text },
      },
    });
  }

  function emitToolCall(sessionId, toolCall) {
    peer.notify("session/update", {
      sessionId,
      update: { sessionUpdate: "tool_call", ...toolCall },
    });
  }

  function emitToolCallUpdate(sessionId, toolCall) {
    peer.notify("session/update", {
      sessionId,
      update: { sessionUpdate: "tool_call_update", ...toolCall },
    });
  }

  /**
   * The gate decider. Raises a permission request and waits for the client.
   *
   * Returning `{allow:false}` on anything unexpected is deliberate — see
   * gate.js. This function never throws its way into an approval.
   */
  async function decide(call) {
    const session = sessions.get(call.sessionId);
    const toolCallId = `call-${randomUUID()}`;

    // An "allow for this session" answer applies without re-asking — but only
    // while the policy that permitted it still would. The set is a cache of a
    // decision, not a grant that outlives its reason: a session whose policy is
    // replaced mid-flight (which per-origin policy makes ordinary) must not keep
    // bypassing review under rules that no longer permit it.
    //
    // The same asymmetry as everywhere else: a refusal binds carefully, so an
    // allow must not bind harder than the thing that allowed it.
    if (session?.alwaysAllowed.has(call.tool) && !mayRemember({ sessionId: call.sessionId, tool: call.tool })) {
      session.alwaysAllowed.delete(call.tool);
    }
    if (session?.alwaysAllowed.has(call.tool)) {
      emitToolCall(call.sessionId, {
        toolCallId,
        title: call.tool,
        kind: "other",
        status: "in_progress",
      });
      return { allow: true, reason: "allowed for session", toolCallId };
    }

    // Say so in the transcript before asking, so the reason the card looks
    // unusual is on screen next to it rather than only in a log.
    if (call.viaTerminal) emitAgentText(call.sessionId, terminalChannelNotice(call.tool));

    emitToolCall(call.sessionId, {
      toolCallId,
      title: describeCall(call),
      kind: "other",
      status: "pending",
    });

    const response = await peer.request("session/request_permission", {
      sessionId: call.sessionId,
      toolCall: {
        toolCallId,
        title: describeCall(call),
        kind: "other",
        status: "pending",
        // The structured form, which is what a client reads when it wants the
        // command rather than a sentence about it. Sending only `content` left
        // clients with a card headed by a bare tool name.
        rawInput: call.args ?? {},
        content: [{ type: "content", content: { type: "text", text: prettyArgs(call.args) } }],
      },
      options: optionsFor(mayRemember, { sessionId: call.sessionId, tool: call.tool }),
    });

    const optionId = readOutcome(response);
    if (!optionId || !ALLOWING_OPTIONS.has(optionId)) {
      emitToolCallUpdate(call.sessionId, { toolCallId, status: "failed" });
      return { allow: false, reason: optionId ? "denied by client" : "cancelled by client", toolCallId };
    }

    // Asked again rather than trusted: the option list is what a client was
    // told it may send, and nothing stops one answering `allow-always` anyway.
    // An answer we did not offer is honoured as a single allow.
    if (optionId === "allow-always" && mayRemember({ sessionId: call.sessionId, tool: call.tool })) {
      session?.alwaysAllowed.add(call.tool);
    }
    emitToolCallUpdate(call.sessionId, { toolCallId, status: "in_progress" });
    return { allow: true, reason: optionId, toolCallId };
  }

  return {
    peer,
    decide,
    emitAgentText,
    emitToolCall,
    emitToolCallUpdate,
    hasSession: (id) => sessions.has(id),
    closeSession(id) {
      sessions.get(id)?.abort?.abort();
      sessions.delete(id);
      options.onSessionEnd?.(id);
    },
  };
}

/**
 * Session configuration options, in ACP's own vocabulary.
 *
 * A client that offers a picker expects the full set back on every change —
 * `SetSessionConfigOptionResponse` requires `configOptions`, and answering with
 * an empty object fails its schema and takes the whole session down with it.
 */
function configOptions(currentReview = "review-everything") {
  return [
    {
      id: "review",
      name: "Review",
      description: "Which tool calls stop for approval before they run.",
      type: "select",
      currentValue: currentReview,
      options: [
        { value: "review-everything", name: "Everything", description: "Approve every tool call." },
        {
          value: "review-consequential",
          name: "Consequential only",
          description: "Reads run freely; writes, commands and network stop for approval.",
        },
        {
          value: "allow-all",
          name: "Nothing",
          description: "Approve automatically. Only sensible when something else gates.",
        },
      ],
    },
  ];
}

/**
 * The model list a client sees. The bridge does not choose models — the agent
 * CLI does, from its own config — so this advertises the bridge itself as the
 * single choice rather than inventing a menu it cannot honour.
 */
function modelState() {
  return {
    currentModelId: "bridge-agent",
    availableModels: [
      {
        modelId: "bridge-agent",
        name: "Bridge agent",
        description: "Whichever CLI this bridge was started with.",
      },
    ],
  };
}

/** ACP sends prompts as content blocks; the CLI wants one string. */
function promptToText(prompt) {
  if (typeof prompt === "string") return prompt;
  if (!Array.isArray(prompt)) return "";
  return prompt
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
}

/** Arguments worth putting in a title, most identifying first. */
const SALIENT_KEYS = ["command", "path", "file", "url", "query", "name"];

/**
 * What this call is *about*, in one line.
 *
 * A card headed `read_file` tells nobody anything: the entire argument for
 * routing work through MCP is that the reviewer sees what will happen, and the
 * tool's name is the part they already knew.
 *
 * @param {{tool: string, args?: Record<string, unknown>}} call
 */
function summariseArgs(call) {
  const args = call.args ?? {};
  for (const key of SALIENT_KEYS) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) {
      const trimmed = value.trim();
      return trimmed.length > 120 ? `${trimmed.slice(0, 120)}…` : trimmed;
    }
  }
  const first = Object.entries(args).find(([, value]) => typeof value === "string" && value.trim());
  return first ? `${first[0]}=${String(first[1]).slice(0, 80)}` : "";
}

function describeCall(call) {
  const about = summariseArgs(call);
  // Deliberately unquoted. A client looking for a command in a title takes the
  // first backticked run it finds, so `write_file \`notes.md\`` reduces to
  // `notes.md` and the card asks you to approve a markdown file rather than a
  // write to one. Commands do not need the hint: their `rawInput.command` is
  // read before any title is consulted.
  const titled = about ? `${call.tool} ${about}` : `${call.tool}`;
  // A request that arrived on the terminal says so on the card itself: the
  // approval still works, and the anomaly would otherwise go unnoticed.
  return call.viaTerminal ? `${titled} (asked on the terminal)` : titled;
}

/**
 * Why a terminal-channel request is worth remarking on.
 *
 * Not an error: answering it works and the turn continues. It means the agent
 * asked the way it would ask a human, instead of through the tool channel —
 * which normally follows a permission rule that has stopped matching, whether a
 * renamed tool, a new one, or configuration that did not take.
 */
export const terminalChannelNotice = (tool) =>
  `\n[permission] "${tool}" was asked for on the agent's terminal rather than through the tool ` +
  `channel. Answering here works, but this usually means a permission rule no longer matches — ` +
  `worth checking the agent's configuration.\n`;

function prettyArgs(args) {
  try {
    const text = JSON.stringify(args ?? {}, null, 2);
    // Never let an enormous argument blob push the real request off-screen.
    return text.length > 4000 ? `${text.slice(0, 4000)}\n… truncated` : text;
  } catch {
    return String(args);
  }
}

/**
 * Read the selected option from a permission response.
 *
 * Accepts the spec shape `{outcome:{outcome:"selected",optionId}}` and the
 * flatter shapes some clients send. Anything unrecognised returns null, which
 * the caller treats as a denial.
 */
function readOutcome(response) {
  const outcome = response?.outcome;
  if (typeof outcome === "string") return outcome === "cancelled" ? null : response.optionId ?? null;
  if (outcome && typeof outcome === "object") {
    if (outcome.outcome === "cancelled") return null;
    if (typeof outcome.optionId === "string") return outcome.optionId;
  }
  return typeof response?.optionId === "string" ? response.optionId : null;
}
