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
    sessions.set(created.sessionId, { abort: null, alwaysAllowed: new Set() });
    // Clients discover the model list from the session response and treat an
    // absent one as a broken agent, so always advertise at least one.
    return { sessionId: created.sessionId, models: modelState() };
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
            title: record.name,
            kind: "other",
            status: record.status,
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

    // An "allow for this session" answer applies without re-asking.
    if (session?.alwaysAllowed.has(call.tool)) {
      emitToolCall(call.sessionId, {
        toolCallId,
        title: call.tool,
        kind: "other",
        status: "in_progress",
      });
      return { allow: true, reason: "allowed for session", toolCallId };
    }

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
        content: [{ type: "content", content: { type: "text", text: prettyArgs(call.args) } }],
      },
      options: PERMISSION_OPTIONS,
    });

    const optionId = readOutcome(response);
    if (!optionId || !ALLOWING_OPTIONS.has(optionId)) {
      emitToolCallUpdate(call.sessionId, { toolCallId, status: "failed" });
      return { allow: false, reason: optionId ? "denied by client" : "cancelled by client", toolCallId };
    }

    if (optionId === "allow-always") session?.alwaysAllowed.add(call.tool);
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

function describeCall(call) {
  return `${call.tool}`;
}

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
