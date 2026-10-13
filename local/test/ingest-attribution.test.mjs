import assert from "node:assert/strict";
import { test } from "node:test";
import { distImport } from "./_helpers.mjs";
import { fixture, memoryStore } from "./helpers/ingest.mjs";

const { attribute, createAttributionState, WINDOW_MS } = await distImport("ingest/attribution.js");
const { searchEvent, loadEvent, readFileEvent } = await distImport("ingest/mcp-recorder.js");
const { createIngestDeps, ingest, ingestHook } = await distImport("ingest/pipeline.js");

const NOW = 1_800_000_000_000;
const ev = (over) => ({ id: over.id ?? "e", ts: NOW, kind: "prompt", source: "hook", data: {}, ...over });
const outcome = { traceId: "tr1", query: "commit", mode: "discovery", elapsedMs: 1, candidates: [] };

test("(1) hook/otel event with runtime session id -> runtime_id (upsert)", () => {
  const store = memoryStore();
  const a = attribute(ev({ ref: { runtime: "claude-code", runtimeSessionId: "s1" } }), store, NOW);
  assert.equal(a.method, "runtime_id");
  assert.equal(a.sessionId, store.upsertSession({ runtime: "claude-code", runtimeSessionId: "s1" }, NOW));
  const b = attribute(ev({ source: "otel", ref: { runtime: "codex", conversationId: "c1" } }), store, NOW);
  assert.equal(b.method, "runtime_id");
  assert.notEqual(b.sessionId, a.sessionId);
});

test("(2) MCP event with vendor session id -> vendor_meta (never runtime_id)", () => {
  const store = memoryStore();
  const codex = searchEvent({ clientName: "codex-mcp-client", meta: { threadId: "t1" } }, outcome, { total: 0 }, NOW);
  const a = attribute(codex, store, NOW);
  assert.equal(a.method, "vendor_meta");
  assert.equal(a.sessionId, store.upsertSession({ runtime: "codex", conversationId: "t1" }, NOW));
  const oc = searchEvent({ clientName: "opencode", meta: { "ai.opencode/sessionID": "ses_1" } }, outcome, { total: 0 }, NOW);
  assert.equal(attribute(oc, store, NOW).method, "vendor_meta");
});

test("(2) MCP event whose Claude toolUseId is already bound -> vendor_meta", () => {
  const store = memoryStore();
  const state = createAttributionState();
  state.toolUseSessions.set("tu5", "sess-bound");
  const e = searchEvent({ clientName: "claude-code", meta: { "claudecode/toolUseId": "tu5" } }, outcome, { total: 0 }, NOW);
  assert.deepEqual(attribute(e, store, NOW, state), { sessionId: "sess-bound", method: "vendor_meta" });
});

test("(3) load/read_file joined by traceId or loadId -> trace_handle", () => {
  const store = memoryStore();
  const deps = createIngestDeps(store, { now: () => NOW });
  const search = ingest(searchEvent({ clientName: "codex-mcp-client", meta: { threadId: "t1" } }, outcome, { total: 0 }, NOW), deps);
  assert.equal(search.method, "vendor_meta");
  const load = ingest(loadEvent({ clientName: "codex-mcp-client" }, { uri: "skill://local/a/x/SKILL.md", loadId: "L1", manifestDigest: "m", traceId: "tr1" }, NOW), deps);
  assert.deepEqual(load, { sessionId: search.sessionId, method: "trace_handle" });
  const read = ingest(readFileEvent({ clientName: "codex-mcp-client" }, { skillUri: "skill://local/a/x/SKILL.md", uri: "skill://local/a/x/r.md", bytes: 1, loadId: "L1" }, NOW), deps);
  assert.deepEqual(read, { sessionId: search.sessionId, method: "trace_handle" });
});

test("(4) exactly one fresh open session of the same runtime -> window", () => {
  const store = memoryStore();
  const id = store.addSession({ runtime: "codex", conversationId: "c1" }, NOW - WINDOW_MS + 1);
  const e = searchEvent({ clientName: "codex-mcp-client" }, outcome, { total: 0 }, NOW);
  assert.deepEqual(attribute(e, store, NOW), { sessionId: id, method: "window" });
});

test("(5) unattributed: no_session, ambiguous (two concurrent Codex sessions), stale", () => {
  const e = searchEvent({ clientName: "codex-mcp-client" }, outcome, { total: 0 }, NOW);
  assert.deepEqual(attribute(e, memoryStore(), NOW), { sessionId: "unattributed", method: "none", reason: "no_session" });

  const two = memoryStore();
  two.addSession({ runtime: "codex", conversationId: "c1" }, NOW - 1_000);
  two.addSession({ runtime: "codex", conversationId: "c2" }, NOW - 2_000);
  assert.deepEqual(attribute(e, two, NOW), { sessionId: "unattributed", method: "none", reason: "ambiguous" });

  const stale = memoryStore();
  stale.addSession({ runtime: "codex", conversationId: "c1" }, NOW - WINDOW_MS - 1);
  assert.deepEqual(attribute(e, stale, NOW), { sessionId: "unattributed", method: "none", reason: "stale" });
});

test("never attaches across runtimes", () => {
  const store = memoryStore();
  store.addSession({ runtime: "claude-code", runtimeSessionId: "s1" }, NOW - 1_000);
  const codex = searchEvent({ clientName: "codex-mcp-client" }, outcome, { total: 0 }, NOW);
  assert.deepEqual(attribute(codex, store, NOW), { sessionId: "unattributed", method: "none", reason: "no_session" });
  const unknown = searchEvent({ clientName: "mystery" }, outcome, { total: 0 }, NOW);
  assert.equal(attribute(unknown, store, NOW).sessionId, "unattributed");

  store.addSession({ runtime: "claude-code", runtimeSessionId: "s2" }, NOW - 1_000);
  const codexId = store.addSession({ runtime: "codex", conversationId: "c1" }, NOW - 1_000);
  assert.deepEqual(attribute(codex, store, NOW), { sessionId: codexId, method: "window" });
});

function lateBindingStore() {
  const store = memoryStore();
  return { store, deps: createIngestDeps(store, { now: () => NOW }) };
}

test("late binding: MCP search with toolUseId tu1 then PostToolUse hook -> vendor_meta in session s1", () => {
  const { store, deps } = lateBindingStore();
  const first = ingest(searchEvent({ clientName: "claude-code", meta: { "claudecode/toolUseId": "tu1" } }, outcome, { total: 0 }, NOW), deps);
  assert.equal(first.sessionId, "unattributed");
  ingestHook("claude-code", fixture("claude-hook-post-tool-use-gisool.json"), deps);
  const s1 = store.upsertSession({ runtime: "claude-code", runtimeSessionId: "s1" }, NOW);
  assert.equal(store.events.length, 1);
  assert.deepEqual(store.events[0].attribution, { sessionId: s1, method: "vendor_meta" });
});

test("late binding: hook first, then MCP search -> same result", () => {
  const { store, deps } = lateBindingStore();
  ingestHook("claude-code", fixture("claude-hook-post-tool-use-gisool.json"), deps);
  ingest(searchEvent({ clientName: "claude-code", meta: { "claudecode/toolUseId": "tu1" } }, outcome, { total: 0 }, NOW), deps);
  const s1 = store.upsertSession({ runtime: "claude-code", runtimeSessionId: "s1" }, NOW);
  assert.equal(store.events.length, 1);
  assert.deepEqual(store.events[0].attribution, { sessionId: s1, method: "vendor_meta" });
});
