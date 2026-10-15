import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { PACKAGE_ROOT, distImport, makeTempDir, removeDir } from "./_helpers.mjs";
import { NOW, openStore } from "./helpers/store.mjs";

const { openDb, SCHEMA_VERSION } = await distImport("store/db.js");
const { createIngestDeps, ingest } = await distImport("ingest/pipeline.js");

const V1_SCHEMA = readFileSync(new URL("dist/store/schema.sql", PACKAGE_ROOT), "utf8");
const NEW_TABLES = ["otel_spans", "herdr_workspaces", "herdr_tabs", "herdr_panes", "pane_sessions", "workflow_specs", "flows", "flow_steps"];
const count = (db, table) => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;

/** A database as gisool 0.1.0 wrote it: schema.sql alone, user_version 1, no tracing columns. */
function makeV1Db(path) {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(V1_SCHEMA);
  db.prepare("INSERT INTO sessions (id, runtime, runtime_session_id, started_at, first_prompt) VALUES ('s1', 'claude-code', 'rs-1', 100, 'hello')").run();
  db.prepare("INSERT INTO sessions (id, runtime, conversation_id, started_at) VALUES ('s2', 'codex', 'conv-9', 200)").run();
  db.prepare("INSERT INTO events (id, ts, kind, source, session_id, attribution_method, runtime, text) VALUES ('e1', 101, 'prompt', 'hook', 's1', 'runtime_id', 'claude-code', 'hello')").run();
  db.prepare("INSERT INTO events (id, ts, kind, source, session_id, attribution_method, runtime) VALUES ('e2', 102, 'search', 'mcp', 's1', 'vendor_meta', 'claude-code')").run();
  db.prepare("INSERT INTO events (id, ts, kind, source, session_id, attribution_method, runtime) VALUES ('e3', 201, 'prompt', 'otel', 's2', 'runtime_id', 'codex')").run();
  db.prepare("INSERT INTO loads (load_id, uri, manifest_digest, created_at) VALUES ('l1', 'skill://local/agents/commit/SKILL.md', 'sha256:m', 103)").run();
  return db;
}

function seedTracingRows(db, sessionId) {
  const span = db.prepare(`INSERT INTO otel_spans (trace_id, span_id, parent_span_id, name, runtime, conversation_id, turn_key, call_id, start_ms, end_ms, received_at)
    VALUES (?, ?, ?, ?, 'codex', 'conv-1', ?, ?, 10, 20, 30)`);
  span.run("tr-1", "sp-1", null, "codex.turn_input", "turn-1", null);
  span.run("tr-1", "sp-2", "sp-1", "unified_exec.exec_command", "turn-1", "call-1");
  db.prepare("INSERT INTO herdr_workspaces (id, label, created_ms, closed_ms) VALUES ('ws-1', 'QA', 1, NULL)").run();
  db.prepare("INSERT INTO herdr_tabs (id, workspace_id, label, created_ms, closed_ms) VALUES ('tab-1', 'ws-1', 'main', 1, NULL)").run();
  db.prepare("INSERT INTO herdr_panes (id, workspace_id, tab_id, label, cwd, created_ms, closed_ms) VALUES ('pane-1', 'ws-1', 'tab-1', 'left', '/tmp/work', 1, NULL)").run();
  const paneSession = db.prepare("INSERT INTO pane_sessions (pane_id, agent, source, agent_session_value, session_id, first_seen_ms, last_seen_ms) VALUES ('pane-1', ?, ?, ?, ?, 1, 2)");
  paneSession.run("codex", "herdr:agent_session", "conv-1", sessionId);
  paneSession.run("claude", "inferred:cwd_time", "claude-sess-2", null);
  db.prepare("INSERT INTO workflow_specs (id, name, version, body_json, digest, created_ms) VALUES ('spec-1', 'release', 1, '{\"steps\":[]}', 'sha256:spec', 5)").run();
  db.prepare("INSERT INTO flows (id, workspace_id, tab_id, spec_id, label, registered_ms, ended_ms) VALUES ('flow-1', 'ws-1', 'tab-1', 'spec-1', 'release run', 6, NULL)").run();
  db.prepare("INSERT INTO flow_steps (flow_id, pane_id, step_id, registered_ms) VALUES ('flow-1', 'pane-1', 'plan', 7)").run();
}

test("a v1 database upgrades to user_version 2, keeping its rows and gaining the tracing columns, indexes and tables", () => {
  const dir = makeTempDir();
  try {
    const path = join(dir, "gisool.db");
    const v1 = makeV1Db(path);
    assert.equal(v1.prepare("PRAGMA user_version").get().user_version, 1);
    assert.ok(!v1.prepare("PRAGMA table_info(events)").all().some((c) => c.name === "source_key"));
    v1.close();

    const db = openDb(path);
    try {
      assert.equal(SCHEMA_VERSION, 2);
      assert.equal(db.prepare("PRAGMA user_version").get().user_version, 2);
      assert.deepEqual(db.prepare("SELECT id, first_prompt FROM sessions ORDER BY id").all().map((r) => [r.id, r.first_prompt]), [["s1", "hello"], ["s2", null]]);
      assert.deepEqual(db.prepare("SELECT id FROM events ORDER BY id").all().map((r) => r.id), ["e1", "e2", "e3"]);
      assert.equal(count(db, "loads"), 1);
      const cols = db.prepare("PRAGMA table_info(events)").all().map((c) => c.name);
      for (const c of ["source_key", "turn_key", "call_id", "span_id"]) assert.ok(cols.includes(c), c);
      assert.equal(db.prepare("SELECT source_key, turn_key, call_id, span_id FROM events WHERE id = 'e1'").get().source_key, null);
      const idx = db.prepare("PRAGMA index_list(events)").all().map((r) => r.name);
      for (const i of ["events_source_key", "events_turn", "events_call"]) assert.ok(idx.includes(i), i);
      const names = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((r) => r.name);
      for (const t of NEW_TABLES) assert.ok(names.includes(t), t);
    } finally {
      db.close();
    }

    const again = openDb(path);
    assert.equal(again.prepare("PRAGMA user_version").get().user_version, 2);
    assert.equal(count(again, "events"), 3, "reopening an upgraded database re-runs nothing");
    again.close();
  } finally {
    removeDir(dir);
  }
});

test("the same source_key appended twice yields one row and the second append reports not inserted", () => {
  const { db, store } = openStore();
  try {
    const ref = { runtime: "claude-code", runtimeSessionId: "rs-dup" };
    const sid = store.upsertSession(ref, NOW);
    const attr = { sessionId: sid, method: "runtime_id" };
    const base = { ts: NOW, kind: "prompt", source: "otel", ref, data: {}, sourceKey: "sha256:record-1|prompt||0" };

    assert.equal(store.append({ ...base, id: "ev-1", text: "first" }, attr), true);
    assert.equal(store.append({ ...base, id: "ev-2", text: "second" }, attr), false);
    assert.equal(count(db, "events"), 1);
    assert.deepEqual(db.prepare("SELECT id, text FROM events").all().map((r) => [r.id, r.text]), [["ev-1", "first"]]);
    assert.equal(db.prepare("SELECT first_prompt FROM sessions WHERE id = ?").get(sid).first_prompt, "first", "a replay never rewrites session state");

    assert.equal(store.append({ ...base, id: "ev-3", sourceKey: "sha256:record-1|prompt||1", turnKey: "turn-1", callId: "call-1", spanId: "span-1" }, attr), true);
    assert.equal(store.append({ ...base, id: "ev-4", sourceKey: undefined }, attr), true, "events without a source_key stay independent");
    assert.equal(store.append({ ...base, id: "ev-5", sourceKey: undefined }, attr), true);
    assert.equal(count(db, "events"), 4);
    assert.deepEqual({ ...db.prepare("SELECT turn_key, call_id, span_id FROM events WHERE id = 'ev-3'").get() },
      { turn_key: "turn-1", call_id: "call-1", span_id: "span-1" });
  } finally {
    store.close();
  }
});

test("ingest neither counts, publishes nor re-applies side effects for a replayed event", () => {
  const { db, store } = openStore();
  try {
    const published = [];
    const deps = createIngestDeps(store, { now: () => NOW, publish: (c) => published.push(c) });
    const event = { id: "ev-replay-1", ts: NOW, kind: "prompt", source: "otel", data: {}, text: "hello",
      ref: { runtime: "claude-code", runtimeSessionId: "rs-replay" }, sourceKey: "sha256:record-9|prompt||0" };

    assert.ok(ingest(event, deps));
    assert.equal(ingest({ ...event, id: "ev-replay-2" }, deps), undefined);
    assert.equal(count(db, "events"), 1);
    assert.equal(published.length, 1);
    assert.equal(store.stats().ingest.accepted, 1);
  } finally {
    store.close();
  }
});

test("a v1 history.db imports into a v2 store, reporting only the tables it carries", () => {
  const base = makeTempDir();
  try {
    const out = join(base, "out");
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, "gisool-export.json"), JSON.stringify({ version: 1, config: {}, roots: [], evalCases: [], aliasesOverrides: {} }));
    const hist = makeV1Db(join(out, "history.db"));
    assert.equal(hist.prepare("PRAGMA user_version").get().user_version, 1);
    hist.close();

    const { db, store } = openStore();
    try {
      const res = store.importFrom(out, { merge: true });
      assert.deepEqual(res.details.history, { tables: { sessions: 2, events: 3, loads: 1 }, skipped: 0 });
      assert.equal(res.added, 6);
      assert.equal(count(db, "sessions"), 2);
      assert.equal(count(db, "events"), 3);
      assert.equal(count(db, "loads"), 1);
      assert.equal(db.prepare("SELECT text FROM events WHERE id = 'e1'").get().text, "hello");
      assert.equal(db.prepare("SELECT source_key FROM events WHERE id = 'e1'").get().source_key, null, "columns the v1 export lacks stay NULL");

      const again = store.importFrom(out, { merge: true });
      assert.deepEqual(again.details.history, { tables: { sessions: 0, events: 0, loads: 0 }, skipped: 6 });
      assert.equal(count(db, "events"), 3);
    } finally {
      store.close();
    }
  } finally {
    removeDir(base);
  }
});

test("export then import into a fresh store preserves the rows of every table migration 2 added", () => {
  const base = makeTempDir();
  try {
    const a = openStore();
    const ref = { runtime: "codex", conversationId: "conv-1" };
    const sid = a.store.upsertSession(ref, NOW);
    a.store.append({ id: "ev-traced", ts: NOW, kind: "prompt", source: "otel", ref, data: {}, text: "ship it",
      sourceKey: "sha256:record-7|prompt||0", turnKey: "turn-1", callId: "call-1", spanId: "sp-2" }, { sessionId: sid, method: "runtime_id" });
    seedTracingRows(a.db, sid);
    const out = join(base, "out");
    a.store.exportTo(out, { withHistory: true });
    const exported = new DatabaseSync(join(out, "history.db"));
    assert.equal(exported.prepare("PRAGMA user_version").get().user_version, 2);
    exported.close();

    const b = openStore();
    try {
      const res = b.store.importFrom(out, { merge: true });
      assert.deepEqual(res.details.history.tables, {
        sessions: 1, events: 1, loads: 0, otel_spans: 2, herdr_workspaces: 1, herdr_tabs: 1, herdr_panes: 1,
        pane_sessions: 2, workflow_specs: 1, flows: 1, flow_steps: 1,
      });
      for (const t of [...NEW_TABLES, "sessions", "events"]) assert.equal(count(b.db, t), count(a.db, t), t);
      assert.deepEqual({ ...b.db.prepare("SELECT source_key, turn_key, call_id, span_id FROM events WHERE id = 'ev-traced'").get() },
        { source_key: "sha256:record-7|prompt||0", turn_key: "turn-1", call_id: "call-1", span_id: "sp-2" });
      assert.deepEqual(b.db.prepare("SELECT span_id, call_id FROM otel_spans ORDER BY span_id").all().map((r) => [r.span_id, r.call_id]),
        [["sp-1", null], ["sp-2", "call-1"]]);
      assert.deepEqual({ ...b.db.prepare("SELECT flow_id, pane_id, step_id FROM flow_steps").get() }, { flow_id: "flow-1", pane_id: "pane-1", step_id: "plan" });
      assert.equal(b.db.prepare("SELECT session_id FROM pane_sessions WHERE agent_session_value = 'conv-1'").get().session_id, sid);

      const again = b.store.importFrom(out, { merge: true });
      assert.deepEqual(Object.values(again.details.history.tables).filter((n) => n > 0), []);
      assert.equal(again.details.history.skipped, 12);
      assert.equal(count(b.db, "otel_spans"), 2, "composite keys make a re-import a no-op");
    } finally {
      b.store.close();
      a.store.close();
    }
  } finally {
    removeDir(base);
  }
});
