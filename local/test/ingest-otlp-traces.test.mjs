import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { distImport } from "./_helpers.mjs";
import { bearer, http, jsonHeaders, startTestServer } from "./helpers/api.mjs";
import { openStore } from "./helpers/store.mjs";

const { ingestOtlpTraces, parseOtlpTraces } = await distImport("ingest/otlp-traces.js");

const NOW = 1_800_000_000_000;
const TRACE = "daaba4f3553cf63ffba0fec16a71db4f";
const BIG_TRACE = "a4ed70d677f5afe2c5ccdeb8a7df01eb";
const TURN = "01a13990-4062-7fb3-bb7c-78e2a3435556";
const CONV = "01a13990-3d89-7921-8781-ec65b542c92c";
const CALL = "call_8vR2qH";
const SECRET = "NEVER-STORED-ATTRIBUTE";

const attrs = (obj) => Object.entries(obj).map(([key, value]) => ({ key, value: { stringValue: value } }));

function span(name, spanId, attributes, extra = {}) {
  return {
    traceId: TRACE, spanId, parentSpanId: "ed21a5ffe92a277c", name, kind: 1,
    startTimeUnixNano: "1800000000000000000", endTimeUnixNano: "1800000000123456789",
    attributes: attrs(attributes), status: {}, ...extra,
  };
}

function batch(spans, serviceName = "codex") {
  return { resourceSpans: [{ resource: { attributes: attrs({ "service.name": serviceName, "service.version": "0.162.1" }) }, scopeSpans: [{ scope: { name: "codex" }, spans }] }] };
}

// The shapes and attribute keys come from one real Codex turn (verify-skill-trace.md): turn spans carry `turn.id`,
// execution spans carry `turn_id` plus `call_id`, and the runtime's own spans carry neither.
const SIX_SPANS = batch([
  span("codex.turn_input", "eef6aff0499f5a12", { "turn.id": TURN, "conversation.id": CONV }),
  span("codex.sampling", "4833ab95c18b5f35", { "turn.id": TURN, "conversation.id": CONV, "codex.turn.phase": "sampling" }),
  span("unified_exec.exec_command", "ca230b04db5d3a37", { turn_id: TURN, call_id: CALL, "conversation.id": CONV, outcome: SECRET }),
  span("fs.read_file", "aa00000000000001", { "code.file.path": "/tmp/skill/SKILL.md", sandboxed: "true" }),
  span("fs.get_metadata", "aa00000000000002", { target: "codex_core::rollout" }),
  span("auth", "aa00000000000003", { "thread.name": "tokio-runtime-worker" }),
]);

function spanRows(db) {
  return db.prepare("SELECT * FROM otel_spans ORDER BY name").all();
}

function counter(db, key) {
  return db.prepare("SELECT value FROM meta WHERE key = ?").get(`ingest.${key}`)?.value ?? "0";
}

test("six-span Codex batch stores only the three spans that carry turn or call keys", () => {
  const { db, store } = openStore();
  try {
    const parsed = parseOtlpTraces(SIX_SPANS, NOW);
    assert.equal(parsed.ok, true);
    assert.deepEqual(parsed.response, { partialSuccess: {} });
    assert.equal(parsed.spans.length, 3);
    assert.equal(parsed.dropped, 3);

    assert.equal(store.putSpans(parsed.spans, parsed.dropped), 3);
    const rows = spanRows(db);
    assert.deepEqual(rows.map((r) => r.name), ["codex.sampling", "codex.turn_input", "unified_exec.exec_command"]);
    const exec = rows[2];
    assert.deepEqual(
      { ...exec },
      {
        trace_id: TRACE, span_id: "ca230b04db5d3a37", parent_span_id: "ed21a5ffe92a277c", name: "unified_exec.exec_command",
        runtime: "codex", conversation_id: CONV, turn_key: TURN, call_id: CALL,
        start_ms: 1_800_000_000_000, end_ms: 1_800_000_000_123, received_at: NOW,
        recording_orders_json: JSON.stringify({ [db.prepare("SELECT domain FROM recording_clock").get().domain]: 3 }),
      },
    );
    assert.equal(rows[1].turn_key, TURN);
    assert.equal(rows[1].call_id, null);
    assert.ok(!JSON.stringify(rows).includes(SECRET), "attributes outside the whitelist are not stored");
    assert.equal(counter(db, "accepted"), "3", "counters stay the integer strings countIngest writes");
    assert.equal(counter(db, "dropped"), "3");
  } finally {
    store.close();
  }
});

test("a replayed batch stores nothing new", () => {
  const { db, store } = openStore();
  try {
    const first = parseOtlpTraces(SIX_SPANS, NOW);
    assert.equal(store.putSpans(first.spans, first.dropped), 3);
    const replay = parseOtlpTraces(SIX_SPANS, NOW + 60_000);
    assert.equal(store.putSpans(replay.spans, replay.dropped), 0);
    assert.equal(spanRows(db).length, 3);
    assert.equal(counter(db, "accepted"), "3", "only new rows count as accepted");
    assert.equal(counter(db, "dropped"), "6");
  } finally {
    store.close();
  }
});

test("runtime comes from resource service.name", () => {
  const joinable = [span("claude_code.tool", "bb00000000000001", { call_id: CALL })];
  const runtimeOf = (serviceName) => parseOtlpTraces(batch(joinable, serviceName), NOW).spans[0].runtime;
  assert.equal(runtimeOf("codex"), "codex");
  assert.equal(runtimeOf("claude-code"), "claude-code");
  assert.equal(runtimeOf("Claude Code"), "claude-code");
  assert.equal(runtimeOf("some-agent"), "unknown");
  assert.equal(parseOtlpTraces({ resourceSpans: [{ scopeSpans: [{ spans: joinable }] }] }, NOW).spans[0].runtime, "unknown");
});

test("malformed bodies are rejected and malformed spans are dropped without throwing", () => {
  for (const body of ["not an object", null, [], 42, {}, { resourceSpans: {} }, { resourceSpans: "x" }]) {
    const result = parseOtlpTraces(body, NOW);
    assert.equal(result.ok, false, `expected a rejection for ${JSON.stringify(body)}`);
    assert.equal(result.status, 400);
    assert.equal(result.error.code, "bad_otlp");
  }
  const junk = {
    resourceSpans: [
      { resource: { attributes: "nope" }, scopeSpans: "nope" },
      { scopeSpans: [{ spans: "nope" }, { spans: [null, 42, "x", { name: "no-ids", attributes: [{ key: "turn_id", value: { stringValue: TURN } }] }] }] },
      { scopeSpans: [{ spans: [
        { traceId: TRACE, spanId: "cc00000000000001", attributes: { turn_id: TURN } },
        { traceId: TRACE, spanId: "cc00000000000002", name: "kept.anyway", attributes: [{ key: "call_id", value: { intValue: "4711" } }] },
        { traceId: TRACE, spanId: "cc00000000000003", name: "empty.key", attributes: [{ key: "turn_id", value: { stringValue: "" } }] },
      ] }] },
    ],
  };
  const result = parseOtlpTraces(junk, NOW);
  assert.equal(result.ok, true);
  assert.deepEqual(result.spans.map((s) => [s.name, s.callId, s.startMs]), [["kept.anyway", "4711", undefined]]);
  assert.equal(result.dropped, 6);
});

test("a store failure propagates to the caller instead of being swallowed", () => {
  const failing = { putSpans: () => { throw new Error("database is locked"); }, countIngest: () => {} };
  assert.throws(() => ingestOtlpTraces(SIX_SPANS, failing, NOW), /database is locked/);
  const counted = [];
  const store = { putSpans: () => 0, countIngest: (kind, code) => counted.push([kind, code]) };
  assert.equal(ingestOtlpTraces({ nope: true }, store, NOW).status, 400);
  assert.deepEqual(counted, [["rejected", "bad_otlp"]]);
});

const TRACES = "/ingest/otlp/v1/traces";

/**
 * Runs one case against its own daemon, so every test states the absolute row count it expects instead of inheriting
 * rows from the test before it. `settle` is the write barrier: the route answers 202 and stores the batch in a
 * microtask, which the daemon drains before it reads the next request off the socket, so awaiting one more response
 * is enough - nothing here sleeps or polls.
 */
async function withDaemon(run) {
  const s = await startTestServer();
  const get = (path) => http(s.port, { path, headers: bearer(s.token) });
  try {
    await run({
      port: s.port,
      token: s.token,
      get,
      post: (body, headers = jsonHeaders(s.token)) => http(s.port, { method: "POST", path: TRACES, headers, body: typeof body === "string" ? body : JSON.stringify(body) }),
      async settle() {
        const stats = await get("/api/stats");
        assert.equal(stats.status, 200);
        return stats.json.ingest;
      },
      spans() {
        const db = new DatabaseSync(join(s.gisoolHome, "gisool.db"));
        try {
          db.exec("PRAGMA busy_timeout = 5000");
          return spanRows(db);
        } finally {
          db.close();
        }
      },
    });
  } finally {
    await s.stop();
  }
}

test("POST /ingest/otlp/v1/traces needs the bearer token", () => withDaemon(async (d) => {
  const anon = await d.post(SIX_SPANS, { "Content-Type": "application/json" });
  assert.equal(anon.status, 401);
  assert.equal(anon.json.error, "unauthorized");
  const wrong = await d.post("{}", jsonHeaders("not-the-token"));
  assert.equal(wrong.status, 401);
  await d.settle();
  assert.deepEqual(d.spans(), []);
}));

test("the daemon answers 202 with partialSuccess and stores the joinable spans", () => withDaemon(async (d) => {
  const before = await d.settle();
  const res = await d.post(SIX_SPANS);
  assert.equal(res.status, 202);
  assert.deepEqual(res.json, { partialSuccess: {} });
  const after = await d.settle();
  const rows = d.spans();
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((r) => r.turn_key), [TURN, TURN, TURN]);
  assert.equal(after.accepted - before.accepted, 3);
  assert.equal(after.dropped - before.dropped, 3);
}));

test("protobuf and non-JSON trace exports are refused the same way as logs", () => withDaemon(async (d) => {
  const proto = await d.post(Buffer.from([10, 2, 3]), { ...bearer(d.token), "Content-Type": "application/x-protobuf" });
  assert.equal(proto.status, 415);
  assert.match(proto.json.hint, /http\/json/);
  assert.equal((await d.post("{not json")).status, 400);
  const before = await d.settle();
  assert.equal((await d.post({ resourceSpans: "nope" })).status, 202);
  const after = await d.settle();
  assert.equal(after.rejected - before.rejected, 1);
  assert.deepEqual(d.spans(), [], "a rejected batch stores nothing");
}));

test("a 2 MB batch of 5,000 filler spans plus 3 joinable ones is accepted and stores 3 rows", () => withDaemon(async (d) => {
  const filler = [];
  const pad = "codex_core::codex::handle_tool_call_with_source::".repeat(5);
  for (let i = 0; i < 5000; i += 1) {
    filler.push(span("fs.get_metadata", `f${String(i).padStart(15, "0")}`, { target: pad, "code.file.path": `/src/core/${pad}/${i}.rs`, "thread.name": "tokio-runtime-worker" }, { traceId: BIG_TRACE }));
  }
  const joinable = [
    span("codex.turn_input", "99f6aff0499f5a12", { "turn.id": TURN, "conversation.id": CONV }, { traceId: BIG_TRACE }),
    span("code_mode.handler.execute", "8926318135508e1f", { turn_id: TURN, call_id: CALL, "conversation.id": CONV }, { traceId: BIG_TRACE }),
    span("unified_exec.exec_command", "4a2e313888485b6f", { call_id: `${CALL}-2` }, { traceId: BIG_TRACE }),
  ];
  const body = JSON.stringify(batch([...filler.slice(0, 2500), ...joinable, ...filler.slice(2500)]));
  assert.ok(body.length >= 2 * 1024 * 1024 && body.length < 8 * 1024 * 1024, `body is ${body.length} bytes`);

  const before = await d.settle();
  const res = await d.post(body);
  assert.equal(res.status, 202);
  const after = await d.settle();
  const rows = d.spans();
  assert.deepEqual(rows.map((r) => r.name).sort(), ["code_mode.handler.execute", "codex.turn_input", "unified_exec.exec_command"]);
  assert.equal(rows.length, 3, "5,000 filler spans are dropped, not stored");
  assert.ok(rows.every((r) => r.trace_id === BIG_TRACE));
  assert.equal(rows.find((r) => r.name === "unified_exec.exec_command").turn_key, null);
  assert.equal(after.accepted - before.accepted, 3);
  assert.equal(after.dropped - before.dropped, 5000);
}));

test("a 9 MB trace export is refused with 413 and counted", () => withDaemon(async (d) => {
  const before = await d.settle();
  const big = JSON.stringify({ resourceSpans: [], pad: "x".repeat(9 * 1024 * 1024) });
  assert.equal((await d.post(big)).status, 413);
  const after = await d.settle();
  assert.equal(after.rejected - before.rejected, 1);
  assert.deepEqual(d.spans(), []);
}));
