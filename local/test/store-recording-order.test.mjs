import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { PACKAGE_ROOT, distImport, makeTempDir, removeDir } from "./_helpers.mjs";

const { openDb } = await distImport("store/db.js");
const { createStore } = await distImport("store/index.js");
const ref = { runtime: "codex", conversationId: "conversation" };

function fixture(t) {
  const dir = makeTempDir();
  const db = openDb(join(dir, "store.db"));
  let clock = 1000;
  const store = createStore(db, { now: () => clock });
  t.after(() => { store.close(); removeDir(dir); });
  db.exec(`INSERT INTO herdr_panes(id,workspace_id,created_ms) VALUES ('pane','w',0)`);
  const sid = store.upsertSession(ref, 900);
  db.prepare(`INSERT INTO pane_sessions(pane_id,agent_session_value,session_id,source)
    VALUES ('pane','conversation',?,'reported')`).run(sid);
  const { row: spec } = store.putWorkflowSpec({ name: "order", steps: [] });
  const start = (at = 1000) => { clock = at; return store.createFlow({ workspaceId: "w", specId: spec.id }).flow.id; };
  const add = (id, ts = 1100) => store.append({
    id, ts, kind: "llm_call", source: "otel", ref, data: { costUsd: 0.02 }, sourceKey: id,
  }, { sessionId: sid, method: "runtime_id" });
  const span = (id, startMs = 1100) => ({
    traceId: "trace", spanId: id, name: "tool", runtime: "codex", conversationId: "conversation", startMs, receivedAt: 1,
  });
  return { db, store, dir, sid, start, add, span,
    end: (id, at = 1100) => { clock = at; store.endFlow(id); } };
}

test("recording clock survives retention, deletion, VACUUM and another connection without reusing order", (t) => {
  // Given a flow with a known endpoint and duplicate event/span replays.
  const f = fixture(t);
  const a = f.start();
  f.add("known");
  f.store.putSpans([f.span("known")]);
  f.end(a);
  const before = f.db.prepare("SELECT * FROM recording_clock").get();
  assert.equal(f.add("known"), false);
  assert.equal(f.store.putSpans([f.span("known", 1101)]), 0);
  assert.deepEqual(f.db.prepare("SELECT * FROM recording_clock").get(), before);
  f.db.exec("BEGIN");
  f.add("rolled-back");
  f.db.exec("ROLLBACK");
  assert.deepEqual(f.db.prepare("SELECT * FROM recording_clock").get(), before);
  f.store.retention(0);
  f.db.exec("DELETE FROM events; DELETE FROM otel_spans; VACUUM");
  // When a reopened connection records new rows at the same runtime timestamp.
  const second = createStore(openDb(join(f.dir, "store.db")));
  try {
    second.append({ id: "after-restart", ts: 1100, kind: "llm_call", source: "otel", ref, data: {} },
      { sessionId: f.sid, method: "runtime_id" });
    second.putSpans([f.span("after-restart")]);
  } finally { second.close(); }
  // Then neither deleted high-water rows nor a low receivedAt can make the new evidence pre-close.
  assert.ok(f.db.prepare("SELECT position FROM recording_clock").get().position > before.position);
  assert.deepEqual(f.store.flowEventScope(a).eventIds, []);
  assert.deepEqual(f.store.treeSessionData(f.sid, f.store.flowEventScope(a)).spans, []);
});

test("history imports preserve source cuts through two destinations and add local arrival order", (t) => {
  // Given a completed source flow with known and later endpoint observations.
  const f = fixture(t);
  const a = f.start();
  f.add("known");
  f.store.putSpans([f.span("known")]);
  f.end(a);
  f.add("late");
  f.store.putSpans([f.span("late")]);
  let source = f.store;
  // When histories are exported and merged through two independent database domains.
  for (const name of ["second", "third"]) {
    const out = join(f.dir, `${name}-export`);
    const expected = source.flowEventScope(a);
    source.exportTo(out, { withHistory: true });
    const db = openDb(join(f.dir, `${name}.db`));
    const store = createStore(db, { now: () => 1100 });
    t.after(() => store.close());
    const before = db.prepare("SELECT * FROM recording_clock").get();
    store.importFrom(out, { merge: false });
    assert.deepEqual(db.prepare("SELECT * FROM recording_clock").get(), before);
    store.importFrom(out, { merge: true });
    // Then source membership and cuts remain identical, while new local cuts see imported rows as prior.
    assert.deepEqual(store.flowEventScope(a), expected);
    const { flow } = store.createFlow({ workspaceId: "w", specId: store.getFlow(a).spec.id });
    assert.deepEqual(store.flowEventScope(flow.id).eventIds, []);
    store.append({ id: `${name}-new`, ts: 1100, kind: "llm_call", source: "otel", ref, data: {} },
      { sessionId: f.sid, method: "runtime_id" });
    assert.deepEqual(store.flowEventScope(flow.id).eventIds, [`${name}-new`]);
    store.endFlow(flow.id);
    const after = db.prepare("SELECT * FROM recording_clock").get();
    store.importFrom(out, { merge: true });
    assert.deepEqual(db.prepare("SELECT * FROM recording_clock").get(), after);
    source = store;
  }
});

test("an imported duplicate identity without source order stays uncertain at the source boundary", (t) => {
  // Given a source endpoint whose ID already exists independently in the destination.
  const f = fixture(t);
  const a = f.start();
  f.add("shared");
  f.add("interior", 1050);
  f.end(a);
  const out = join(f.dir, "export");
  f.store.exportTo(out, { withHistory: true });
  const db = openDb(join(f.dir, "destination.db"));
  const store = createStore(db);
  t.after(() => store.close());
  store.append({ id: "shared", ts: 1100, kind: "llm_call", source: "otel", ref, data: {} },
    { sessionId: f.sid, method: "runtime_id" });
  // When import skips that existing ID rather than fabricating source provenance.
  store.importFrom(out, { merge: true });
  const scope = store.flowEventScope(a);
  // Then interior evidence remains eligible, but the equal-time collision has no certain owner.
  assert.deepEqual(scope.eventIds, ["interior"]);
  assert.equal(scope.boundary, "order_unavailable");
});

test("span replays preserve facts but a real after-close correction invalidates their old endpoint order", (t) => {
  // Given endpoint/untimed spans recorded before close.
  const f = fixture(t);
  const a = f.start();
  f.add("interior", 1050);
  f.store.putSpans([f.span("endpoint"), { ...f.span("untimed"), startMs: undefined }]);
  f.end(a);
  f.store.putSpans([f.span("endpoint", 1101)]);
  assert.equal(f.store.treeSessionData(f.sid, f.store.flowEventScope(a)).spans.length, 2);
  // When stored span facts are explicitly corrected after closure.
  f.db.exec("UPDATE otel_spans SET turn_key = 'corrected'");
  // Then they cannot use their former order as evidence for the changed facts.
  assert.deepEqual(f.store.treeSessionData(f.sid, f.store.flowEventScope(a)).spans, []);
  f.store.putSpans([f.span("delayed-interior", 1050)]);
  assert.deepEqual(f.store.treeSessionData(f.sid, f.store.flowEventScope(a)).spans.map((s) => s.spanId), ["delayed-interior"]);
});

test("late membership recognizes a recorded endpoint termination without inventing a later one", (t) => {
  // Given an unlinked session with activity and a recorded observed end before flow closure.
  const f = fixture(t);
  f.db.exec("DELETE FROM pane_sessions");
  const a = f.start();
  f.add("interior", 1050);
  f.store.append({ id: "end", ts: 1100, kind: "session_end", source: "hook", ref },
    { sessionId: f.sid, method: "runtime_id" });
  f.end(a);
  // When the pane link arrives after closure.
  f.db.prepare(`INSERT INTO pane_sessions(pane_id,agent_session_value,session_id,source)
    VALUES ('pane','conversation',?,'reported')`).run(f.sid);
  // Then the recorded observed end is retained, not inferred from closure.
  assert.equal(f.store.flowEventScope(a).sessionEnds[f.sid], 1100);
});

test("v5 incomplete cuts stay uncertain while old rows precede new post-upgrade cuts", (t) => {
  // Given a real v5 file with the defective empty membership cuts and existing endpoint evidence.
  const dir = makeTempDir();
  t.after(() => removeDir(dir));
  const path = join(dir, "old.db");
  const old = new DatabaseSync(path);
  for (const file of ["schema.sql", "migrations/002_tracing.sql", "migrations/003_tracing_indexes.sql",
    "migrations/004_load_reconciliation.sql", "migrations/005_execution_boundaries.sql"]) {
    old.exec(readFileSync(new URL(`dist/store/${file}`, PACKAGE_ROOT), "utf8"));
  }
  old.exec(`PRAGMA user_version = 5;
    INSERT INTO sessions(id,runtime,started_at) VALUES ('s','codex',900);
    INSERT INTO herdr_panes(id,workspace_id,created_ms) VALUES ('pane','w',0);
    INSERT INTO pane_sessions(pane_id,agent_session_value,session_id) VALUES ('pane','s','s');
    INSERT INTO events(id,ts,kind,source,session_id,attribution_method,runtime)
      VALUES ('old-end',1100,'llm_call','otel','s','runtime_id','codex');
    INSERT INTO flows(id,workspace_id,registered_ms,ended_ms,start_event_ids_json,end_event_ids_json)
      VALUES ('old','w',1000,1100,'[]','[]');`);
  old.close();
  // When migration establishes a new clock, without reconstructing historical recording order.
  const db = openDb(path);
  const store = createStore(db, { now: () => 1100 });
  t.after(() => store.close());
  assert.equal(store.flowEventScope("old").boundary, "order_unavailable");
  assert.deepEqual(store.flowEventScope("old").eventIds, []);
  const { row: spec } = store.putWorkflowSpec({ name: "new", steps: [] });
  const { flow } = store.createFlow({ workspaceId: "w", specId: spec.id });
  // Then migrated rows are certainly prior to a new cut, but have no guessed order against the old flow.
  assert.deepEqual(store.flowEventScope(flow.id).priorEventIds, ["old-end"]);
  assert.deepEqual(store.flowEventScope(flow.id).eventIds, []);
  assert.equal(store.flowEventScope(flow.id).boundary, "recorded");
});

test("same-lineage history restore advances past deleted high-water observations", (t) => {
  // Given an older backup and newer exported history with every intervening row deleted.
  const f = fixture(t);
  const backup = join(f.dir, "backup.db");
  f.db.prepare("VACUUM INTO ?").run(backup);
  const a = f.start(1100);
  for (let i = 0; i < 10; i++) f.add(`deleted-${i}`);
  f.end(a);
  const high = f.db.prepare("SELECT position FROM recording_clock").get().position;
  f.db.exec("DELETE FROM events");
  f.store.exportTo(join(f.dir, "newer"), { withHistory: true });
  // When the older backup restores that later export.
  const db = openDb(backup);
  const store = createStore(db, { now: () => 1100 });
  t.after(() => store.close());
  store.importFrom(join(f.dir, "newer"), { merge: true });
  assert.equal(db.prepare("SELECT position FROM recording_clock").get().position, high);
  store.append({ id: "later", ts: 1100, kind: "llm_call", source: "otel", ref },
    { sessionId: f.sid, method: "runtime_id" });
  // Then new evidence cannot reuse a deleted order and enter the restored closed execution.
  assert.deepEqual(store.flowEventScope(a).eventIds, []);
});

test("clock exhaustion aborts INSERT OR IGNORE instead of stamping a reused order", (t) => {
  // Given the largest exactly representable persisted counter.
  const f = fixture(t);
  f.db.exec("UPDATE recording_clock SET position = 9007199254740991");
  // When the ordinary replay-safe ingestion statement needs another order.
  assert.throws(() => f.add("overflow"), /recording clock exhausted/);
  // Then its entire insert is rolled back, not silently stamped with the old counter.
  assert.equal(f.db.prepare("SELECT id FROM events WHERE id = 'overflow'").get(), undefined);
});
