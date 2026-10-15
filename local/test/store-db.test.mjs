import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { distImport, makeTempDir, removeDir } from "./_helpers.mjs";

const { openDb, selfCheck, mergeSplitSessions, SCHEMA_VERSION } = await distImport("store/db.js");

test("mergeSplitSessions folds a Codex session split across conversation_id and runtime_session_id, idempotently", () => {
  const db = openDb(":memory:");
  try {
    const addSession = db.prepare("INSERT INTO sessions (id, runtime, runtime_session_id, conversation_id, started_at, first_prompt) VALUES (?, ?, ?, ?, ?, ?)");
    addSession.run("otel", "codex", null, "conv-1", 100, "QA prompt");
    addSession.run("mcp", "codex", "conv-1", "conv-1", 110, null);
    addSession.run("other-runtime", "gemini", "conv-1", null, 90, null);
    addSession.run("unrelated", "codex", null, "conv-2", 95, null);
    const addEvent = db.prepare("INSERT INTO events (id, ts, kind, source, session_id, attribution_method, runtime) VALUES (?, ?, ?, ?, ?, ?, 'codex')");
    addEvent.run("e1", 100, "prompt", "otel", "otel", "runtime_id");
    addEvent.run("e2", 111, "search", "mcp", "mcp", "vendor_meta");
    assert.equal(mergeSplitSessions(db), 1);
    const ids = db.prepare("SELECT id FROM sessions ORDER BY id").all().map((r) => r.id);
    assert.deepEqual(ids, ["otel", "other-runtime", "unrelated"]);
    assert.deepEqual(db.prepare("SELECT id, session_id FROM events ORDER BY id").all().map((r) => [r.id, r.session_id]), [["e1", "otel"], ["e2", "otel"]]);
    const kept = db.prepare("SELECT runtime_session_id, conversation_id, first_prompt, ended_at FROM sessions WHERE id = 'otel'").get();
    assert.deepEqual({ ...kept }, { runtime_session_id: "conv-1", conversation_id: "conv-1", first_prompt: "QA prompt", ended_at: null });
    assert.equal(mergeSplitSessions(db), 0);
  } finally {
    db.close();
  }
});

test("fresh database migrates to user_version 3 with every table", () => {
  const db = openDb(":memory:");
  try {
    assert.equal(SCHEMA_VERSION, 3);
    assert.equal(db.prepare("PRAGMA user_version").get().user_version, 3);
    const names = db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table') ORDER BY name").all().map((r) => r.name);
    for (const t of ["meta", "skills", "skills_fts", "sessions", "events", "loads", "eval_cases"]) assert.ok(names.includes(t), t);
    const cols = db.prepare("PRAGMA table_info(events)").all().map((r) => r.name);
    assert.ok(cols.includes("tool_use_id"));
    const idx = db.prepare("PRAGMA index_list(events)").all().map((r) => r.name);
    for (const i of ["events_session_ts", "events_ts", "events_trace", "events_skill", "events_tool_use"]) assert.ok(idx.includes(i), i);
  } finally {
    db.close();
  }
});

test("file database uses WAL, busy_timeout 5000, foreign keys, and reopens without re-migrating", () => {
  const dir = makeTempDir();
  try {
    const path = join(dir, "nested", "gisool.db");
    const db = openDb(path);
    assert.equal(db.prepare("PRAGMA journal_mode").get().journal_mode, "wal");
    assert.equal(db.prepare("PRAGMA busy_timeout").get().timeout, 5000);
    assert.equal(db.prepare("PRAGMA foreign_keys").get().foreign_keys, 1);
    db.prepare("INSERT INTO meta(key, value) VALUES ('k', 'v')").run();
    db.close();
    const again = openDb(path);
    assert.equal(again.prepare("PRAGMA user_version").get().user_version, 3);
    assert.equal(again.prepare("SELECT value FROM meta WHERE key = 'k'").get().value, "v");
    again.close();
  } finally {
    removeDir(dir);
  }
});

test("skills_fts trigram matches a Korean substring", () => {
  const db = openDb(":memory:");
  try {
    db.prepare("INSERT INTO skills_fts(uri, name, description, when_to_use, examples, aliases_ko, body_head) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run("skill://local/agents/commit/SKILL.md", "commit", "커밋 메시지 작성해줘", "", "", "", "");
    const rows = db.prepare("SELECT uri FROM skills_fts WHERE skills_fts MATCH ?").all('"메시지"');
    assert.deepEqual(rows.map((r) => r.uri), ["skill://local/agents/commit/SKILL.md"]);
  } finally {
    db.close();
  }
});

test("selfCheck passes on a real connection and standalone, leaving no temp table", () => {
  const db = openDb(":memory:");
  try {
    selfCheck(db);
    selfCheck();
    assert.equal(db.prepare("SELECT count(*) AS n FROM temp.sqlite_master WHERE name = 'gisool_selfcheck'").get().n, 0);
  } finally {
    db.close();
  }
});

test("selfCheck throws fts5_trigram_unavailable when FTS5 is rejected", () => {
  const db = openDb(":memory:");
  const realExec = db.exec.bind(db);
  db.exec = (sql) => {
    if (/fts5/i.test(sql)) throw new Error("no such module: fts5");
    return realExec(sql);
  };
  try {
    assert.throws(() => selfCheck(db), (error) => error.name === "GisoolStartupError" && error.code === "fts5_trigram_unavailable");
  } finally {
    db.exec = realExec;
    db.close();
  }
});
