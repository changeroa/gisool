import assert from "node:assert/strict";
import test from "node:test";
import { distImport } from "./_helpers.mjs";
import { fixture } from "./helpers/ingest.mjs";
import { event, openStore, uri } from "./helpers/store.mjs";

const { sessionTree, flowTree, outsideHerdr, assembleSession } = await distImport("analysis/tree.js");
const { createIngestDeps, ingest, ingestOtlp } = await distImport("ingest/pipeline.js");
const { ingestOtlpTraces } = await distImport("ingest/otlp-traces.js");
const { searchEvent, loadEvent, readFileEvent } = await distImport("ingest/mcp-recorder.js");
const T = 1760320000000;
const CODEX_TURN = "01a13990-4062-7fb3-bb7c-78e2a3435556";

function seeded(t, runtime = "claude-code", key = "session") {
  const { db, store } = openStore();
  t.after(() => store.close());
  const ref = { runtime, runtimeSessionId: key };
  const id = store.upsertSession(ref, T);
  const append = (kind, offset, extra = {}) => {
    const e = event(kind, T + offset, ref, extra);
    assert.equal(store.append(e, { sessionId: id, method: "runtime_id" }), true);
    return e.id;
  };
  const span = (turnKey, offset, extra = {}) => {
    store.putSpans([{ traceId: "trace", spanId: `span-${turnKey}-${offset}`, runtime, name: "codex.turn_input",
      conversationId: key, turnKey, startMs: T + offset, receivedAt: T, ...extra }]);
  };
  return { db, store, ref, id, append, span };
}

test("ingestion fixtures join MCP and prompts by time, Claude by reported key, and Codex by call span", (t) => {
  // Given: todo 2 log captures and the six-span todo 3 shape with the log fixture's join keys.
  const { db, store } = openStore();
  t.after(() => store.close());
  const deps = createIngestDeps(store, { now: () => T + 10000 });
  for (const name of ["claude-otlp-user-prompt.json", "claude-otlp-skill-activated.json",
    "claude-otlp-tool-result-bash-two-skills.json", "claude-otlp-api-request.json", "claude-otlp-tool-result-gisool-search.json",
    "codex-otlp-user-prompt.json", "codex-otlp-skill-invocation.json", "codex-otlp-tool-result.json", "codex-otlp-sse-event.json"]) {
    assert.equal(ingestOtlp(fixture(name), deps).status, 200);
  }
  assert.deepEqual(ingestOtlpTraces(fixture("codex-otlp-traces.json"), store, T), {
    status: 200, body: { partialSuccess: {} }, kept: 3, dropped: 3,
  });
  const ctx = { clientName: "codex-mcp-client", meta: { threadId: "codex-conv-1" } };
  const search = searchEvent(ctx, { traceId: "search-trace", query: "database", mode: "discovery",
    candidates: [], elapsedMs: 1 }, { total: 0 }, T + 1000);
  const load = loadEvent(ctx, { uri: uri("db-query"), loadId: "mcp-load", manifestDigest: "manifest",
    traceId: "search-trace" }, T + 2000);
  const read = readFileEvent(ctx, { skillUri: uri("db-query"), uri: uri("db-query") + "/reference",
    bytes: 23, loadId: "mcp-load" }, T + 3000);
  for (const e of [search, load, read]) {
    assert.equal(e.turnKey, undefined);
    assert.ok(ingest(e, deps));
  }
  const codexId = db.prepare("SELECT id FROM sessions WHERE conversation_id = 'codex-conv-1'").get().id;
  const claudeId = db.prepare("SELECT id FROM sessions WHERE runtime_session_id = 'claude-sess-1'").get().id;
  // When: analysis reads the actual persisted events and whitelisted spans.
  const codex = sessionTree(store, codexId);
  const claude = sessionTree(store, claudeId);
  // Then: expectations name capture values, not display text or computed expectations.
  assert.deepEqual(codex.turns.map((turn) => [turn.id, turn.startedAt]), [[CODEX_TURN, T]]);
  const turn = codex.turns[0];
  for (const kind of ["prompt", "search", "load", "read_file", "llm_call"]) {
    assert.equal(turn.events.find((e) => e.kind === kind).basis, "inferred_time", kind);
  }
  const call = turn.events.find((e) => e.kind === "tool_call");
  assert.equal(call.basis, "span_join");
  assert.equal(call.callId, "call_abc123");
  assert.deepEqual([call.data.toolName, call.data.durationMs, call.data.success], ["exec_command", 43, true]);
  assert.deepEqual([turn.events.find((e) => e.kind === "llm_call").data.totalTokens,
    turn.events.find((e) => e.kind === "llm_call").data.inputIncludesCache], [19572, true]);
  assert.equal(turn.events.find((e) => e.kind === "native_skill").basis, "reported");
  assert.equal(turn.skillSpans.length, 1, "native and MCP activation of db-query are one active skill");
  assert.equal(turn.skillSpans[0].uri, uri("db-query"));
  assert.equal(call.attribution, "single");
  assert.deepEqual(claude.turns.map((turn) => turn.id), ["p-1"]);
  const claudeCalls = claude.turns[0].events.filter((e) => e.kind === "tool_call");
  assert.equal(claudeCalls.length, 2);
  assert.ok(claudeCalls.every((e) => e.basis === "reported"));
  assert.deepEqual(claudeCalls.map((e) => e.data.toolName), ["Bash", "mcp__gisool__search_skills"]);
  assert.equal(codex.unassignedEvents.length, 0);
  assert.equal(claude.unassignedEvents.length, 0);
});

test("Claude activation groups two reported tool calls into one single-skill span", (t) => {
  // Given
  const { store, id, append } = seeded(t);
  append("prompt", 0, { turnKey: "p1" });
  append("native_skill", 1, { turnKey: "p1", data: { name: "debugging" } });
  append("tool_call", 2, { turnKey: "p1", data: { toolName: "Bash", success: true } });
  append("tool_call", 3, { turnKey: "p1", text: "SUCCESS: all checks passed", data: { toolName: "Read", success: false } });
  // When
  const turn = sessionTree(store, id).turns[0];
  // Then
  assert.equal(turn.skillSpans.length, 1);
  assert.equal(turn.skillSpans[0].name, "debugging");
  assert.deepEqual(turn.skillSpans[0].events.map((e) => [e.attribution, e.basis]), [["single", "reported"], ["single", "reported"]]);
  assert.deepEqual(turn.skillSpans[0].events.map((e) => e.data.success), [true, false]);
  assert.equal(turn.skillSpans[0].events[1].text, "SUCCESS: all checks passed", "misleading output does not override reported failure");
});

test("Codex span join overrides time while missing call ids and model calls fall back to the latest turn", (t) => {
  // Given
  const { store, id, append, span } = seeded(t, "codex");
  span("c1", 0);
  span("c2", 10);
  span("c1", 1, { name: "unified_exec.exec_command", callId: "joined" });
  const joined = append("tool_call", 11, { callId: "joined" });
  const missing = append("tool_call", 12, { callId: "no-matching-span" });
  const llm = append("llm_call", 13, { data: { inputTokens: 100, costUsd: null } });
  // When
  const tree = sessionTree(store, id);
  // Then
  assert.deepEqual(tree.turns[0].events.map((e) => [e.id, e.basis]), [[joined, "span_join"]]);
  assert.deepEqual(tree.turns[1].events.map((e) => [e.id, e.basis]), [[missing, "inferred_time"], [llm, "inferred_time"]]);
});

test("the log's exact span context joins without a call id and cannot leak from another conversation", (t) => {
  // Given
  const { store, id, append, span } = seeded(t, "codex");
  span("c1", 0);
  span("c2", 10);
  span("c1", 2, { name: "code_mode.handler.execute", spanId: "context", traceId: "broker" });
  span("c1", 3, { name: "unified_exec.exec_command", callId: "foreign", conversationId: "other-session" });
  const exact = append("tool_call", 11, { spanId: "context", data: { otelTraceId: "broker" } });
  const wrongTrace = append("tool_call", 12, { spanId: "context", data: { otelTraceId: "different-trace" } });
  const foreign = append("tool_call", 13, { callId: "foreign" });
  // When
  const tree = sessionTree(store, id);
  // Then
  assert.deepEqual(tree.turns[0].events.map((e) => [e.id, e.basis]), [[exact, "span_join"]]);
  assert.deepEqual(tree.turns[1].events.map((e) => [e.id, e.basis]), [[wrongTrace, "inferred_time"], [foreign, "inferred_time"]]);
});

test("cumulative skills are co-active, reported model attribution wins, and activation resets each turn", (t) => {
  // Given
  const { store, id, append } = seeded(t);
  append("prompt", 0, { turnKey: "p1" });
  const before = append("tool_call", 1);
  append("load", 2, { skillUri: uri("debugging") });
  append("load", 3, { skillUri: uri("programming") });
  const both = append("tool_call", 4);
  const reported = append("llm_call", 5, { data: { skillName: "debugging" } });
  append("prompt", 6, { turnKey: "p2" });
  const reset = append("tool_call", 7);
  // When
  const tree = sessionTree(store, id);
  // Then
  assert.equal(tree.turns[0].events.find((e) => e.id === before).attribution, "no_skill");
  const coactive = tree.turns[0].events.find((e) => e.id === both);
  assert.equal(coactive.attribution, "co_active");
  assert.deepEqual(coactive.skills, [uri("debugging"), uri("programming")]);
  assert.equal(tree.turns[0].events.find((e) => e.id === reported).attribution, "reported");
  assert.deepEqual(tree.turns[0].skillSpans.map((s) => s.events.map((e) => e.id)), [[both, reported], [both]]);
  assert.deepEqual(tree.turns[1].events.find((e) => e.id === reset).skills, []);
  assert.equal(tree.turns[1].skillSpans.length, 0);
});

test("equal-time boundary events enter the newest turn even when stored before the prompt", (t) => {
  // Given
  const { store, id, append } = seeded(t);
  const early = append("search", -1);
  append("prompt", 0, { turnKey: "p1" });
  const equal = append("search", 10);
  append("prompt", 10, { turnKey: "p2" });
  append("load", 10, { skillUri: uri("debugging") });
  const action = append("tool_call", 10);
  const explicit = append("tool_call", 10, { turnKey: "p1" });
  // When
  const tree = sessionTree(store, id);
  // Then
  assert.deepEqual(tree.unassignedEvents.map((e) => e.id), [early]);
  assert.deepEqual(tree.turns[0].events.filter((e) => e.kind === "tool_call").map((e) => e.id), [explicit]);
  assert.equal(tree.turns[1].events.find((e) => e.id === equal).basis, "inferred_time");
  assert.equal(tree.turns[1].events.find((e) => e.id === action).attribution, "single");
});

test("Codex missing turn spans produce synthetic prompt turns without consuming an earlier span", (t) => {
  // Given
  const { store, id, append, span } = seeded(t, "codex");
  span("c1", 0);
  append("prompt", 0);
  const prompt = append("prompt", 10);
  const action = append("tool_call", 11);
  // When
  const tree = sessionTree(store, id);
  // Then
  assert.deepEqual(tree.turns.map((turn) => turn.id), ["c1", `prompt:${prompt}`]);
  assert.deepEqual(tree.turns[1].events.map((e) => [e.id, e.basis]), [[prompt, "inferred_time"], [action, "inferred_time"]]);
});

test("sessions without turns keep events unassigned and missing sessions return undefined", (t) => {
  // Given
  const { store, id, append } = seeded(t);
  const tool = append("tool_call", 1);
  const reported = append("native_skill", 2, { turnKey: "unknown", data: { name: "debugging" } });
  // When
  const tree = sessionTree(store, id);
  // Then
  assert.deepEqual(tree.turns, []);
  assert.deepEqual(tree.unassignedEvents.map((e) => e.id), [tool, reported]);
  assert.equal(sessionTree(store, "does-not-exist"), undefined);
});

test("analysis is recomputed after late spans and events rather than returning stale state", (t) => {
  // Given
  const { store, id, append, span } = seeded(t, "codex");
  span("c1", 0);
  span("c2", 10);
  const tool = append("tool_call", 11, { callId: "late" });
  const before = sessionTree(store, id);
  span("c1", 1, { name: "unified_exec.exec_command", callId: "late" });
  append("load", 2, { turnKey: "c1", skillUri: uri("debugging") });
  // When
  const after = sessionTree(store, id);
  // Then
  assert.equal(before.turns[1].events[0].basis, "inferred_time");
  assert.deepEqual(after.turns[0].events.filter((e) => e.id === tool).map((e) => e.basis), ["span_join"]);
  assert.equal(after.turns[0].skillSpans[0].events[0].id, tool);
  assert.equal(after.turns[1].events.length, 0);
});

test("Claude model fixture preserves the reported skill name through ingestion and analysis", (t) => {
  // Given: api_request with the documented skill.name attribute.
  const { db, store } = openStore();
  t.after(() => store.close());
  const deps = createIngestDeps(store);
  ingestOtlp(fixture("claude-otlp-user-prompt.json"), deps);
  ingestOtlp(fixture("claude-otlp-skill-activated.json"), deps);
  const body = fixture("claude-otlp-api-request.json");
  body.resourceLogs[0].scopeLogs[0].logRecords[0].attributes.push({ key: "skill.name", value: { stringValue: "commit-helper" } });
  ingestOtlp(body, deps);
  const id = db.prepare("SELECT id FROM sessions").get().id;
  // When
  const tree = sessionTree(store, id);
  // Then
  const llm = tree.turns[0].skillSpans[0].events[0];
  assert.equal(llm.attribution, "reported");
  assert.deepEqual(llm.skills, ["commit-helper"]);
  assert.equal(llm.data.costUsd, 0.31913075);
});

test("workspace tree orders two panes and three linked sessions and handles registered tab flows", (t) => {
  // Given
  const { db, store, id, append } = seeded(t);
  append("prompt", 0, { turnKey: "p1" });
  const second = store.upsertSession({ runtime: "codex", conversationId: "second" }, T + 2);
  const third = store.upsertSession({ runtime: "omo", runtimeSessionId: "third" }, T + 3);
  db.prepare("INSERT INTO herdr_workspaces (id, label) VALUES (?, ?)").run("w", "workspace");
  db.prepare("INSERT INTO herdr_tabs (id, workspace_id, created_ms) VALUES (?, ?, ?)").run("tab", "w", T);
  db.prepare("INSERT INTO herdr_tabs (id, workspace_id, created_ms) VALUES (?, ?, ?)").run("other-tab", "w", T + 1);
  const pane = db.prepare("INSERT INTO herdr_panes (id, workspace_id, tab_id, created_ms) VALUES (?, ?, ?, ?)");
  pane.run("b", "w", "tab", T + 1);
  pane.run("a", "w", "tab", T);
  pane.run("other-pane", "w", "other-tab", T + 2);
  const link = db.prepare(`INSERT INTO pane_sessions (pane_id, agent_session_value, session_id, source, first_seen_ms)
    VALUES (?, ?, ?, ?, ?)`);
  link.run("a", "second", second, "herdr:report", T + 2);
  link.run("a", "first", id, "herdr:report", T);
  link.run("b", "third", third, "inferred:cwd_time", T + 3);
  link.run("b", "pending", null, "herdr:report", T + 4);
  db.prepare("INSERT INTO flows (id, workspace_id, tab_id) VALUES (?, ?, ?)").run("registered", "w", "tab");
  // When
  const implicit = flowTree(store, "w");
  const registered = flowTree(store, "registered");
  // Then
  assert.equal(implicit.registered, false);
  assert.deepEqual(implicit.tabs.map((tab) => tab.id), ["tab", "other-tab"]);
  assert.deepEqual(implicit.tabs[0].panes.map((pane) => pane.id), ["a", "b"]);
  assert.deepEqual(implicit.tabs[0].panes[0].sessions.map((s) => s.session.id), [id, second]);
  assert.deepEqual(implicit.tabs[0].panes[1].sessions.map((s) => [s.session?.id ?? null, s.basis]), [[third, "inferred"], [null, "reported"]]);
  assert.equal(implicit.tabs[0].panes[0].sessions[0].session.turns[0].id, "p1");
  assert.equal(registered.registered, true);
  assert.deepEqual(registered.tabs.map((tab) => tab.id), ["tab"]);
  assert.equal(flowTree(store, "does-not-exist"), undefined);
});

test("outside herdr sessions are time-bounded, limited, and exclude linked sessions", (t) => {
  // Given
  const { db, store, id } = seeded(t);
  const outside = store.upsertSession({ runtime: "omo", runtimeSessionId: "outside" }, T + 2);
  store.upsertSession({ runtime: "codex", conversationId: "too-late" }, T + 100);
  db.prepare("INSERT INTO pane_sessions (pane_id, agent_session_value, session_id) VALUES (?, ?, ?)").run("p", "linked", id);
  // When
  const tree = outsideHerdr(store, { from: T, to: T + 10, limit: 1 });
  // Then
  assert.equal(tree.id, "outside-herdr");
  assert.deepEqual(tree.sessions.map((s) => s.id), [outside]);
  assert.deepEqual(outsideHerdr(store, { from: T + 3, to: T + 10, limit: 100 }).sessions, []);
});

test("pure session assembly does not mutate its input", () => {
  // Given
  const input = { id: "pure", runtime: "omo", startedAt: T, endedAt: null, spans: [],
    events: [{ id: "prompt", ts: T, kind: "prompt", source: "hook", turnKey: null, callId: null, spanId: null,
      skillUri: null, text: null, textLength: null, data: {} }] };
  const before = structuredClone(input);
  // When
  const tree = assembleSession(input);
  // Then
  assert.deepEqual(input, before);
  assert.equal(tree.turns[0].id, "prompt:prompt");
  assert.equal(tree.turns[0].events[0].basis, "inferred_time");
});
