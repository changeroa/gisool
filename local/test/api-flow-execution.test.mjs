import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { distImport } from "./_helpers.mjs";
import { bearer, http, startTestServer } from "./helpers/api.mjs";

const { openDb } = await distImport("store/db.js");
const { createStore } = await distImport("store/index.js");

async function fixture(t) {
  const server = await startTestServer();
  const db = openDb(join(server.gisoolHome, "gisool.db"));
  let clock = 1000, sequence = 0;
  const store = createStore(db, { now: () => clock });
  t.after(async () => { store.close(); await server.stop(); });
  db.exec(`INSERT INTO herdr_workspaces (id, created_ms) VALUES ('w', 0);
    INSERT INTO herdr_tabs (id, workspace_id, created_ms) VALUES ('tab', 'w', 0);
    INSERT INTO herdr_panes (id, workspace_id, tab_id, created_ms) VALUES ('pane', 'w', 'tab', 0)`);
  const { row: spec } = store.putWorkflowSpec({
    name: "execution", steps: [{ id: "work", skills: ["alpha", "beta"], together: false, expectTools: ["Edit"] }],
  });
  const start = (at) => {
    clock = at;
    const { flow } = store.createFlow({ workspaceId: "w", tabId: "tab", specId: spec.id });
    store.mapFlowStep(flow.id, "pane", "work");
    return flow.id;
  };
  const end = (id, at) => { clock = at; store.endFlow(id); };
  const session = (key, at) => {
    const ref = { runtime: "claude-code", runtimeSessionId: key };
    const id = store.upsertSession(ref, at);
    db.prepare(`INSERT INTO pane_sessions (pane_id, agent_session_value, session_id, source, first_seen_ms, last_seen_ms)
      VALUES ('pane', ?, ?, 'inferred:cwd_time', ?, ?)`).run(key, id, at, at);
    return { id, ref };
  };
  const append = (s, kind, ts, data = {}, turnKey = "turn") => store.append({
    id: `execution-${++sequence}`, kind, ts, ref: s.ref, source: "otel", turnKey, data,
    ...(kind === "prompt" ? { text: "implement fixture" } : {}),
  }, { sessionId: s.id, method: "runtime_id" });
  const activity = (s, at, skill, cost, turn) => {
    append(s, "prompt", at, {}, turn);
    append(s, "native_skill", at + 1, { name: skill }, turn);
    append(s, "tool_call", at + 2, { name: "Edit", success: true }, turn);
    append(s, "llm_call", at + 3, { costUsd: cost, inputTokens: 11, outputTokens: 7 }, turn);
  };
  const get = async (id) => {
    const result = await http(server.port, { path: `/api/flows/${id}?automated=include`, headers: bearer(server.token) });
    assert.equal(result.status, 200, result.text);
    const { generatedAt, ...report } = result.json;
    return report;
  };
  const list = async () => (await http(server.port, {
    path: "/api/flows?automated=include&from=0", headers: bearer(server.token),
  })).json.flows;
  return { db, store, start, end, session, append, activity, get, list };
}

function assertExecution(report, id, skill, cost) {
  const sessions = report.tree.tabs.flatMap((tab) => tab.panes.flatMap((pane) => pane.sessions));
  assert.deepEqual(sessions.map((link) => link.sessionId), [id]);
  assert.equal(report.finding.aggregate.turns, 1);
  assert.deepEqual(report.finding.sessions[0].turns[0].usedSkills.map((s) => s.name), [skill]);
  assert.deepEqual(report.usage.skills.map((s) => [s.skill, s.costUsd, s.llmCalls, s.followThrough]), [[skill, cost, 1, 1]]);
  assert.deepEqual(report.comparison.steps[0].usedSkills, [skill]);
  assert.equal(report.comparison.steps[0].status, "matched");
}

test("A remains stable and B inherits no sessions, skills, turns or costs on pane reuse", async (t) => {
  // Given a completed A report with fixture-known measurements.
  const f = await fixture(t);
  const a = f.start(1000);
  const sa = f.session("a", 1010);
  f.activity(sa, 1020, "alpha", 0.02, "a-turn");
  f.append(sa, "session_end", 1090);
  f.end(a, 1100);
  const before = await f.get(a);
  assertExecution(before, sa.id, "alpha", 0.02);
  // When another execution uses exactly the same pane.
  const b = f.start(1200);
  const sb = f.session("b", 1210);
  f.activity(sb, 1220, "beta", 0.07, "b-turn");
  f.append(sb, "session_end", 1290);
  f.end(b, 1300);
  // Then both detail and list membership agree, and A's completed report is byte-for-byte stable.
  assert.deepEqual(await f.get(a), before);
  assertExecution(await f.get(b), sb.id, "beta", 0.07);
  const rows = await f.list();
  assert.deepEqual(rows.find((row) => row.id === a).sessionIds, [sa.id]);
  assert.deepEqual(rows.find((row) => row.id === b).sessionIds, [sb.id]);
  const workspace = await f.get("ws:w");
  assert.deepEqual(workspace.usage.skills.map((s) => s.costUsd), [0.02, 0.07]);
});

for (const skill of ["beta", "alpha"]) test(`a continuing session is split by event time and its boundary overlap is labelled (${skill})`, async (t) => {
  // Given one session/turn already active before A starts, with excluded pre-registration activity.
  const f = await fixture(t);
  const s = f.session("continuing", 900);
  f.activity(s, 910, "outside", 9, "same-turn");
  const a = f.start(1000);
  f.activity(s, 1010, "alpha", 0.02, "same-turn");
  f.end(a, 1100);
  const before = await f.get(a);
  assertExecution(before, s.id, "alpha", 0.02);
  assert.deepEqual(before.executionScope.overlaps, [{ sessionId: s.id, startedBefore: true, continuesAfter: true }]);
  // When the same session and reported turn continue through B with distinct observations.
  const b = f.start(1200);
  f.activity(s, 1210, skill, 0.07, "same-turn");
  f.append(s, "session_end", 1290, {}, "same-turn");
  f.end(b, 1300);
  f.db.prepare("UPDATE pane_sessions SET last_seen_ms = 1400 WHERE session_id = ?").run(s.id);
  // Then event-level splitting, not session-start filtering, isolates both runs.
  assert.deepEqual(await f.get(a), before);
  const report = await f.get(b);
  assertExecution(report, s.id, skill, 0.07);
  assert.deepEqual(report.executionScope.overlaps, [{ sessionId: s.id, startedBefore: true, continuesAfter: false }]);
  const session = report.tree.tabs[0].panes[0].sessions[0].session;
  assert.deepEqual(session.turns[0].events.map((e) => e.ts), [1210, 1211, 1212, 1213, 1290]);
  assert.deepEqual(session.turns[0].events.find((e) => e.kind === "llm_call").skills, [skill]);
  assert.deepEqual((await f.list()).filter((row) => row.kind === "flow").map((row) => row.sessionIds), [[s.id], [s.id]]);
});
