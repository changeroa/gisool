import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { distImport, makeTempDir, removeDir } from "./_helpers.mjs";
import { event, openStore } from "./helpers/store.mjs";

const { createStore } = await distImport("store/index.js");
const T = 1_800_000_000_000;
const URI = "skill://local/fixture/alpha/SKILL.md";

test("reconciliation SQL work is restricted by URI, candidate session and time before reading history", () => {
  const { db, store: seed } = openStore();
  try {
    const refs = ["a", "b", "irrelevant"].map((runtimeSessionId) => ({ runtime: "claude-code", runtimeSessionId }));
    const ids = refs.map((ref) => seed.upsertSession(ref, T - 1000));
    db.exec("BEGIN");
    // Large irrelevant history, including same URI/time in a different session and old loads in our session.
    for (let i = 0; i < 20000; i++) seed.append(event("tool_call", T - 1000000 + i, refs[2], {
      source: "otel", text: JSON.stringify({ server: "gisool", uri: URI }), data: { success: true },
    }), { sessionId: ids[2], method: "runtime_id" });
    for (let i = 0; i < 2000; i++) seed.append(event("load", i % 2 ? T : T - 1000000, refs[0], {
      skillUri: i % 2 ? `${URI}.other` : URI,
      data: { attributionCandidates: i % 2 ? [ids[2]] : ids.slice(0, 2) },
    }), { sessionId: "unattributed", method: "none", reason: "ambiguous" });
    const load = event("load", T, refs[0], { skillUri: URI, data: { attributionCandidates: ids.slice(0, 2) } });
    seed.append(load, { sessionId: "unattributed", method: "none", reason: "ambiguous" });
    const tool = event("tool_call", T + 1, refs[0], { source: "otel", text: JSON.stringify({ server: "gisool", uri: URI }), data: { success: true } });
    seed.append(tool, { sessionId: ids[0], method: "runtime_id" });
    db.exec("COMMIT");
    const prepare = db.prepare.bind(db);
    const reads = [];
    db.prepare = (sql) => {
      const statement = prepare(sql);
      if (/SELECT/.test(sql)) {
        const all = statement.all.bind(statement);
        statement.all = (...args) => {
          const rows = all(...args);
          reads.push({ sql, args, rows: rows.length, plan: prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args).map((row) => row.detail) });
          return rows;
        };
      }
      return statement;
    };
    const store = createStore(db);
    // When a tool arrives, unrelated history is excluded by indexed SQL, not filtered after fetching.
    store.reconcileLoads({ eventId: tool.id });
    assert.equal(prepare("SELECT session_id FROM events WHERE id = ?").get(load.id).session_id, ids[0]);
    assert.ok(reads.reduce((n, read) => n + read.rows, 0) <= 6, JSON.stringify(reads));
    assert.ok(reads.every((read) => read.plan.every((detail) => !/SCAN (?:e|events|c)\b/.test(detail))), JSON.stringify(reads));
    assert.ok(reads.some((read) => read.plan.some((detail) => /events_reconcile_load_uri.*runtime=.*skill_uri=.*ts>.*ts</.test(detail))), JSON.stringify(reads));
    assert.ok(reads.some((read) => read.plan.some((detail) => /events_uri_tools.*runtime=.*session_id=.*ts>.*ts</.test(detail))), JSON.stringify(reads));
    reads.length = 0;
    const changes = prepare("SELECT total_changes() n").get().n;
    store.reconcileLoads({ sessionIds: [ids[1]], from: T, to: T + 2, readOnly: true });
    assert.equal(prepare("SELECT total_changes() n").get().n, changes);
    assert.equal(reads.reduce((n, read) => n + read.rows, 0), 0);
    assert.ok(reads.some((read) => read.plan.some((detail) => /SEARCH c USING COVERING INDEX load_candidates_session_ts.*session_id=.*ts>.*ts</.test(detail))), JSON.stringify(reads));
    reads.length = 0;
    store.reconcileLoads({ from: T + 2, to: T + 3 });
    assert.equal(reads.reduce((n, read) => n + read.rows, 0), 0);
    assert.ok(reads.some((read) => read.plan.some((detail) => /SEARCH e USING INDEX events_pending_load_ts.*ts>.*ts</.test(detail))), JSON.stringify(reads));
    // Replaying the same evidence never rewrites a resolved row or its index.
    const before = prepare("SELECT total_changes() n").get().n;
    store.reconcileLoads({ eventId: tool.id });
    assert.equal(prepare("SELECT total_changes() n").get().n, before);
  } finally { seed.close(); }
});

test("bounded repair limits SQL results and leaves read-only reports unchanged", () => {
  const { db, store: seed } = openStore();
  try {
    const ref = { runtime: "codex", runtimeSessionId: "a" };
    const id = seed.upsertSession(ref, T - 1);
    for (let i = 0; i < 50; i++) seed.append(event("load", T + i, ref, {
      skillUri: URI, data: { attributionCandidates: [id] },
    }), { sessionId: "unattributed", method: "none", reason: "ambiguous" });
    const prepare = db.prepare.bind(db);
    const reads = [];
    db.prepare = sql => {
      const statement = prepare(sql);
      if (sql.includes("events_pending_load_ts")) {
        const all = statement.all.bind(statement);
        statement.all = (...args) => {
          const rows = all(...args);
          reads.push(rows.length);
          return rows;
        };
      }
      return statement;
    };
    const store = createStore(db);
    const before = prepare("SELECT total_changes() n").get().n;
    const bounded = store.reconcileLoads({ from: T, to: T + 100, limit: 2, readOnly: true });
    assert.equal(bounded.examined, 2);
    assert.equal(bounded.count, 2);
    assert.ok(bounded.next);
    assert.deepEqual(reads, [2], "the row bound belongs in SQL, not an in-memory slice");
    assert.equal(prepare("SELECT total_changes() n").get().n, before);
    assert.deepEqual(store.reconcileLoads({ from: T, to: T + 100, readOnly: true }), { count: 50, uris: [URI] });
    assert.equal(prepare("SELECT total_changes() n").get().n, before);
  } finally { seed.close(); }
});

test("bounded repair preserves proof committed by another connection after batch selection", t => {
  const dir = makeTempDir();
  const { db, store } = openStore({ path: join(dir, "history.db") });
  const other = openStore({ path: join(dir, "history.db") });
  t.after(() => { other.store.close(); store.close(); removeDir(dir); });
  const refs = ["a", "b"].map(runtimeSessionId => ({ runtime: "codex", runtimeSessionId }));
  const ids = refs.map(ref => store.upsertSession(ref, T - 1));
  const load = event("load", T, refs[0], { skillUri: URI, data: { attributionCandidates: ids } });
  store.append(load, { sessionId: "unattributed", method: "none", reason: "ambiguous" });
  const proof = index => event("tool_call", T + 1, refs[index], {
    source: "otel", text: JSON.stringify({ server: "gisool", uri: URI }), data: { success: true },
  });
  const first = proof(0);
  store.append(first, { sessionId: ids[0], method: "runtime_id" });
  const exec = db.exec.bind(db);
  let interleaved = false;
  db.exec = sql => {
    if (sql === "SAVEPOINT reconcile_loads" && !interleaved) {
      interleaved = true;
      other.store.reconcileLoads({ eventId: first.id });
      other.db.prepare("UPDATE events SET text = NULL WHERE id = ?").run(first.id);
      const contrary = proof(1);
      other.store.append(contrary, { sessionId: ids[1], method: "runtime_id" });
      other.store.reconcileLoads({ eventId: contrary.id });
    }
    return exec(sql);
  };
  const result = store.reconcileLoads({ from: T, to: T + 100, limit: 1 });
  assert.equal(interleaved, true);
  const row = db.prepare("SELECT session_id, data_json FROM events WHERE id = ?").get(load.id);
  assert.equal(row.session_id, "unattributed", "repair must not erase the other connection's contradictory proof");
  assert.deepEqual(JSON.parse(row.data_json).attributionMatches.sort(), ids.sort());
  assert.equal(result.repaired, 0);
  assert.equal(result.count, 1);
});
