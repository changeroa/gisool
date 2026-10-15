import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { PACKAGE_ROOT, distImport, makeTempDir, removeDir } from "./_helpers.mjs";

const { openDb } = await distImport("store/db.js");

test("v2 tracing rows survive index migration and reopening", (t) => {
  // Given an existing version 2 store with a historical pane and link.
  const dir = makeTempDir();
  t.after(() => removeDir(dir));
  const path = join(dir, "v2.db");
  const old = new DatabaseSync(path);
  old.exec(readFileSync(new URL("dist/store/schema.sql", PACKAGE_ROOT), "utf8"));
  old.exec(readFileSync(new URL("dist/store/migrations/002_tracing.sql", PACKAGE_ROOT), "utf8"));
  old.exec(`PRAGMA user_version = 2;
    INSERT INTO sessions (id,runtime,started_at) VALUES ('s','codex',10);
    INSERT INTO herdr_panes (id,cwd,created_ms,closed_ms) VALUES ('p','/repo',1,20);
    INSERT INTO pane_sessions (pane_id,source,agent_session_value,session_id) VALUES ('p','inferred:cwd_time','s','s');`);
  old.close();
  // When opening twice with the new migration registry.
  for (let i = 0; i < 2; i++) {
    const db = openDb(path);
    try {
      // Then data and historical lifetime remain intact, with each required index installed.
      assert.equal(db.prepare("PRAGMA user_version").get().user_version, 3);
      assert.equal(db.prepare("SELECT session_id FROM pane_sessions").get().session_id, "s");
      assert.equal(db.prepare("SELECT last_seen_ms FROM herdr_panes").get().last_seen_ms, 20);
      const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all().map((r) => r.name);
      for (const name of ["pane_sessions_session", "pane_sessions_pending", "herdr_panes_cwd", "herdr_panes_closed", "herdr_panes_seen", "sessions_cwd_started",
        "otel_spans_conversation", "otel_spans_call", "otel_spans_turn"]) assert.ok(indexes.includes(name), name);
    } finally { db.close(); }
  }
});
