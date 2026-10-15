import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { distImport, makeTempDir, removeDir } from "./_helpers.mjs";
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

test("detail and list compute each registered execution scope only once per request", async (t) => {
  // Given a registered flow with a visible member, instrument actual DB reads, not store return values.
  const f = await fixture(t);
  const id = f.start(1000);
  const s = f.session("single-scope", 1001);
  f.activity(s, 1010, "alpha", 0.02, "turn");
  const prepare = DatabaseSync.prototype.prepare;
  let scopeReads = 0;
  DatabaseSync.prototype.prepare = function (sql) {
    const stmt = prepare.call(this, sql);
    if (sql.startsWith("SELECT start_event_ids_json")) {
      const get = stmt.get.bind(stmt);
      stmt.get = (...args) => { scopeReads++; return get(...args); };
    }
    return stmt;
  };
  try {
    // When each real HTTP request assembles tree, comparison, warnings or list membership.
    assertExecution(await f.get(id), s.id, "alpha", 0.02);
    assert.equal(scopeReads, 1);
    scopeReads = 0;
    assert.deepEqual((await f.list()).find((row) => row.id === id).sessionIds, [s.id]);
    // Then reuse is request-local, and a later request still computes fresh state.
    assert.equal(scopeReads, 1);
    f.append(s, "llm_call", 1020, { costUsd: 0.03 }, "turn");
    scopeReads = 0;
    assert.equal((await f.get(id)).usage.skills[0].costUsd, 0.05);
    assert.equal(scopeReads, 1);
  } finally {
    DatabaseSync.prototype.prepare = prepare;
  }
});

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

test("D3 warnings share inclusive execution bounds for a continuing session", async (t) => {
  // Given ambiguous loads before, at the end of, and after A in one continuing session.
  const f = await fixture(t);
  const s = f.session("ambiguous-continuing", 900);
  f.activity(s, 910, "outside", 9, "same-turn");
  const a = f.start(1000);
  f.activity(s, 1010, "alpha", 0.02, "same-turn");
  const load = (ts) => f.store.append({
    id: `ambiguous-${ts}`, kind: "load", ts, ref: { runtime: "claude-code" }, source: "mcp",
    skillUri: `skill://local/fixture/skill-${ts}/SKILL.md`,
    data: { attributionCandidates: [s.id] },
  }, { sessionId: "unattributed", method: "none", reason: "ambiguous" });
  for (const ts of [999, 1100, 1101]) load(ts);
  f.end(a, 1100);
  // When B reuses the same session, including another unresolved load.
  const b = f.start(1200);
  f.activity(s, 1210, "beta", 0.07, "same-turn");
  load(1211);
  f.end(b, 1300);
  // Then each execution exposes only its own ambiguous load, including A's exact end.
  const report = await f.get(a);
  assert.deepEqual(report.unattributedLoads, { count: 1, uris: ["skill://local/fixture/skill-1100/SKILL.md"] });
  assertExecution(report, s.id, "alpha", 0.02);
  assert.deepEqual((await f.get(b)).unattributedLoads, { count: 1, uris: ["skill://local/fixture/skill-1211/SKILL.md"] });
});

test("equal-millisecond executions own disjoint recorded activity and completed A stays stable", async (t) => {
  // Given a continuing turn with A's call already recorded at the future shared boundary.
  const f = await fixture(t);
  const s = f.session("boundary", 900);
  f.append(s, "prompt", 900);
  const a = f.start(1000);
  f.append(s, "native_skill", 1010, { name: "alpha" });
  f.append(s, "tool_call", 1100, { name: "Edit", success: true });
  f.append(s, "llm_call", 1100, { costUsd: 0.02 });
  const load = (id) => f.store.append({
    id, kind: "load", ts: 1100, ref: { runtime: "claude-code" }, source: "mcp",
    skillUri: `skill://local/fixture/${id}/SKILL.md`, data: { attributionCandidates: [s.id] },
  }, { sessionId: "unattributed", method: "none", reason: "ambiguous" });
  load("boundary-a");
  f.end(a, 1100);
  const before = await f.get(a);
  // When B starts at that same millisecond and records its own activation, calls and warning.
  const b = f.start(1100);
  f.append(s, "native_skill", 1100, { name: "beta" });
  f.append(s, "tool_call", 1100, { name: "Edit", success: true });
  f.append(s, "llm_call", 1100, { costUsd: 0.07 });
  load("boundary-b");
  f.append(s, "session_end", 1190);
  f.end(b, 1200);
  // Then the real detail/list/comparison/warning paths agree, without losing either call.
  assert.deepEqual(await f.get(a), before);
  assertExecution(before, s.id, "alpha", 0.02);
  const after = await f.get(b);
  assertExecution(after, s.id, "beta", 0.07);
  assert.deepEqual(before.unattributedLoads, { count: 1, uris: ["skill://local/fixture/boundary-a/SKILL.md"] });
  assert.deepEqual(after.unattributedLoads, { count: 1, uris: ["skill://local/fixture/boundary-b/SKILL.md"] });
  const events = (r) => r.tree.tabs[0].panes[0].sessions[0].session.turns.flatMap((turn) => turn.events);
  const calls = [...events(before), ...events(after)].filter((e) => e.kind === "llm_call");
  assert.equal(new Set(calls.map((e) => e.id)).size, 2);
  assert.deepEqual(calls.map((e) => e.data.costUsd), [0.02, 0.07]);
  assert.deepEqual((await f.list()).filter((row) => row.kind === "flow").map((row) => row.sessionIds), [[s.id], [s.id]]);
});

test("execution clipping does not invent an observed session end", async (t) => {
  // Given an unended session that continues beyond a completed execution.
  const f = await fixture(t);
  const s = f.session("unended", 900);
  const a = f.start(1000);
  f.activity(s, 1010, "alpha", 0.02, "same-turn");
  f.end(a, 1100);
  // When the real flow report is assembled.
  const report = await f.get(a);
  const session = report.tree.tabs[0].panes[0].sessions[0].session;
  // Then observed lifetime and the analysis slice have distinct semantics.
  assert.equal(session.endedAt, null);
  assert.deepEqual(session.executionWindow, { from: 1000, to: 1100 });
  assert.equal(session.turns[0].endedAt, 1100);
  assert.equal(report.executionScope.overlaps[0].continuesAfter, true);
});

test("a captured real end is not replaced by a later termination observation", async (t) => {
  // Given A ended with a genuine session-end observation, not an analysis clipping value.
  const f = await fixture(t);
  const s = f.session("ended-observation", 900);
  const a = f.start(1000);
  f.activity(s, 1010, "alpha", 0.02, "turn");
  f.append(s, "session_end", 1090);
  f.end(a, 1100);
  const before = await f.get(a);
  assert.equal(before.tree.tabs[0].panes[0].sessions[0].session.endedAt, 1090);
  // When another lifecycle source reports a later end for that same runtime identity.
  f.append(s, "session_end", 1190);
  // Then A's observed termination and duration remain stable.
  assert.deepEqual(await f.get(a), before);
});

test("zero-duration adjacent executions retain every call once, including a new equal-time prompt", async (t) => {
  // Given a prompt preceding two executions that fit within one clock millisecond.
  const f = await fixture(t);
  const s = f.session("zero-duration", 900);
  f.append(s, "prompt", 900);
  const a = f.start(1000);
  f.append(s, "native_skill", 1000, { name: "alpha" });
  f.append(s, "tool_call", 1000, { name: "Edit" }, null);
  f.append(s, "llm_call", 1000, { costUsd: 0.02 }, null);
  f.end(a, 1000);
  const before = await f.get(a);
  // When a different prompt and B's activity arrive in that same millisecond.
  const b = f.start(1000);
  for (const [kind, data] of [["prompt", {}], ["native_skill", { name: "beta" }],
    ["tool_call", { name: "Edit" }], ["llm_call", { costUsd: 0.07 }]]) f.append(s, kind, 1000, data, "b-turn");
  f.end(b, 1000);
  // Then later prompt assembly cannot steal or duplicate A's already owned observations.
  assert.deepEqual(await f.get(a), before);
  assertExecution(before, s.id, "alpha", 0.02);
  assertExecution(await f.get(b), s.id, "beta", 0.07);
});

test("completed identity cuts survive late boundary arrivals, VACUUM and history import", async (t) => {
  // Given a completed report and portable persisted identity cuts.
  const f = await fixture(t);
  const s = f.session("portable", 900);
  const a = f.start(1000);
  f.activity(s, 1010, "alpha", 0.02, "turn");
  f.end(a, 1100);
  const before = await f.get(a);
  const scope = f.store.flowEventScope(a);
  const dir = makeTempDir();
  t.after(() => removeDir(dir));
  // When delayed boundary telemetry arrives and SQLite rows are rebuilt and imported elsewhere.
  f.append(s, "native_skill", 1100, { name: "late" });
  f.append(s, "llm_call", 1100, { costUsd: 8 });
  f.db.exec("VACUUM");
  f.store.exportTo(join(dir, "export"), { withHistory: true });
  const imported = createStore(openDb(join(dir, "import.db")));
  try {
    imported.importFrom(join(dir, "export"), { merge: true });
    assert.deepEqual(imported.flowEventScope(a), scope);
    assert.deepEqual(imported.flowPaneUsage(a), f.store.flowPaneUsage(a));
  } finally { imported.close(); }
  // Then A remains stable and the uncredited late data remains visible in workspace history.
  assert.deepEqual(await f.get(a), before);
  assert.ok((await f.get("ws:w")).usage.skills.some((skill) => skill.name === "late"));
});

test("historical equal-time boundary order is exposed as unavailable rather than guessed", async (t) => {
  // Given a legacy execution with no recorded lifecycle cuts.
  const f = await fixture(t);
  const s = f.session("legacy", 900);
  f.append(s, "prompt", 900);
  const a = f.start(1000);
  f.activity(s, 1010, "alpha", 0.02, "turn");
  f.append(s, "llm_call", 1100, { costUsd: 8 });
  f.end(a, 1100);
  f.db.prepare(`UPDATE flows SET start_event_ids_json = NULL, end_event_ids_json = NULL, end_sessions_json = NULL,
    start_order_domain = NULL, start_order = NULL, end_order_domain = NULL, end_order = NULL WHERE id = ?`).run(a);
  // When reporting this history after upgrade.
  const report = await f.get(a);
  // Then ambiguous endpoints receive no invented owner, while interior evidence and workspace history survive.
  assert.equal(report.executionScope.boundary, "order_unavailable");
  assertExecution(report, s.id, "alpha", 0.02);
  assert.equal((await f.get("ws:w")).usage.skills[0].llmCalls, 2);
});

test("read-only flow warnings combine indexed legacy candidates with recorded boundary ownership", async (t) => {
  // Given legacy loads with indexed candidates but no JSON snapshot at a shared execution boundary.
  const f = await fixture(t);
  const s = f.session("legacy-candidate", 900);
  f.session("second-candidate", 900);
  f.append(s, "prompt", 900);
  const a = f.start(1000);
  f.activity(s, 1010, "alpha", 0.02, "turn");
  const load = (id) => f.store.append({
    id, kind: "load", ts: 1100, ref: { runtime: "claude-code" }, source: "mcp",
    skillUri: `skill://local/fixture/${id}/SKILL.md`, data: {},
  }, { sessionId: "unattributed", method: "none", reason: "ambiguous" });
  load("legacy-a");
  f.end(a, 1100);
  const b = f.start(1100);
  f.activity(s, 1100, "beta", 0.07, "next-turn");
  load("legacy-b");
  f.end(b, 1200);
  // A matching tool is deliberately stored without ingest repair: GET must not perform that repair.
  f.store.append({
    id: "unreconciled-tool", kind: "tool_call", ts: 1100, ref: s.ref, source: "otel",
    text: JSON.stringify({ server: "gisool", uri: "skill://local/fixture/legacy-a/SKILL.md" }),
    data: { success: true },
  }, { sessionId: s.id, method: "runtime_id" });
  f.db.exec("INSERT INTO herdr_workspaces (id, created_ms) VALUES ('empty', 0)");
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM load_candidates").get().n, 4);
  const version = f.db.prepare("PRAGMA data_version").get().data_version;
  const changes = f.db.prepare("SELECT total_changes() AS n").get().n;
  const rows = f.db.prepare("SELECT * FROM events ORDER BY id").all();
  // When both execution reports, workspace history and an empty workspace are read repeatedly.
  for (let i = 0; i < 2; i++) {
    assert.deepEqual((await f.get(a)).unattributedLoads, {
      count: 1, uris: ["skill://local/fixture/legacy-a/SKILL.md"],
    });
    assert.deepEqual((await f.get(b)).unattributedLoads, {
      count: 1, uris: ["skill://local/fixture/legacy-b/SKILL.md"],
    });
    assert.deepEqual((await f.get("ws:w")).unattributedLoads, {
      count: 2, uris: ["skill://local/fixture/legacy-a/SKILL.md", "skill://local/fixture/legacy-b/SKILL.md"],
    });
    assert.deepEqual((await f.get("ws:empty")).unattributedLoads, { count: 0, uris: [] });
  }
  // Then the candidate index supplies warnings without duplication, boundary leaks or any connection writing.
  assert.equal(f.db.prepare("PRAGMA data_version").get().data_version, version);
  assert.equal(f.db.prepare("SELECT total_changes() AS n").get().n, changes);
  assert.deepEqual(f.db.prepare("SELECT * FROM events ORDER BY id").all(), rows);
});
