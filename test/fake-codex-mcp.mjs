// A minimal stand-in for `codex mcp-server`: enough of the wire protocol to
// exercise createCodexMcpSession without a real codex. Streams one delta, asks
// for one approval, and reports back whether the client approved.
let buf = "";
const send = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const waiting = new Map(); // elicitation id -> tools/call id it blocks
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (line) handle(JSON.parse(line));
  }
});
function handle(m) {
  if (m.method === "initialize") {
    return send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "fake", version: "0" } } });
  }
  if (m.method === "notifications/initialized") return;
  if (m.method === "tools/call") {
    const { name, arguments: a } = m.params;
    if (name === "codex") {
      send({ jsonrpc: "2.0", method: "codex/event", params: { _meta: { threadId: "T1" }, msg: { type: "agent_message_content_delta", thread_id: "T1", delta: "hi " } } });
      const eid = "elicit-1";
      waiting.set(eid, m.id);
      return send({ jsonrpc: "2.0", id: eid, method: "elicitation/create", params: { message: "Allow Codex to run `echo`?", codex_elicitation: "exec-approval", codex_command: ["echo"], threadId: "T1" } });
    }
    if (name === "codex-reply") {
      const content = `recall:${a.threadId}`;
      return send({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: content }], structuredContent: { threadId: a.threadId, content } } });
    }
    return send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: `unknown tool ${name}` } });
  }
  // A response to our elicitation: settle the blocked tools/call with the verdict.
  if (m.id !== undefined && m.result !== undefined && waiting.has(m.id)) {
    const toolId = waiting.get(m.id);
    waiting.delete(m.id);
    const approved = m.result?.decision === "approved" || m.result?.action === "accept";
    const content = approved ? "APPROVED echo" : "DECLINED";
    send({ jsonrpc: "2.0", id: toolId, result: { content: [{ type: "text", text: content }], structuredContent: { threadId: "T1", content } } });
  }
}
