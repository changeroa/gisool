import assert from "node:assert/strict";
import test from "node:test";
import { distImport } from "./_helpers.mjs";
import { fixture } from "./helpers/ingest.mjs";
import { event, openStore, uri } from "./helpers/store.mjs";

const { sessionTree, flowTree, outsideHerdr, assembleSession } = await distImport("analysis/tree.js");
const { createIngestDeps, ingest, ingestHook, ingestOtlp } = await distImport("ingest/pipeline.js");
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

for (const { first, hookOffset } of [
  { first: "otel", hookOffset: 1 }, { first: "hook", hookOffset: 1 },
  { first: "otel", hookOffset: -1 }, { first: "hook", hookOffset: -1 },
]) {
  test(`Claude mixed hook and OTLP prompts keep MCP skill usage in the reported turn (${first} first, hook ${hookOffset} ms)`, (t) => {
    // Given: the reviewer's mixed-source ingestion, including both arrival orders and timestamp skew.
    const { db, store } = openStore();
    t.after(() => store.close());
    const deps = createIngestDeps(store, { now: () => T + hookOffset });
    const hook = () => assert.deepEqual(ingestHook("claude-code", {
      hook_event_name: "UserPromptSubmit", session_id: "claude-sess-1", prompt: "Write a commit message please",
    }, deps), { accepted: 1, dropped: 0 });
    const otel = () => assert.equal(ingestOtlp(fixture("claude-otlp-user-prompt.json"), deps).status, 200);
    if (first === "hook") { hook(); otel(); } else { otel(); hook(); }
    const ctx = { clientName: "claude-code", meta: { sessionId: "claude-sess-1" } };
    assert.ok(ingest(searchEvent(ctx, { traceId: "mixed-search", query: "debugging", mode: "discovery",
      candidates: [], elapsedMs: 1 }, { total: 0 }, T + 2), deps));
    assert.ok(ingest(loadEvent(ctx, { uri: uri("debugging"), loadId: "mixed-load", manifestDigest: "digest",
      traceId: "mixed-search" }, T + 3), deps));
    assert.equal(ingestOtlp(fixture("claude-otlp-api-request.json"), deps).status, 200);
    const id = db.prepare("SELECT id FROM sessions WHERE runtime_session_id = 'claude-sess-1'").get().id;
    // When
    const tree = sessionTree(store, id);
    // Then: the load and actual model usage share the runtime's turn, not just an arbitrary turn count.
    assert.deepEqual(tree.turns.map((turn) => [turn.id, turn.startedAt, turn.basis]), [["p-1", T, "reported"]]);
    const turn = tree.turns[0];
    for (const kind of ["search", "load"]) assert.equal(turn.events.find((e) => e.kind === kind).basis, "inferred_time");
    const model = turn.events.find((e) => e.kind === "llm_call");
    assert.deepEqual([model.basis, model.attribution, model.data.model, model.data.costUsd],
      ["reported", "single", "claude-fable-5-1", 0.31913075]);
    assert.deepEqual(model.skills, [uri("debugging")]);
    assert.deepEqual(turn.skillSpans.map((s) => [s.uri, s.events.map((e) => e.kind)]), [[uri("debugging"), ["llm_call"]]]);
    if (hookOffset < 0) {
      assert.deepEqual(tree.unassignedEvents.map((e) => [e.kind, e.source]), [["prompt", "hook"]]);
    } else {
      assert.equal(tree.unassignedEvents.length, 0);
      assert.equal(turn.events.find((e) => e.source === "hook").basis, "inferred_time");
    }
  });
}

for (const first of ["span", "prompt"]) {
  test(`distinct keyless Codex prompts retain a fallback turn without leaking skills (${first} first)`, (t) => {
    // Given: R2 has two real prompt records 3 seconds apart but only the first turn_input span.
    const { db, store } = openStore();
    t.after(() => store.close());
    const deps = createIngestDeps(store);
    const firstPrompt = fixture("codex-otlp-user-prompt.json");
    firstPrompt.resourceLogs[0].scopeLogs[0].logRecords[0].attributes.find((a) => a.key === "prompt").value.stringValue = "Inspect the configuration";
    const secondPrompt = structuredClone(firstPrompt);
    const secondRecord = secondPrompt.resourceLogs[0].scopeLogs[0].logRecords[0];
    secondRecord.timeUnixNano = "1760320003000000000";
    secondRecord.attributes.find((a) => a.key === "prompt").value.stringValue = "Instead inspect the tests";
    const traces = fixture("codex-otlp-traces.json");
    traces.resourceSpans[0].scopeSpans[0].spans = [traces.resourceSpans[0].scopeSpans[0].spans[0]];
    const spans = () => assert.equal(ingestOtlpTraces(traces, store, T).kept, 1);
    const prompts = () => {
      assert.equal(ingestOtlp(firstPrompt, deps).status, 200);
      assert.equal(ingestOtlp(secondPrompt, deps).status, 200);
    };
    if (first === "span") { spans(); prompts(); } else { prompts(); spans(); }
    const ctx = { clientName: "codex-mcp-client", meta: { threadId: "codex-conv-1" } };
    assert.ok(ingest(loadEvent(ctx, { uri: uri("debugging"), loadId: "r2-load", manifestDigest: "digest" }, T + 1), deps));
    const usage = fixture("codex-otlp-sse-event.json");
    usage.resourceLogs[0].scopeLogs[0].logRecords[0].timeUnixNano = "1760320003500000000";
    assert.equal(ingestOtlp(usage, deps).status, 200);
    const id = db.prepare("SELECT id FROM sessions WHERE conversation_id = 'codex-conv-1'").get().id;
    const promptRows = db.prepare("SELECT id, turn_key FROM events WHERE kind = 'prompt' ORDER BY ts").all();
    assert.deepEqual(promptRows.map((p) => p.turn_key), [null, null]);
    // When
    const tree = sessionTree(store, id);
    // Then: the first turn keeps its skill, but the second starts with an empty active set.
    assert.deepEqual(tree.turns.map((turn) => [turn.id, turn.startedAt]), [[CODEX_TURN, T], [`prompt:${promptRows[1].id}`, T + 3000]]);
    assert.deepEqual(tree.turns.map((turn) => turn.events.filter((e) => e.kind === "prompt").map((e) => e.text)),
      [["Inspect the configuration"], ["Instead inspect the tests"]]);
    assert.deepEqual(tree.turns[0].skillSpans.map((span) => span.uri), [uri("debugging")]);
    const model = tree.turns[1].events.find((e) => e.kind === "llm_call");
    assert.deepEqual([model.basis, model.attribution, model.skills], ["inferred_time", "no_skill", []]);
    assert.equal(tree.turns[1].skillSpans.length, 0);
  });
}

for (const runtime of ["claude-code", "codex"]) {
  for (const first of ["reported", "hook"]) {
    test(`${runtime} pairs two reported turns with two hook prompts (${first} first)`, (t) => {
      // Given: both reported boundaries and both hooks are within each other's 5-second windows.
      const { db, store } = openStore();
      t.after(() => store.close());
      let now = T + 1;
      const deps = createIngestDeps(store, { now: () => now });
      const sessionId = runtime === "codex" ? "codex-conv-1" : "claude-sess-1";
      const hooks = () => {
        assert.equal(ingestHook(runtime, { hook_event_name: "UserPromptSubmit", session_id: sessionId, prompt: "First task" }, deps).accepted, 1);
        now = T + 3001;
        assert.equal(ingestHook(runtime, { hook_event_name: "UserPromptSubmit", session_id: sessionId, prompt: "Second task" }, deps).accepted, 1);
      };
      const reported = () => {
        if (runtime === "codex") {
          const traces = fixture("codex-otlp-traces.json");
          const one = traces.resourceSpans[0].scopeSpans[0].spans[0];
          const two = structuredClone(one);
          two.spanId = "eef6aff0499f5a13";
          two.startTimeUnixNano = "1760320003000000000";
          two.endTimeUnixNano = "1760320003100000000";
          two.attributes.find((a) => a.key === "turn.id").value.stringValue = "second-turn";
          traces.resourceSpans[0].scopeSpans[0].spans = [one, two];
          assert.equal(ingestOtlpTraces(traces, store, T).kept, 2);
        } else {
          const one = fixture("claude-otlp-user-prompt.json");
          one.resourceLogs[0].scopeLogs[0].logRecords[0].attributes.find((a) => a.key === "prompt").value.stringValue = "First task";
          const two = structuredClone(one);
          const record = two.resourceLogs[0].scopeLogs[0].logRecords[0];
          record.timeUnixNano = "1760320003000000000";
          record.attributes.find((a) => a.key === "prompt.id").value.stringValue = "p-2";
          record.attributes.find((a) => a.key === "prompt").value.stringValue = "Second task";
          assert.equal(ingestOtlp(one, deps).status, 200);
          assert.equal(ingestOtlp(two, deps).status, 200);
        }
      };
      if (first === "hook") { hooks(); reported(); } else { reported(); hooks(); }
      const ctx = { clientName: runtime === "codex" ? "codex-mcp-client" : "claude-code", meta: { sessionId } };
      assert.ok(ingest(loadEvent(ctx, { uri: uri("debugging"), loadId: "paired-load", manifestDigest: "digest" }, T + 2), deps));
      const usage = fixture(runtime === "codex" ? "codex-otlp-sse-event.json" : "claude-otlp-api-request.json");
      const record = usage.resourceLogs[0].scopeLogs[0].logRecords[0];
      record.timeUnixNano = "1760320003500000000";
      if (runtime === "claude-code") record.attributes.find((a) => a.key === "prompt.id").value.stringValue = "p-2";
      assert.equal(ingestOtlp(usage, deps).status, 200);
      const id = db.prepare("SELECT id FROM sessions WHERE runtime = ?").get(runtime).id;
      // When
      const tree = sessionTree(store, id);
      // Then
      assert.deepEqual(tree.turns.map((turn) => turn.id), runtime === "codex" ? [CODEX_TURN, "second-turn"] : ["p-1", "p-2"]);
      assert.deepEqual(tree.turns.map((turn) => turn.events.filter((e) => e.source === "hook").map((e) => [e.text, e.basis])),
        [[["First task", "inferred_time"]], [["Second task", "inferred_time"]]]);
      assert.deepEqual(tree.turns[0].skillSpans.map((s) => s.uri), [uri("debugging")]);
      const model = tree.turns[1].events.find((e) => e.kind === "llm_call");
      assert.deepEqual([model.attribution, model.skills], ["no_skill", []]);
    });
  }
}

for (const runtime of ["claude-code", "codex"]) {
  test(`${runtime} pairs only the nearest prompt and breaks equal-distance ties toward the earlier timestamp`, (t) => {
    // Given: an exact-time prompt wins first; at a second boundary, the two candidates are equally distant.
    const { store, id, append, span } = seeded(t, runtime);
    if (runtime === "codex") { span("first", 0); span("second", 3000); }
    else { append("prompt", 0, { turnKey: "first" }); append("prompt", 3000, { turnKey: "second" }); }
    append("prompt", 0);
    const surplus = append("prompt", 1);
    append("prompt", 2999);
    const later = append("prompt", 3001);
    // When
    const tree = sessionTree(store, id);
    // Then: each reported boundary consumes exactly one prompt; the surplus and later tie keep their own turns.
    assert.deepEqual(tree.turns.map((turn) => turn.id), ["first", `prompt:${surplus}`, "second", `prompt:${later}`]);
  });

  for (const capture of ["text", "length"]) {
    test(`${runtime} prefers matching prompt ${capture} over a nearer observation`, (t) => {
      // Given: prompt identity is available on the keyed prompt even when timestamp proximity disagrees.
      const { store, id, append, span } = seeded(t, runtime);
      if (runtime === "codex") span("reported", 0);
      const keyed = capture === "text" ? { text: "Inspect config" } : { textLength: 14 };
      append("prompt", 0, { turnKey: "reported", ...keyed });
      const wrong = append("prompt", -1, capture === "text" ? { text: "Inspect tests" } : { textLength: 13 });
      const matched = append("prompt", 2, keyed);
      // When
      const tree = sessionTree(store, id);
      // Then
      assert.deepEqual(tree.turns.map((turn) => turn.id), [`prompt:${wrong}`, "reported"]);
      assert.equal(tree.turns[0].events[0].id, wrong);
      assert.equal(tree.turns[1].events.find((e) => e.id === matched).basis, "inferred_time");
    });
  }
}

for (const first of ["span", "prompt"]) {
  test(`Codex absorbs the earlier tied prompt and preserves the surplus hook turn (${first} first)`, (t) => {
    // Given: two keyless observations are equally near one span; only one can be absorbed.
    const { db, store } = openStore();
    t.after(() => store.close());
    const deps = createIngestDeps(store, { now: () => T + 2 });
    const traces = fixture("codex-otlp-traces.json");
    const turnSpan = traces.resourceSpans[0].scopeSpans[0].spans[0];
    turnSpan.startTimeUnixNano = "1760320000001000000";
    const span = () => assert.equal(ingestOtlpTraces(traces, store, T).kept, 3);
    const prompts = () => {
      assert.equal(ingestOtlp(fixture("codex-otlp-user-prompt.json"), deps).status, 200);
      assert.deepEqual(ingestHook("codex", { hook_event_name: "UserPromptSubmit",
        session_id: "codex-conv-1", prompt: "로그인 버그 고쳐줘 please" }, deps), { accepted: 1, dropped: 0 });
    };
    if (first === "span") { span(); prompts(); } else { prompts(); span(); }
    const ctx = { clientName: "codex-mcp-client", meta: { threadId: "codex-conv-1" } };
    assert.ok(ingest(loadEvent(ctx, { uri: uri("debugging"), loadId: "codex-mixed", manifestDigest: "digest" }, T + 3), deps));
    assert.equal(ingestOtlp(fixture("codex-otlp-tool-result.json"), deps).status, 200);
    const id = db.prepare("SELECT id FROM sessions WHERE conversation_id = 'codex-conv-1'").get().id;
    const hookId = db.prepare("SELECT id FROM events WHERE source = 'hook' AND kind = 'prompt'").get().id;
    // When
    const tree = sessionTree(store, id);
    // Then
    assert.deepEqual(tree.turns.map((turn) => [turn.id, turn.startedAt, turn.basis]), [
      [CODEX_TURN, T + 1, "reported"], [`prompt:${hookId}`, T + 2, "inferred_time"],
    ]);
    assert.deepEqual(tree.unassignedEvents.map((e) => [e.kind, e.source]), [["prompt", "otel"]]);
    const fallback = tree.turns[1];
    assert.equal(fallback.events.find((e) => e.source === "hook").basis, "inferred_time");
    assert.equal(fallback.events.find((e) => e.kind === "load").basis, "inferred_time");
    assert.deepEqual(fallback.skillSpans.map((s) => [s.uri, s.events.length]), [[uri("debugging"), 0]]);
    const call = tree.turns[0].events.find((e) => e.kind === "tool_call");
    assert.deepEqual([call.callId, call.basis, call.attribution], ["call_abc123", "span_join", "no_skill"]);
    assert.deepEqual(call.skills, []);
  });
}

for (const runtime of ["claude-code", "codex"]) {
  test(`${runtime} hook-only sessions retain separate synthetic turns without OTLP`, (t) => {
    // Given
    const { db, store } = openStore();
    t.after(() => store.close());
    let now = T;
    const deps = createIngestDeps(store, { now: () => now });
    const payload = { hook_event_name: "UserPromptSubmit", session_id: "hook-only", prompt: "debug" };
    assert.equal(ingestHook(runtime, payload, deps).accepted, 1);
    now = T + 1;
    assert.equal(ingestHook(runtime, payload, deps).accepted, 1);
    const id = db.prepare("SELECT id FROM sessions WHERE runtime_session_id = 'hook-only'").get().id;
    const prompts = db.prepare("SELECT id FROM events WHERE kind = 'prompt' ORDER BY ts, rowid").all();
    // When
    const tree = sessionTree(store, id);
    // Then: even close distinct hook-only prompts are preserved, not merged without a reported boundary.
    assert.deepEqual(tree.turns.map((turn) => [turn.id, turn.startedAt, turn.basis]), [
      [`prompt:${prompts[0].id}`, T, "inferred_time"], [`prompt:${prompts[1].id}`, T + 1, "inferred_time"],
    ]);
    assert.deepEqual(tree.turns.map((turn) => turn.events.map((e) => e.kind)), [["prompt"], ["prompt"]]);
    assert.equal(tree.unassignedEvents.length, 0);
  });
}

for (const runtime of ["claude-code", "codex"]) {
  test(`${runtime} prompt deduplication is inclusive at 5 seconds and preserves later fallback turns`, (t) => {
    // Given: this session has one reported turn; a nearby keyed turn in a different session must not suppress fallback.
    const { store, id, append, span } = seeded(t, runtime);
    if (runtime === "codex") span("reported", 0);
    else append("prompt", 0, { turnKey: "reported" });
    const near = append("prompt", 5000);
    const later = append("prompt", 5001);
    const otherId = store.upsertSession({ runtime, runtimeSessionId: "different-session" }, T + 5001);
    assert.equal(store.append(event("prompt", T + 5001, { runtime, runtimeSessionId: "different-session" },
      { turnKey: "other-reported" }), { sessionId: otherId, method: "runtime_id" }), true);
    // When
    const tree = sessionTree(store, id);
    // Then
    assert.deepEqual(tree.turns.map((turn) => turn.id), ["reported", `prompt:${later}`]);
    assert.equal(tree.turns[0].events.find((e) => e.id === near).basis, "inferred_time");
    assert.equal(tree.turns[1].events[0].id, later);
    assert.equal(tree.turns[1].basis, "inferred_time");
  });
}

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
