import test from "node:test";
import assert from "node:assert/strict";
import { distImport } from "./_helpers.mjs";

const { openDb } = await distImport("store/db.js");
const { createStore } = await distImport("store/index.js");

function fixture(t) {
  const db = openDb(":memory:");
  let clock = 1000;
  const store = createStore(db, { now: () => clock });
  t.after(() => store.close());
  db.exec(`INSERT INTO herdr_workspaces (id) VALUES ('w');
    INSERT INTO herdr_tabs (id, workspace_id) VALUES ('tab', 'w');
    INSERT INTO herdr_panes (id, workspace_id, tab_id, created_ms) VALUES ('pane', 'w', 'tab', 0)`);
  const { row: spec } = store.putWorkflowSpec({ name: "scope", steps: [] });
  const { flow } = store.createFlow({ workspaceId: "w", tabId: "tab", specId: spec.id });
  const session = (id, started, linked = true) => {
    const sid = store.upsertSession({ runtime: "codex", runtimeSessionId: id }, started);
    if (linked) db.prepare(`INSERT INTO pane_sessions
      (pane_id, agent_session_value, session_id, source, first_seen_ms, last_seen_ms)
      VALUES ('pane', ?, ?, 'reported', ?, ?)`).run(id, sid, started, started);
    return sid;
  };
  const event = (id, sid, ts) => store.append({
    id, ts, kind: "tool_call", source: "otel", ref: { runtime: "codex" }, data: {},
  }, { sessionId: sid, method: "runtime_id" });
  const load = (id, candidates, ts = 1050) => store.append({
    id, ts, kind: "load", source: "mcp", ref: { runtime: "codex" },
    skillUri: `skill://local/p/${id}/SKILL.md`, data: { attributionCandidates: candidates },
  }, { sessionId: "unattributed", method: "none", reason: "ambiguous" });
  return { db, store, flow, session, event, load,
    start: (at) => { clock = at; return store.createFlow({ workspaceId: "w", tabId: "tab", specId: spec.id }).flow; },
    end: (id = flow.id, at = 1100) => { clock = at; store.endFlow(id); } };
}

test("execution identities exclude foreign sessions and loads but retain late interior telemetry", (t) => {
  // Given a continuing member and a separate session with events in exactly the same time window.
  const f = fixture(t);
  const own = f.session("own", 900);
  const other = f.session("other", 900, false);
  f.event("own", own, 1010);
  f.event("foreign", other, 1010);
  f.load("candidate", [own, other]);
  f.load("foreign-load", [other]);
  f.end();
  f.event("late-interior", own, 1090);
  f.event("late-boundary", own, 1100);
  // When scope and warnings are read after completion.
  const scope = f.store.flowEventScope(f.flow.id);
  // Then recorded cuts affect equality only, and foreign activity is never materialized as owned identity.
  assert.deepEqual([...scope.eventIds].sort(), ["candidate", "late-interior", "own"]);
  assert.deepEqual(f.store.flowSessionIds(f.flow.id), [own]);
  assert.deepEqual(f.store.flowUnattributedLoads(f.flow.id, [own]), {
    count: 1, uris: ["skill://local/p/candidate/SKILL.md"],
  });
});

test("recorded cuts contain only relevant equal-time events and session-matched spans", (t) => {
  // Given unrelated equal-time events and historical untimed spans alongside all three valid span joins.
  const f = fixture(t);
  const own = f.session("own", 900);
  const other = f.session("other", 900, false);
  f.end();
  f.event("prior-own", own, 1200);
  f.load("prior-candidate", [own, other], 1200);
  const insertSpan = f.db.prepare(`INSERT INTO otel_spans
    (trace_id, span_id, name, runtime, conversation_id, call_id, start_ms, received_at)
    VALUES (?, ?, 'codex.turn_input', 'codex', ?, ?, ?, 1)`);
  f.db.exec("BEGIN");
  for (let i = 0; i < 2000; i++) {
    f.event(`foreign-start-${i}`, other, 1200);
    f.event(`foreign-end-${i}`, other, 1300);
    insertSpan.run("foreign", String(i), "other", null, null);
  }
  f.db.exec("COMMIT");
  const flow = f.start(1200);
  f.event("own-end", own, 1300);
  f.load("own-warning", [own, other], 1300);
  insertSpan.run("conversation", "same", "own", null, null);
  insertSpan.run("conversation", "interior", "own", null, 1250);
  insertSpan.run("conversation", "future", "own", null, 1301);
  insertSpan.run("call", "same", null, "own-call", 1300);
  insertSpan.run("exact", "same", null, null, 1300);
  f.db.prepare("UPDATE events SET call_id = ?, span_id = ?, data_json = ? WHERE id = ?")
    .run("own-call", "same", JSON.stringify({ otelTraceId: "exact" }), "own-end");
  // When this execution records its end, without any unrelated span scan.
  const prepare = f.db.prepare.bind(f.db);
  const plans = [];
  f.db.prepare = (sql) => {
    const stmt = prepare(sql);
    if (sql.includes("WITH session AS")) {
      const all = stmt.all.bind(stmt);
      stmt.all = (...params) => {
        plans.push(...prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params).map((row) => row.detail));
        return all(...params);
      };
    }
    return stmt;
  };
  f.end(flow.id, 1300);
  // Then equality snapshots are small, composite span identity survives, and interior spans need no snapshot.
  const cuts = prepare("SELECT * FROM flows WHERE id = ?").get(flow.id);
  assert.deepEqual(JSON.parse(cuts.start_event_ids_json).sort(), ["prior-candidate", "prior-own"]);
  assert.deepEqual(JSON.parse(cuts.end_event_ids_json).sort(), ["own-end", "own-warning"]);
  assert.deepEqual(JSON.parse(cuts.end_spans_json), [["call", "same"], ["conversation", "same"], ["exact", "same"]]);
  assert.deepEqual(Object.keys(JSON.parse(cuts.end_sessions_json)), [own]);
  assert.ok(cuts.end_spans_json.length < 100);
  assert.match(plans.join("\n"), /SEARCH o USING INDEX otel_spans_conversation/);
  assert.match(plans.join("\n"), /SEARCH o USING INDEX otel_spans_call/);
  assert.doesNotMatch(plans.join("\n"), /SCAN (?:otel_spans|o)\b/);
});

test("candidate recording cuts survive later attribution retraction at both endpoints", (t) => {
  // Given candidate loads currently resolved to another session, before registration and before closing.
  const f = fixture(t);
  const own = f.session("own", 900);
  const other = f.session("other", 900, false);
  f.end();
  const resolved = (id, ts) => f.store.append({
    id, ts, kind: "load", source: "mcp", ref: { runtime: "codex" },
    skillUri: `skill://local/p/${id}/SKILL.md`,
    data: { attributionCandidates: [own, other], attributionMatches: [other], attributionBasis: "tool_call_uri" },
  }, { sessionId: other, method: "trace_handle" });
  resolved("prior-resolved", 1200);
  const flow = f.start(1200);
  f.event("own-interior", own, 1250);
  resolved("end-resolved", 1300);
  f.end(flow.id, 1300);
  // When late contradictory evidence retracts attribution, the original recording ownership must remain.
  f.db.exec(`UPDATE events SET session_id = 'unattributed', attribution_method = 'none', attribution_reason = 'ambiguous'
    WHERE id IN ('prior-resolved', 'end-resolved')`);
  // Then only the endpoint load recorded during the execution becomes its warning.
  assert.deepEqual(f.store.flowUnattributedLoads(flow.id, [own]), {
    count: 1, uris: ["skill://local/p/end-resolved/SKILL.md"],
  });
});

test("scope event queries use session and candidate indexes with constant unrelated work", (t) => {
  // Given an open flow with an empty own session and growing unrelated history.
  const f = fixture(t);
  const own = f.session("own", 1001);
  const other = f.session("other", 1001, false);
  const prepare = f.db.prepare.bind(f.db);
  const reads = [];
  f.db.prepare = (sql) => {
    const statement = prepare(sql);
    const all = statement.all.bind(statement);
    statement.all = (...params) => {
      const rows = all(...params);
      reads.push({ sql, rows: rows.length, plan: prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) });
      return rows;
    };
    return statement;
  };
  const measurements = [];
  for (const n of [20, 2000]) {
    for (let i = n / 10; i < n; i++) f.event(`foreign-${n}-${i}`, other, 1020 + i);
    reads.length = 0;
    // When the complete scope is queried, SQL instrumentation observes real returned rows and plans.
    const scope = f.store.flowEventScope(f.flow.id);
    assert.deepEqual(scope.eventIds, []);
    assert.deepEqual(scope.links.map((link) => link.sessionId), [own]);
    const eventReads = reads.filter((r) => /\bFROM events\b|\bJOIN events\b/.test(r.sql));
    assert.equal(eventReads.length, 1);
    const plan = eventReads[0].plan.map((row) => row.detail).join("\n");
    assert.match(plan, /SEARCH .* USING INDEX events_session_ts \(session_id=\? AND ts>\? AND ts<\?\)/);
    assert.match(plan, /SEARCH .* USING COVERING INDEX load_candidates_session_ts/);
    assert.doesNotMatch(plan, /SCAN (?:events|e|c)\b/);
    measurements.push({ queries: reads.length, eventRows: eventReads[0].rows });
  }
  // Then both actual result work and query count remain constant without a timing assertion.
  assert.deepEqual(measurements[1], measurements[0]);
  assert.equal(measurements[0].eventRows, 0);
});
