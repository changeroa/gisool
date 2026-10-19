import test from "node:test";
import assert from "node:assert/strict";
import { distImport } from "./_helpers.mjs";

const { openDb } = await distImport("store/db.js");
const { createStore } = await distImport("store/index.js");

test("ended flow lists skip span cuts and detail cuts visit only execution events", (t) => {
  // Given ten ended executions sharing a continuing session.
  const db = openDb(":memory:");
  let clock = 1000;
  const store = createStore(db, { now: () => clock });
  t.after(() => store.close());
  db.exec(`INSERT INTO herdr_panes(id,workspace_id,created_ms) VALUES ('pane','w',0)`);
  const sid = store.upsertSession({ runtime: "codex", runtimeSessionId: "own" }, 900);
  db.prepare(`INSERT INTO pane_sessions(pane_id,agent_session_value,session_id,source)
    VALUES ('pane','own',?,'reported')`).run(sid);
  const { row: spec } = store.putWorkflowSpec({ name: "cuts", steps: [] });
  const flows = [];
  for (let k = 0; k < 10; k++) {
    clock = 1000 + k * 100;
    const { flow } = store.createFlow({ workspaceId: "w", specId: spec.id });
    flows.push(flow.id);
    db.prepare(`INSERT INTO events(id,ts,kind,source,session_id,attribution_method,runtime,call_id)
      VALUES (?,?,'tool_call','otel',?,'runtime_id','codex',?)`).run(`e${k}`, clock + 5, sid, `call${k}`);
    store.putSpans([{ traceId: "own", spanId: `s${k}`, name: "tool", runtime: "codex",
      callId: `call${k}`, startMs: clock + 50, receivedAt: 1 }]);
    clock += 50;
    store.endFlow(flow.id);
  }
  db.exec(`WITH RECURSIVE n(i) AS (VALUES(0) UNION ALL SELECT i+1 FROM n WHERE i<19999)
    INSERT INTO otel_spans(trace_id,span_id,name,runtime,received_at,call_id,start_ms)
      SELECT 'foreign',CAST(i AS TEXT),'tool','codex',1,'foreign-'||i,1 FROM n`);
  const prepare = db.prepare.bind(db);
  let cuts = 0, visits = 0;
  db.function("span_cut_visit", (_id) => { visits++; return 1; });
  db.prepare = (sql) => {
    if (sql.includes("WITH session AS")) {
      cuts++;
      // Count real joined event evaluations, not returned rows or elapsed time.
      sql = sql.replaceAll("e.session_id = s.id", "e.session_id = s.id AND span_cut_visit(e.id)");
    }
    return prepare(sql);
  };
  const measure = () => {
    cuts = visits = 0;
    const list = store.listFlows({ from: 0, limit: 21, automated: "include" });
    assert.equal(list.filter((row) => row.kind === "flow").length, 10);
    assert.equal(cuts, 0, "list must not execute a span-cut query");
    const keys = flows.map((id) => store.flowEventScope(id).spanKeys);
    assert.equal(cuts, 10);
    return { keys, visits };
  };
  const before = measure();
  // When 200k member events are added before and after every flow window.
  prepare(`WITH RECURSIVE n(i) AS (VALUES(0) UNION ALL SELECT i+1 FROM n WHERE i<199999)
    INSERT INTO events(id,ts,kind,source,session_id,attribution_method,runtime,call_id)
      SELECT 'outside-'||i,CASE WHEN i<100000 THEN -i ELSE 100000+i END,
        'tool_call','otel',?,'runtime_id','codex','outside-'||i FROM n`).run(sid);
  const after = measure();
  // Then both span-cut evaluations and results are independent of out-of-window history.
  t.diagnostic(JSON.stringify({ flows: 10, addedEvents: 200000, beforeVisits: before.visits, afterVisits: after.visits }));
  assert.equal(before.visits, 20);
  assert.deepEqual(after, before);
});
