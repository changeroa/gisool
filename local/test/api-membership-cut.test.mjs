import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { distImport } from "./_helpers.mjs";
import { startTestServer, http, bearer } from "./helpers/api.mjs";

const { openDb } = await distImport("store/db.js");
const { createStore } = await distImport("store/index.js");

async function fixture(t, mode) {
  const server = await startTestServer();
  const db = openDb(join(server.gisoolHome, "gisool.db"));
  let clock = 1000, sequence = 0;
  const store = createStore(db, { now: () => clock });
  t.after(async () => { store.close(); await server.stop(); });
  db.exec(`INSERT INTO herdr_workspaces(id,created_ms) VALUES ('w',0);
    INSERT INTO herdr_tabs(id,workspace_id,created_ms) VALUES ('main','w',0),('other','w',0);`);
  db.prepare("INSERT INTO herdr_panes(id,workspace_id,tab_id,created_ms) VALUES ('pane','w',?,0)")
    .run(mode === "cross-tab" ? "other" : "main");
  const ref = { runtime: "codex", conversationId: "continuing" };
  const sid = store.upsertSession(ref, 900);
  const link = () => db.prepare(`INSERT INTO pane_sessions
    (pane_id,agent_session_value,session_id,source,first_seen_ms,last_seen_ms)
    VALUES ('pane','continuing',?,'herdr:codex',900,1300)`).run(sid);
  if (mode === "cross-tab") link();
  const { row: spec } = store.putWorkflowSpec({ name: "membership", steps: [{ id: "work", skills: ["alpha", "beta"] }] });
  const start = () => {
    const { flow } = store.createFlow({ workspaceId: "w", tabId: "main", specId: spec.id });
    store.mapFlowStep(flow.id, "pane", "work");
    return flow.id;
  };
  const add = (kind, ts, data = {}) => store.append({
    id: `e-${++sequence}`, kind, ts, data, ref, source: "otel", turnKey: "turn",
  }, { sessionId: sid, method: "runtime_id" });
  const warn = (id, ts = 1100) => store.append({
    id, kind: "load", ts, ref: { runtime: "codex" }, source: "mcp",
    skillUri: `skill://local/gate/${id}/SKILL.md`, data: { attributionCandidates: [sid] },
  }, { sessionId: "unattributed", method: "none", reason: "ambiguous" });
  const report = async (id) => {
    const result = await http(server.port, { path: `/api/flows/${id}?automated=include`, headers: bearer(server.token) });
    assert.equal(result.status, 200, result.text);
    return result.json;
  };
  add("prompt", 900);
  const a = start();
  add("native_skill", 1010, { name: "alpha" });
  add("llm_call", 1100, { costUsd: 0.02 });
  warn("load-a");
  store.putSpans([{ traceId: "trace-own", spanId: "end-span", name: "tool", runtime: "codex",
    conversationId: "continuing", startMs: 1100, receivedAt: 1100 }]);
  clock = 1100;
  store.endFlow(a);
  return { db, store, sid, a, start, add, warn, report, link,
    end: (id, at) => { clock = at; store.endFlow(id); } };
}

function calls(report) {
  return report.tree.tabs.flatMap((tab) => tab.panes.flatMap((pane) => pane.sessions.flatMap((link) =>
    link.session?.turns.flatMap((turn) => turn.events.filter((event) => event.kind === "llm_call")
      .map((event) => [event.id, event.data.costUsd])) ?? [])));
}

test("post-registration cross-tab mapping cannot inherit the previous equal-time execution", async (t) => {
  // Given A's endpoint calls and loads, with the pane outside the registered tab.
  const f = await fixture(t, "cross-tab");
  // When B registers before mapping that pane at exactly A's closing timestamp.
  const b = f.start();
  f.add("native_skill", 1100, { name: "beta" });
  f.add("llm_call", 1100, { costUsd: 0.07 });
  f.warn("load-b");
  f.end(b, 1200);
  // Then membership discovered later applies the earlier cut to calls and warnings identically.
  const aReport = await f.report(f.a), bReport = await f.report(b);
  assert.deepEqual(calls(aReport), [["e-3", 0.02]]);
  assert.deepEqual(calls(bReport), [["e-5", 0.07]]);
  assert.deepEqual(bReport.unattributedLoads, { count: 1, uris: ["skill://local/gate/load-b/SKILL.md"] });
  assert.deepEqual(aReport.unattributedLoads, { count: 1, uris: ["skill://local/gate/load-a/SKILL.md"] });
  assert.deepEqual(bReport.usage.skills.map((skill) => skill.costUsd), [0.07]);
});

test("post-close pane linking retains known endpoint evidence but rejects later equal-time arrivals", async (t) => {
  // Given an unlinked session whose call, load and span were recorded before A closed.
  const f = await fixture(t, "late-link");
  f.add("llm_call", 1100, { costUsd: 8 });
  f.warn("late-edge");
  f.add("llm_call", 1090, { costUsd: 0.03 });
  f.warn("late-interior", 1090);
  f.store.putSpans([
    { traceId: "trace-own", spanId: "late-edge", name: "tool", runtime: "codex", conversationId: "continuing", startMs: 1100, receivedAt: 900 },
    { traceId: "trace-own", spanId: "late-interior", name: "tool", runtime: "codex", conversationId: "continuing", startMs: 1090, receivedAt: 900 },
  ]);
  // When eventual pane membership is learned and the real HTTP report is read.
  f.link();
  const before = f.db.prepare("SELECT total_changes() AS n").get().n;
  const report = await f.report(f.a);
  // Then recorded chronology, not link discovery or receivedAt, controls only the equality boundary.
  assert.deepEqual(calls(report), [["e-5", 0.03], ["e-3", 0.02]]);
  assert.deepEqual(report.unattributedLoads, {
    count: 2, uris: ["skill://local/gate/late-interior/SKILL.md", "skill://local/gate/load-a/SKILL.md"],
  });
  assert.deepEqual(f.store.treeSessionData(f.sid, f.store.flowEventScope(f.a)).spans.map((span) => span.spanId),
    ["late-interior", "end-span"]);
  assert.equal(report.tree.tabs[0].panes[0].sessions[0].session.endedAt, null);
  assert.equal(report.executionScope.boundary, "recorded");
  assert.equal(f.db.prepare("SELECT total_changes() AS n").get().n, before);
});

test("HTTP detail retains differently timestamped endpoint span joins only in recorded order", async (t) => {
  // Given endpoint spans linked by conversation, call and exact trace/span to interior or start events.
  const server = await startTestServer();
  const db = openDb(join(server.gisoolHome, "gisool.db"));
  let clock = 1000;
  const store = createStore(db, { now: () => clock });
  t.after(async () => { store.close(); await server.stop(); });
  db.exec(`INSERT INTO herdr_workspaces(id,created_ms) VALUES ('w',0);
    INSERT INTO herdr_tabs(id,workspace_id,created_ms) VALUES ('tab','w',0);
    INSERT INTO herdr_panes(id,workspace_id,tab_id,created_ms) VALUES ('pane','w','tab',0)`);
  const ref = { runtime: "codex", runtimeSessionId: "own" };
  const sid = store.upsertSession(ref, 900);
  const { row: spec } = store.putWorkflowSpec({ name: "endpoint-spans", steps: [] });
  const { flow } = store.createFlow({ workspaceId: "w", specId: spec.id });
  const spans = [];
  for (const [joinKind, ts] of [["conversation", 1050], ["call", 1051], ["exact", 1052], ["call-start", 1000]]) {
    for (const order of ["known", "late"]) {
      const id = `${joinKind}-${order}`;
      store.append({ id, kind: "tool_call", ts, ref, source: "otel",
        callId: id, spanId: id, ...(joinKind === "conversation" ? { turnKey: id } : {}),
        data: { otelTraceId: id } }, { sessionId: sid, method: "runtime_id" });
      spans.push({ traceId: id, spanId: id, name: "codex.turn_input", runtime: "codex",
        turnKey: id, startMs: 1100, receivedAt: 1,
        ...(joinKind === "conversation" ? { conversationId: "own" }
          : joinKind.startsWith("call") ? { callId: id } : {}) });
    }
  }
  store.putSpans(spans.filter((span) => span.spanId.endsWith("-known")));
  clock = 1100;
  store.endFlow(flow.id);
  store.putSpans(spans.filter((span) => span.spanId.endsWith("-late")));
  // When membership arrives after close, read the real detail endpoint without mutating storage.
  db.prepare(`INSERT INTO pane_sessions(pane_id,agent_session_value,session_id,source)
    VALUES ('pane','own',?,'reported')`).run(sid);
  const changes = db.prepare("SELECT total_changes() AS n").get().n;
  const response = await http(server.port, {
    path: `/api/flows/${flow.id}?automated=include`, headers: bearer(server.token),
  });
  // Then pre-close endpoint spans still assign their interior events; later equal-time spans do not.
  assert.equal(response.status, 200, response.text);
  const session = response.json.tree.tabs[0].panes[0].sessions[0].session;
  assert.deepEqual(session.turns.flatMap((turn) => turn.events.map((event) => [event.id, event.basis])).sort(), [
    ["call-known", "span_join"], ["call-start-known", "span_join"],
    ["conversation-known", "reported"], ["exact-known", "span_join"],
  ]);
  assert.deepEqual(session.unassignedEvents.map((event) => event.id).sort(),
    ["call-late", "call-start-late", "conversation-late", "exact-late"]);
  assert.equal(response.json.executionScope.boundary, "recorded");
  assert.equal(db.prepare("SELECT total_changes() AS n").get().n, changes);
});
