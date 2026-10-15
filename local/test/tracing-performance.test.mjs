import test from "node:test";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { distImport } from "./_helpers.mjs";

const { openDb } = await distImport("store/db.js");
const { createStore } = await distImport("store/index.js");
const { startHerdrSync } = await distImport("herdr/sync.js");
const { createIngestDeps, ingest, ingestHook } = await distImport("ingest/pipeline.js");

function captureSql(db) {
  const sql = [];
  const prepare = db.prepare.bind(db);
  db.prepare = (query) => { sql.push(query); return prepare(query); };
  return sql;
}

test("a long-running open pane backfills history without rebuilding unchanged links", (t) => {
  // Given the verifier's 96-hour pane and 2,000 sequential sessions from 72 hours ago.
  const now = 1_000_000_000, hour = 3_600_000;
  t.mock.method(Date, "now", () => now);
  const db = openDb(":memory:");
  db.prepare("INSERT INTO herdr_panes (id,cwd,created_ms,last_seen_ms,agent) VALUES (?,?,?,?,?)")
    .run("long-running", "/repo", now - 96 * hour, now - 96 * hour, "claude");
  const insert = db.prepare("INSERT INTO sessions (id,runtime,cwd,started_at,ended_at) VALUES (?,'claude-code','/repo',?,?)");
  db.exec("BEGIN");
  for (let i = 0; i < 2000; i++) insert.run(`s${i}`, now - 72 * hour + i * 1000, now - 72 * hour + i * 1000 + 500);
  db.exec("COMMIT");
  const sync = startHerdrSync(db, { env: { GISOOL_HERDR_SOCKET: "/tmp/gst-performance-absent.sock" }, log() {} });
  t.after(() => { sync.close(); db.close(); });
  sync.linkSessions();
  assert.equal(db.prepare("SELECT count(*) n FROM pane_sessions").get().n, 2000);
  db.exec(`CREATE TEMP TABLE changed_links (id TEXT);
    CREATE TEMP TRIGGER count_delete AFTER DELETE ON pane_sessions BEGIN INSERT INTO changed_links VALUES (old.session_id); END;
    CREATE TEMP TRIGGER count_update AFTER UPDATE ON pane_sessions BEGIN INSERT INTO changed_links VALUES (old.session_id); END;`);
  // When an unchanged pass runs, no historical link should be rewritten.
  const begin = performance.now();
  sync.linkSessions();
  const elapsedMs = performance.now() - begin;
  const changed = db.prepare("SELECT count(*) n FROM changed_links").get().n;
  t.diagnostic(JSON.stringify({ elapsedMs, changed, links: 2000 }));
  // Then the no-change pass is bounded and retains all 2,000 original rows.
  assert.ok(elapsedMs < 250, `unchanged open-pane pass took ${elapsedMs}ms`);
  assert.equal(changed, 0);
  assert.equal(db.prepare("SELECT count(*) n FROM pane_sessions").get().n, 2000);
});

test("linking revisits only eligible lifetimes and touched sessions, preserving historical links", (t) => {
  // Given historical, recent-closed, and still-open pane lifetimes.
  const now = 1_000_000_000, hour = 3_600_000;
  t.mock.method(Date, "now", () => now);
  const db = openDb(":memory:");
  const addPane = db.prepare("INSERT INTO herdr_panes (id,cwd,created_ms,closed_ms,last_seen_ms) VALUES (?,?,?,?,?)");
  addPane.run("history", "/history", now - 72 * hour, now - 48 * hour, now - 48 * hour);
  addPane.run("recent", "/recent", now - 2 * hour, now - hour, now - hour);
  addPane.run("open", "/open", now - 72 * hour, null, now - 72 * hour);
  const addSession = db.prepare("INSERT INTO sessions (id,runtime,cwd,started_at,ended_at) VALUES (?,'codex',?,?,?)");
  addSession.run("history", "/history", now - 70 * hour, now - 69 * hour);
  addSession.run("touched", "/history", now - 68 * hour, now - 67 * hour);
  addSession.run("recent", "/recent", now - 1.5 * hour, null);
  addSession.run("open", "/open", now - 70 * hour, null);
  addSession.run("outside-window", "/recent", now - 3 * hour, null);
  db.exec(`INSERT INTO pane_sessions (pane_id,source,agent_session_value,session_id,first_seen_ms)
    VALUES ('history','inferred:cwd_time','history','history',42);
    CREATE TEMP TABLE deleted_links (id TEXT);
    CREATE TEMP TRIGGER record_delete AFTER DELETE ON pane_sessions BEGIN INSERT INTO deleted_links VALUES (old.session_id); END;`);
  const sql = captureSql(db);
  const sync = startHerdrSync(db, { env: { GISOOL_HERDR_SOCKET: "/tmp/gst-performance-absent.sock" }, log() {} });
  t.after(() => { sync.close(); db.close(); });
  // When a periodic pass runs, then a batch explicitly touches an old session.
  sync.linkSessions();
  assert.deepEqual(db.prepare("SELECT session_id FROM pane_sessions ORDER BY session_id").all().map((r) => r.session_id),
    ["history", "open", "recent"]);
  sync.linkSessions(["touched"]);
  // Then historical rows survive, and only the touched old session becomes eligible.
  assert.deepEqual(db.prepare("SELECT session_id FROM pane_sessions ORDER BY session_id").all().map((r) => r.session_id),
    ["history", "open", "recent", "touched"]);
  assert.equal(db.prepare("SELECT first_seen_ms FROM pane_sessions WHERE session_id = 'history'").get().first_seen_ms, 42);
  assert.equal(db.prepare("SELECT count(*) n FROM deleted_links WHERE id = 'history'").get().n, 0);
  const plan = (query, ...args) => db.prepare(`EXPLAIN QUERY PLAN ${query}`).all(...args).map((r) => r.detail).join("\n");
  const bounded = plan(sql.find((s) => s.startsWith("SELECT DISTINCT s.id")), now - 24 * hour, now);
  assert.match(bounded, /SEARCH s USING INDEX sessions_cwd_started/);
  assert.match(bounded, /herdr_panes_closed/);
  assert.match(bounded, /herdr_panes_seen/);
  assert.doesNotMatch(bounded, /SCAN p\b/);
  const pending = plan(sql.find((s) => s.startsWith("UPDATE pane_sessions SET session_id")));
  assert.match(pending, /pane_sessions_pending/);
  assert.match(pending, /sessions_runtime_session/);
  assert.match(pending, /sessions_runtime_conversation/);
  assert.doesNotMatch(pending, /SCAN sessions/);
  const candidates = plan(sql.find((s) => s.startsWith("SELECT p.id, p.agent")), "open", now);
  assert.match(candidates, /herdr_panes_cwd/);
  const linked = plan(sql.find((s) => s.startsWith("SELECT 1 FROM pane_sessions WHERE session_id")), "open");
  assert.match(linked, /pane_sessions_session/);
});

test("reported linking uses runtime-scoped identities rather than another runtime's earlier session", (t) => {
  const db = openDb(":memory:");
  db.exec(`INSERT INTO sessions (id,runtime,runtime_session_id,started_at) VALUES
    ('wrong','codex','shared',1), ('right','claude-code','shared',2);
    INSERT INTO pane_sessions (pane_id,agent,source,agent_session_value) VALUES ('p','claude','herdr:hook','shared');`);
  const sync = startHerdrSync(db, { env: { GISOOL_HERDR_SOCKET: "/tmp/gst-performance-absent.sock" }, log() {} });
  t.after(() => { sync.close(); db.close(); });
  sync.linkSessions();
  assert.equal(db.prepare("SELECT session_id FROM pane_sessions").get().session_id, "right");
});

test("span lookup unions indexed conversation, call, and exact trace/span matches without duplicates", (t) => {
  // Given all three association paths, reused call/span ids, and unrelated runtimes/conversations.
  const db = openDb(":memory:");
  t.after(() => db.close());
  const store = createStore(db);
  db.exec(`INSERT INTO sessions (id,runtime,runtime_session_id,conversation_id,started_at)
    VALUES ('s','codex','runtime-id','conversation',1);
    INSERT INTO events (id,ts,kind,source,session_id,attribution_method,runtime,call_id,span_id,data_json)
    VALUES ('e',1,'tool_call','otlp','s','runtime_id','codex','call','exact','{"otelTraceId":"trace"}');`);
  const insert = db.prepare(`INSERT INTO otel_spans (trace_id,span_id,name,runtime,conversation_id,call_id,received_at)
    VALUES (?,?,'tool',?,?,?,1)`);
  insert.run("trace", "exact", "codex", null, null);
  insert.run("trace", "call", "codex", null, "call");
  insert.run("trace", "conversation", "codex", "conversation", "call");
  insert.run("trace", "runtime", "codex", "runtime-id", null);
  insert.run("trace", "other-conversation", "codex", "foreign", "call");
  insert.run("trace", "other-runtime", "claude-code", "conversation", "call");
  insert.run("foreign-trace", "exact", "codex", null, null);
  const sql = captureSql(db);
  // When the real session data API loads its spans.
  const data = store.treeSessionData("s");
  // Then each matching span appears once and every branch uses its index.
  assert.deepEqual(data.spans.map((s) => s.spanId).sort(), ["call", "conversation", "exact", "runtime"]);
  const query = sql.find((s) => s.startsWith("WITH session AS"));
  const plan = db.prepare(`EXPLAIN QUERY PLAN ${query}`).all("s").map((r) => r.detail).join("\n");
  assert.match(plan, /otel_spans_conversation/);
  assert.match(plan, /otel_spans_call/);
  assert.match(plan, /sqlite_autoindex_otel_spans_1.*trace_id=\? AND span_id=\?/);
  assert.doesNotMatch(plan, /SCAN o\b/);
});

test("ingest notifications carry touched session ids including binding-only hooks", (t) => {
  const db = openDb(":memory:");
  t.after(() => db.close());
  const store = createStore(db);
  const touched = [];
  const deps = createIngestDeps(store, { now: () => 100, sessionChanged: (id) => touched.push(id) });
  const ref = { runtime: "claude-code", runtimeSessionId: "binding" };
  ingest({ id: "event", ts: 100, kind: "prompt", source: "hook", ref, data: {} }, deps);
  ingestHook("claude-code", { hook_event_name: "PostToolUse", tool_name: "mcp__gisool__search_skills",
    tool_use_id: "tool", session_id: "binding", cwd: "/updated" }, deps);
  const id = db.prepare("SELECT id FROM sessions").get().id;
  assert.deepEqual(touched, [id, id]);
});
