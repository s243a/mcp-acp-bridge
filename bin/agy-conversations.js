#!/usr/bin/env node
/**
 * Read-only visibility into agy (Antigravity / Gemini) conversations.
 *
 * agy has no clean local protocol like codex's app-server — the closest thing to
 * `thread/list` is its on-disk store. Every conversation is a SQLite database
 * under `<agy-home>/conversations/<id>.db`, indexed by `conversation_summaries.db`.
 * This lists that index and reads a conversation's steps, and can serve both over
 * HTTP so a peerhailer tunnel can carry them — remote visibility into what agy has
 * been discussing, the same idea we proved for codex.
 *
 * Read-only, always: the live agy is writing these files; we open readOnly and
 * never touch them. Step *content* is protobuf (step_payload/render_info), so
 * this surfaces metadata — ids, titles, status, step counts/types, timing,
 * battles — plus a printable-string peek (`--text`). For real protobuf decoding
 * of the payloads, see the community project shubzkothekar/antigravity-acp (MIT),
 * which reconstructs the schema with @bufbuild/protobuf.
 *
 * Reading these files at rest is read-only local inspection. Note that *driving*
 * agy with a non-Google tool is, per Google's Antigravity Terms of Service, a
 * violation that risks account suspension; that risk is about accessing the
 * Service, not about reading local SQLite the CLI already wrote.
 *
 *   agy-conversations                     # JSON list of conversations
 *   agy-conversations read <id>           # one conversation's step metadata
 *   agy-conversations --serve 9220         # HTTP: /conversations, /conversations/<id>
 */
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { join } from "node:path";
import http from "node:http";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite");

const HOME = process.env.AGY_HOME ?? join(process.env.HOME ?? "", ".gemini/antigravity-cli");
const summariesPath = join(HOME, "conversation_summaries.db");
const convDir = join(HOME, "conversations");

function openRO(path) {
  if (!existsSync(path)) throw new Error(`not found: ${path}`);
  return new DatabaseSync(path, { readOnly: true });
}

/** The conversation index — newest first. */
function listConversations({ limit = 50 } = {}) {
  const db = openRO(summariesPath);
  try {
    const rows = db
      .prepare(
        `SELECT conversation_id, title, preview, step_count, status, agent_name,
                workspace_uris, project_id, battle_id, winning_conversation_id,
                parent_conversation_id, nesting_depth, not_fully_idle, killed,
                last_modified_time, last_user_input_time
         FROM conversation_summaries
         ORDER BY last_modified_time DESC
         LIMIT ?`,
      )
      .all(limit);
    return rows.map((r) => ({
      id: r.conversation_id,
      title: r.title || null,
      preview: r.preview || null,
      agent: r.agent_name || null,
      status: r.status || null,
      steps: r.step_count,
      active: !!r.not_fully_idle,
      killed: !!r.killed,
      battleId: r.battle_id || null,
      winner: r.winning_conversation_id || null,
      parent: r.parent_conversation_id || null,
      nesting: r.nesting_depth,
      workspaces: safeSplit(r.workspace_uris),
      project: r.project_id || null,
      lastModified: r.last_modified_time,
      lastInput: r.last_user_input_time,
      hasDb: existsSync(join(convDir, `${r.conversation_id}.db`)),
    }));
  } finally {
    db.close();
  }
}

/** One conversation's steps — metadata only (payloads are protobuf). */
function readConversation(id, { text = false } = {}) {
  if (!/^[0-9a-fA-F-]{8,64}$/.test(id)) throw new Error("bad conversation id");
  const path = join(convDir, `${id}.db`);
  const db = openRO(path);
  try {
    const cols = text
      ? `idx, step_type, status, has_subtrajectory, step_payload, render_info, task_details,
         length(step_payload) AS payload_bytes, length(render_info) AS render_bytes, length(task_details) AS task_bytes`
      : `idx, step_type, status, has_subtrajectory,
         length(step_payload) AS payload_bytes, length(render_info) AS render_bytes, length(task_details) AS task_bytes`;
    const steps = db.prepare(`SELECT ${cols} FROM steps ORDER BY idx`).all();
    let summary = null;
    try {
      const s = openRO(summariesPath);
      summary = s.prepare(`SELECT * FROM conversation_summaries WHERE conversation_id = ?`).get(id) ?? null;
      s.close();
    } catch {}
    return {
      id,
      summary,
      stepCount: steps.length,
      steps: steps.map((s) => ({
        idx: s.idx,
        type: s.step_type,
        typeName: STEP_TYPE_NAMES[s.step_type] ?? null,
        status: s.status,
        statusName: STATUS_NAMES[s.status] ?? null,
        subtrajectory: !!s.has_subtrajectory,
        bytes: { payload: s.payload_bytes ?? 0, render: s.render_bytes ?? 0, task: s.task_bytes ?? 0 },
        ...(text
          ? { text: [extractText(s.step_payload), extractText(s.task_details), extractText(s.render_info)].filter(Boolean).join(" \u00b7 ").slice(0, 2000) }
          : {}),
      })),
    };
  } finally {
    db.close();
  }
}

// step_type / status integers, mapped from the reverse-engineered schema in the
// community project shubzkothekar/antigravity-acp (MIT). Content decoding proper
// lives there (@bufbuild/protobuf); this file stays zero-dependency and labels.
const STEP_TYPE_NAMES = {
  5: "write_file",
  7: "grep_search",
  8: "view_file",
  9: "list_dir",
  14: "user_prompt",
  15: "agent_text",
  21: "run_command",
  31: "read_url",
  33: "search_web",
  90: "lifecycle",
  98: "lifecycle",
  101: "lifecycle",
  127: "invoke_subagent",
  138: "ask_question",
};
const STATUS_NAMES = { 2: "in_progress", 3: "completed", 6: "cancelled", 7: "failed" };

/**
 * A printable-string peek at a protobuf blob. agy's step payloads are protobuf,
 * and text fields survive as readable byte runs, so this recovers the gist — the
 * prompt, the message — without the schema. Approximate on purpose; replace with
 * real decoding once the proto is known.
 */
function extractText(buf, min = 6) {
  if (!buf || !buf.length) return "";
  const runs = [];
  let cur = "";
  for (const b of buf) {
    if (b >= 32 && b < 127) cur += String.fromCharCode(b);
    else {
      if (cur.length >= min) runs.push(cur);
      cur = "";
    }
  }
  if (cur.length >= min) runs.push(cur);
  return runs.join(" ").replace(/\s+/g, " ").trim();
}

function safeSplit(v) {
  if (!v) return [];
  try {
    const j = JSON.parse(v);
    return Array.isArray(j) ? j : [String(v)];
  } catch {
    return String(v)
      .split(/[,\s]+/)
      .filter(Boolean);
  }
}

// --- CLI / server ---
const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
};
const servePort = flag("--serve");
const host = flag("--host") ?? "127.0.0.1";
const limit = Number(flag("--limit") ?? 50);

if (servePort) {
  const port = Number(servePort);
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    const send = (code, body) => {
      res.writeHead(code, { "Content-Type": "application/json", Vary: "Origin" });
      res.end(JSON.stringify(body));
    };
    try {
      if (url.pathname === "/healthz") return send(200, { status: "ok", home: HOME });
      if (url.pathname === "/conversations")
        return send(200, { data: listConversations({ limit: Number(url.searchParams.get("limit") ?? limit) }) });
      const m = url.pathname.match(/^\/conversations\/([^/]+)$/);
      if (m) return send(200, readConversation(decodeURIComponent(m[1]), { text: url.searchParams.get("text") === "1" }));
      send(404, { error: "not found" });
    } catch (e) {
      send(500, { error: String(e.message ?? e) });
    }
  });
  server.listen(port, host, () => {
    process.stderr.write(`[agy-conversations] serving ${HOME} on ${host}:${server.address().port}\n`);
    if (host !== "127.0.0.1" && host !== "localhost")
      process.stderr.write(`[agy-conversations] warning: ${host} is not loopback (read-only, but still your data)\n`);
  });
  for (const s of ["SIGINT", "SIGTERM"]) process.on(s, () => server.close(() => process.exit(0)));
} else if (argv[0] === "read") {
  process.stdout.write(JSON.stringify(readConversation(argv[1], { text: argv.includes("--text") }), null, 2) + "\n");
} else {
  process.stdout.write(JSON.stringify(listConversations({ limit }), null, 2) + "\n");
}
