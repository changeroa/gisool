import assert from "node:assert/strict";
import test from "node:test";
import { distImport } from "./_helpers.mjs";
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
