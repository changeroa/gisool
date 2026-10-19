import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { distImport, makeTempDir, removeDir } from "./_helpers.mjs";
import { bearer, http, startTestServer } from "./helpers/api.mjs";
import { event, openStore } from "./helpers/store.mjs";

const { createIngestDeps, ingest, ingestOtlp } = await distImport("ingest/pipeline.js");
const { loadEvent } = await distImport("ingest/mcp-recorder.js");
const { sessionTree } = await distImport("analysis/tree.js");
const { sessionUsage } = await distImport("analysis/usage.js");
const T = 1_800_000_000_000;
const URI = "skill://local/f3/f3-inventory/SKILL.md";

// Sanitized F3 claude-events.json and codex-events.json argument shapes.
function toolLog(runtime, tool, args, ts = T + 2, key = "current", extra = {}) {
  const attrs = {
    [runtime === "codex" ? "conversation.id" : "session.id"]: key,
    tool_name: tool,
    [runtime === "codex" ? "arguments" : "tool_input"]: JSON.stringify(args),
    success: "true",
    ...extra,
  };
  return { resourceLogs: [{ scopeLogs: [{ logRecords: [{
    timeUnixNano: String(BigInt(ts) * 1_000_000n),
    body: { stringValue: runtime === "codex" ? "codex.tool_result" : "claude_code.tool_result" },
    attributes: Object.entries(attrs).map(([key, value]) => ({ key,
      value: runtime === "codex" && key === "success" ? { boolValue: value === "true" } : { stringValue: value } })),
  }] }] }] };
}

for (const [runtime, tools] of [
  ["claude-code", ["ReadMcpResourceTool", "ListMcpResourcesTool", "mcp__gisool__search_skills"]],
  ["codex", ["read_mcp_resource", "list_mcp_resources", "mcp__gisool__search_skills", "mcp_tool"]],
]) {
  for (const tool of tools) test(`D2 ${runtime} ${tool} is a skill call, not follow-through`, () => {
    // Given an activated span and the captured resource-read argument shape.
    const { db, store } = openStore();
    try {
      const ref = runtime === "codex" ? { runtime, conversationId: "current" } : { runtime, runtimeSessionId: "current" };
      const id = store.upsertSession(ref, T);
      const attribution = { sessionId: id, method: "runtime_id" };
      store.append(event("prompt", T, ref, { text: "inventory" }), attribution);
      store.append(event("load", T + 1, ref, { skillUri: URI }), attribution);
      const deps = createIngestDeps(store, { now: () => T + 3 });
      // When the resource call and an ordinary action arrive through OTLP.
      ingestOtlp(toolLog(runtime, tool, { server: "gisool", uri: URI }), deps);
      ingestOtlp(toolLog(runtime, runtime === "codex" ? "exec_command" : "Bash", { command: "ls" }, T + 3), deps);
      // Then only the ordinary action is follow-through.
      const usage = sessionUsage(sessionTree(store, id)).spans[0];
      assert.deepEqual([usage.followThrough, usage.skillToolCalls], [1, 1]);
      assert.equal(JSON.parse(db.prepare("SELECT data_json FROM events WHERE kind = 'tool_call' ORDER BY ts").get().data_json).gisoolMcp, true);
    } finally { store.close(); }
  });
}

test("D2 other MCP servers and ordinary URI mentions stay non-gisool", () => {
  const { db, store } = openStore();
  try {
    const deps = createIngestDeps(store);
    for (const runtime of ["claude-code", "codex"]) {
      ingestOtlp(toolLog(runtime, "read_mcp_resource", { server: "not-gisool", uri: URI }), deps);
      ingestOtlp(toolLog(runtime, "Bash", { command: `echo ${URI}` }, T + 3), deps);
    }
    assert.ok(db.prepare("SELECT data_json FROM events").all().every((row) => JSON.parse(row.data_json).gisoolMcp === undefined));
  } finally { store.close(); }
});

function ambiguousFixture(store, ts = T) {
  const refs = ["previous", "current"].map((conversationId) => ({ runtime: "codex", conversationId }));
  const ids = refs.map((ref) => {
    const id = store.upsertSession(ref, ts - 1000);
    store.append(event("prompt", ts - 900, ref, { text: "inventory" }), { sessionId: id, method: "runtime_id" });
    return id;
  });
  const deps = createIngestDeps(store, { now: () => ts });
  const load = loadEvent({ clientName: "codex-mcp-client" }, { uri: URI, loadId: `load-${ts}`, manifestDigest: "sha256:fixture" }, ts);
  return { refs, ids, deps, load };
}

for (const order of ["load-first", "tool-first"]) test(`D3 resolves a unique candidate URI match with ${order}`, () => {
  // Given two recently open sessions, as in F3 load-attribution.json.
  const { db, store } = openStore();
  try {
    const { ids, deps, load } = ambiguousFixture(store);
    const tool = toolLog("codex", "read_mcp_resource", { server: "gisool", uri: URI }, T + 2);
    // When the load and exact captured OTLP URI evidence arrive in either order.
    if (order === "tool-first") ingestOtlp(tool, deps);
    const initial = ingest(load, deps);
    assert.equal(initial.reason, "ambiguous", "ingest must not pick a session from the open-session window");
    if (order === "load-first") ingestOtlp(tool, deps);
    // Then the stored load has a durable evidence basis and appears as a skill span.
    const row = db.prepare("SELECT session_id, attribution_reason, data_json FROM events WHERE id = ?").get(load.id);
    assert.equal(row.session_id, ids[1]);
    assert.equal(row.attribution_reason, null);
    assert.equal(JSON.parse(row.data_json).attributionBasis, "tool_call_uri");
    assert.deepEqual(JSON.parse(row.data_json).attributionCandidates.sort(), [...ids].sort());
    assert.equal(sessionUsage(sessionTree(store, ids[1])).spans[0].uri, URI);
    assert.deepEqual(store.reconcileLoads(), { count: 0, uris: [] });
  } finally { store.close(); }
});

test("D3 retracts a URI resolution when another candidate later supplies matching evidence", () => {
  const { db, store } = openStore();
  try {
    const { ids, deps, load } = ambiguousFixture(store);
    ingest(load, deps);
    ingestOtlp(toolLog("codex", "read_mcp_resource", { server: "gisool", uri: URI }, T + 2), deps);
    // When a second candidate's matching event arrives later, even through fresh ingest state.
    ingestOtlp(toolLog("codex", "read_mcp_resource", { server: "gisool", uri: URI }, T + 3, "previous"),
      createIngestDeps(store, { now: () => T + 3 }));
    // Then neither session gets credit, and both report the unresolved URI.
    const row = db.prepare("SELECT session_id, attribution_reason, data_json FROM events WHERE id = ?").get(load.id);
    assert.deepEqual([row.session_id, row.attribution_reason], ["unattributed", "ambiguous"]);
    assert.equal(JSON.parse(row.data_json).attributionBasis, undefined);
    for (const id of ids) {
      assert.deepEqual(store.reconcileLoads({ sessionIds: [id], from: T, to: T + 1 }), { count: 1, uris: [URI] });
      assert.equal(sessionUsage(sessionTree(store, id)).spans.length, 0);
    }
    assert.deepEqual(store.reconcileLoads({ from: T + 1 }), { count: 0, uris: [] });
    assert.deepEqual(store.reconcileLoads({ to: T }), { count: 0, uris: [] });
    assert.deepEqual(store.reconcileLoads({ sessionIds: ["unrelated"] }), { count: 0, uris: [] });
  } finally { store.close(); }
});

for (const [label, args, ts, key, extra] of [
  ["different URI", { server: "gisool", uri: `${URI}.backup` }, T + 2, "current", {}],
  ["outside window", { server: "gisool", uri: URI }, T + 10001, "current", {}],
  ["noncandidate session", { server: "gisool", uri: URI }, T + 2, "unrelated", {}],
  ["other server", { server: "other", uri: URI }, T + 2, "current", {}],
  ["failed call", { server: "gisool", uri: URI }, T + 2, "current", { success: "false" }],
]) test(`D3 keeps a load unattributed for ${label}`, () => {
  const { db, store } = openStore();
  try {
    const { deps, load } = ambiguousFixture(store);
    ingest(load, deps);
    // When nonmatching evidence arrives.
    ingestOtlp(toolLog("codex", "read_mcp_resource", args, ts, key, extra), deps);
    // Then the no-guess decision is preserved.
    assert.equal(db.prepare("SELECT session_id FROM events WHERE id = ?").get(load.id).session_id, "unattributed");
    assert.deepEqual(store.reconcileLoads(), { count: 1, uris: [URI] });
  } finally { store.close(); }
});

test("D3 recovers after closing and reopening the database without in-memory join state", () => {
  const dir = makeTempDir("gisool-f3-restart-");
  let store;
  try {
    const path = join(dir, "gisool.db");
    ({ store } = openStore({ path }));
    const { ids, deps, load } = ambiguousFixture(store);
    ingest(load, deps);
    store.close();
    ({ store } = openStore({ path }));
    // When delayed telemetry arrives after a daemon restart.
    ingestOtlp(toolLog("codex", "read_mcp_resource", { server: "gisool", uri: URI }, T + 2),
      createIngestDeps(store, { now: () => T + 2 }));
    // Then persisted candidates suffice to recover the load.
    assert.equal(sessionUsage(sessionTree(store, ids[1])).spans[0].uri, URI);
  } finally { store?.close(); removeDir(dir); }
});

test("D3 recovers historical F3 rows lacking candidate snapshots and gisoolMcp flags", () => {
  const { db, store } = openStore();
  try {
    const { refs, ids, load } = ambiguousFixture(store);
    // Given the original F3 database shapes, before either fix was installed.
    store.append(load, { sessionId: "unattributed", method: "none", reason: "ambiguous" });
    for (const ts of [T - 10000, T + 10000]) {
      store.append(event("tool_call", ts, refs[1], { source: "otel",
        text: JSON.stringify({ server: "gisool", uri: URI }), data: { toolName: "read_mcp_resource", success: true } }),
      { sessionId: ids[1], method: "runtime_id" });
    }
    // When report-time reconciliation reads the persisted evidence.
    assert.deepEqual(store.reconcileLoads(), { count: 0, uris: [] });
    // Then both boundary matches in ONE candidate still give one deterministic attribution.
    const row = db.prepare("SELECT session_id, data_json FROM events WHERE id = ?").get(load.id);
    assert.equal(row.session_id, ids[1]);
    assert.equal(JSON.parse(row.data_json).attributionBasis, "tool_call_uri");
  } finally { store.close(); }
});

test("D3 never uses a different runtime's matching resource call", () => {
  const { store } = openStore();
  try {
    const { deps, load } = ambiguousFixture(store);
    ingest(load, deps);
    ingestOtlp(toolLog("claude-code", "ReadMcpResourceTool", { server: "gisool", uri: URI }, T + 2), deps);
    assert.deepEqual(store.reconcileLoads(), { count: 1, uris: [URI] });
  } finally { store.close(); }
});

test("D3 reconciliation preserves a later authoritative vendor binding", () => {
  const { db, store } = openStore();
  try {
    const { ids, deps, load } = ambiguousFixture(store);
    ingest(load, deps);
    ingestOtlp(toolLog("codex", "read_mcp_resource", { server: "gisool", uri: URI }, T + 2), deps);
    // Given a later hook/vendor binding superseding the recovered URI association.
    store.reattribute(load.id, ids[0], "vendor_meta");
    // When reconciliation runs again, it must not override authoritative identity.
    store.reconcileLoads();
    const row = db.prepare("SELECT session_id, attribution_method FROM events WHERE id = ?").get(load.id);
    assert.deepEqual([row.session_id, row.attribution_method], [ids[0], "vendor_meta"]);
  } finally { store.close(); }
});

test("D3 retention preserves proven linkage but later conflicting evidence retracts it", () => {
  let clock = T;
  const { db, store } = openStore({ storeOpts: { now: () => clock } });
  try {
    const { ids, deps, load } = ambiguousFixture(store);
    ingest(load, deps);
    ingestOtlp(toolLog("codex", "read_mcp_resource", { server: "gisool", uri: URI }, T + 2), deps);
    clock += 40 * 86_400_000;
    // When retention expires the tool text, explicit reconciliation must not erase its proven match.
    store.retention(30);
    store.reconcileLoads({ from: T, to: T + 1, sessionIds: ids });
    assert.equal(db.prepare("SELECT text FROM events WHERE kind = 'tool_call'").get().text, null);
    assert.equal(db.prepare("SELECT session_id FROM events WHERE id = ?").get(load.id).session_id, ids[1]);
    // A delayed record still has its original event time, not the time it was received.
    ingestOtlp(toolLog("codex", "read_mcp_resource", { server: "gisool", uri: URI }, T + 3, "previous"),
      createIngestDeps(store, { now: () => clock }));
    assert.deepEqual(store.reconcileLoads({ sessionIds: ids, readOnly: true }), { count: 1, uris: [URI] });
    assert.equal(db.prepare("SELECT session_id FROM events WHERE id = ?").get(load.id).session_id, "unattributed");
  } finally { store.close(); }
});

for (const order of ["load-first", "tool-first"]) test(`D3 metadata capture stores no URI evidence or argument secrets (${order})`, () => {
  const { db, store } = openStore();
  try {
    const { deps, load } = ambiguousFixture(store);
    deps.captureLevel = "metadata";
    const tool = toolLog("codex", "read_mcp_resource", { server: "gisool", uri: URI, token: "secret-probe-token" }, T + 2);
    if (order === "tool-first") ingestOtlp(tool, deps);
    ingest(load, deps);
    if (order === "load-first") ingestOtlp(tool, deps);
    const toolRow = db.prepare("SELECT text, data_json FROM events WHERE kind = 'tool_call'").get();
    assert.equal(toolRow.text, null);
    assert.equal(toolRow.data_json.includes("secret-probe-token"), false);
    assert.equal(toolRow.data_json.includes(URI), false);
    const row = db.prepare("SELECT session_id, data_json FROM events WHERE id = ?").get(load.id);
    assert.equal(row.session_id, "unattributed");
    assert.equal(JSON.parse(row.data_json).attributionMatches, undefined);
  } finally { store.close(); }
});

test("D3 redacted capture retains only session proof after retention, never secret arguments", () => {
  const secret = `sk-${"x".repeat(24)}`;
  const { db, store } = openStore({ storeOpts: { now: () => T + 40 * 86_400_000 } });
  try {
    const { ids, deps, load } = ambiguousFixture(store);
    deps.captureLevel = "redacted";
    ingest(load, deps);
    ingestOtlp(toolLog("codex", "read_mcp_resource", { server: "gisool", uri: URI, token: secret }, T + 2), deps);
    assert.equal(db.prepare("SELECT text FROM events WHERE kind = 'tool_call'").get().text.includes(secret), false);
    store.retention(30);
    const row = db.prepare("SELECT session_id, data_json FROM events WHERE id = ?").get(load.id);
    assert.equal(row.session_id, ids[1]);
    assert.deepEqual(JSON.parse(row.data_json).attributionMatches, [ids[1]]);
    assert.ok(db.prepare("SELECT text, data_json FROM events").all().every((row) => row.text === null && !row.data_json.includes(secret)));
  } finally { store.close(); }
});

test("D3 unresolved loads are exposed by real session and flow report endpoints", async () => {
  const server = await startTestServer();
  let store;
  try {
    const at = Date.UTC(2026, 9, 14);
    let clock = at - 2000;
    const opened = openStore({ path: join(server.gisoolHome, "gisool.db"), storeOpts: { now: () => clock } });
    store = opened.store;
    const { db } = opened;
    const { ids, deps, load } = ambiguousFixture(store, at);
    db.prepare("INSERT INTO herdr_workspaces (id, created_ms) VALUES (?, ?)").run("f3-ws", at - 3000);
    db.prepare("INSERT INTO herdr_tabs (id, workspace_id, created_ms) VALUES (?, ?, ?)").run("f3-tab", "f3-ws", at - 3000);
    db.prepare("INSERT INTO herdr_panes (id, workspace_id, tab_id, created_ms) VALUES (?, ?, ?, ?)").run("f3-pane", "f3-ws", "f3-tab", at - 3000);
    db.prepare(`INSERT INTO pane_sessions (pane_id, agent, source, agent_session_value, session_id, first_seen_ms, last_seen_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run("f3-pane", "codex", "herdr:codex", "current", ids[1], at - 1000, at + 5);
    const { row } = store.putWorkflowSpec({ name: "f3", steps: [{ id: "inventory", skills: ["f3-inventory"] }] });
    const { flow } = store.createFlow({ workspaceId: "f3-ws", tabId: "f3-tab", specId: row.id });
    store.mapFlowStep(flow.id, "f3-pane", "inventory");
    clock = at + 1000;
    store.endFlow(flow.id);
    ingest(load, deps);
    // When reports are requested without any uniquely matching evidence.
    for (const path of [`/api/sessions/${ids[1]}/skill-report`, `/api/flows/${flow.id}`]) {
      const version = db.prepare("PRAGMA data_version").get().data_version;
      const response = await http(server.port, { path, headers: bearer(server.token) });
      // Then the no-use finding is accompanied by visible unresolved evidence.
      assert.equal(response.status, 200, response.text);
      assert.deepEqual(response.json.unattributedLoads, { count: 1, uris: [URI] });
      assert.equal(db.prepare("PRAGMA data_version").get().data_version, version, "GET must not commit writes");
    }
    ingestOtlp(toolLog("codex", "read_mcp_resource", { server: "gisool", uri: URI }, at + 2), deps);
    const recovered = await http(server.port, { path: `/api/flows/${flow.id}`, headers: bearer(server.token) });
    assert.deepEqual(recovered.json.unattributedLoads, { count: 0, uris: [] });
    assert.equal(recovered.json.comparison.steps[0].status, "matched");
    assert.deepEqual(recovered.json.usage.skills.map((skill) => [skill.followThrough, skill.skillToolCalls]), [[0, 1]]);
    // A second candidate match retracts that credit and must remain visible.
    ingestOtlp(toolLog("codex", "read_mcp_resource", { server: "gisool", uri: URI }, at + 3, "previous"), deps);
    const tied = await http(server.port, { path: `/api/flows/${flow.id}`, headers: bearer(server.token) });
    assert.deepEqual(tied.json.unattributedLoads, { count: 1, uris: [URI] });
    assert.equal(tied.json.comparison.steps[0].status, "no_skill_used");
    // Another unresolved load after the flow ended belongs to the session warning, not this flow's window.
    ingest(loadEvent({ clientName: "codex-mcp-client" },
      { uri: URI, loadId: "after-flow", manifestDigest: "sha256:fixture" }, at + 2000),
    createIngestDeps(store, { now: () => at + 2000 }));
    const bounded = await http(server.port, { path: `/api/flows/${flow.id}`, headers: bearer(server.token) });
    assert.deepEqual(bounded.json.unattributedLoads, { count: 1, uris: [URI] });
    const session = await http(server.port, { path: `/api/sessions/${ids[1]}/skill-report`, headers: bearer(server.token) });
    assert.deepEqual(session.json.unattributedLoads, { count: 2, uris: [URI] });
  } finally { store?.close(); await server.stop(); }
});
