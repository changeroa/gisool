import assert from "node:assert/strict";
import { test } from "node:test";
import { distImport } from "./_helpers.mjs";
import { fixture } from "./helpers/ingest.mjs";
import { openStore } from "./helpers/store.mjs";

const { createIngestDeps, ingestOtlp } = await distImport("ingest/pipeline.js");

function ingested(names, opts = {}) {
  const { db, store } = openStore();
  const deps = createIngestDeps(store, opts);
  for (const name of names) assert.equal(ingestOtlp(fixture(name), deps).status, 200, name);
  return { db, store, deps };
}

function rows(db, where = "1 = 1") {
  return db.prepare(`SELECT * FROM events WHERE ${where} ORDER BY ts, rowid`).all();
}

const dataOf = (row) => JSON.parse(row.data_json);
const attrOf = (name, key) => fixture(name).resourceLogs[0].scopeLogs[0].logRecords[0].attributes.find((a) => a.key === key).value.stringValue;

test("Claude api_request is stored as an llm_call with its model, token buckets, cost, latency and turn key", () => {
  const { db } = ingested(["claude-otlp-api-request.json"]);
  const all = rows(db);
  assert.equal(all.length, 1);
  const [row] = all;
  assert.equal(row.kind, "llm_call");
  assert.equal(row.runtime, "claude-code");
  assert.equal(row.source, "otel");
  assert.notEqual(row.session_id, "unattributed");
  assert.equal(row.turn_key, "p-1");
  assert.deepEqual(dataOf(row), {
    model: "claude-fable-5-1", inputTokens: 2, outputTokens: 4, cacheReadTokens: 10523, cacheCreationTokens: 15814,
    inputIncludesCache: false, costUsd: 0.31913075, durationMs: 2292, ttftMs: 2276, requestId: "req_011CXplaceholder",
  });
});

test("a Claude tool_result stores the tool run and the skill read it contains", () => {
  const { db } = ingested(["claude-otlp-tool-result-skill-read.json"]);
  const all = rows(db);
  assert.deepEqual(all.map((r) => r.kind), ["tool_call", "native_skill"]);
  const [call, skill] = all;
  assert.equal(call.turn_key, null, "this capture carries no prompt.id");
  assert.equal(call.tool_use_id, "toolu_read_1");
  assert.equal(call.text, '{"file_path":"/x/.agents/skills/db-query/SKILL.md"}');
  assert.deepEqual(dataOf(call), { toolName: "Read", success: true, durationMs: 4, toolUseId: "toolu_read_1" });
  assert.equal(dataOf(skill).name, "db-query");
  assert.equal(dataOf(skill).via, "file_read");
  assert.equal(skill.session_id, call.session_id);
});

test("a Bash tool_result reading two SKILL.md files stores 1 tool_call + 2 skill events, and replaying the batch stores nothing new", () => {
  const name = "claude-otlp-tool-result-bash-two-skills.json";
  const { db, store, deps } = ingested([name]);
  const all = rows(db);
  assert.deepEqual(all.map((r) => r.kind), ["tool_call", "native_skill", "native_skill"]);
  assert.deepEqual(all.filter((r) => r.kind === "native_skill").map((r) => dataOf(r).name), ["pdf-tools", "db-query"]);
  assert.equal(new Set(all.map((r) => r.source_key)).size, 3);
  assert.deepEqual(dataOf(all[0]), { toolName: "Bash", success: true, durationMs: 100, toolUseId: "toolu_bash_2", inputBytes: 142, resultBytes: 4096 });
  assert.equal(all.every((r) => r.turn_key === "p-1"), true);
  assert.equal(store.stats().ingest.accepted, 3);

  assert.equal(ingestOtlp(fixture(name), deps).status, 200, "a retried OTLP batch is still accepted");
  assert.equal(ingestOtlp(fixture(name), createIngestDeps(store)).status, 200, "and after a daemon restart too");
  assert.equal(rows(db).length, 3);
  assert.equal(store.stats().ingest.accepted, 3);
});

test("Codex sse_event, tool_result and skill_invocation keep usage, the call id and the turn key", () => {
  const { db } = ingested(["codex-otlp-sse-event.json", "codex-otlp-tool-result.json", "codex-otlp-skill-invocation.json"]);
  const [llm] = rows(db, "kind = 'llm_call'");
  assert.equal(llm.runtime, "codex");
  assert.deepEqual(dataOf(llm), {
    model: "gpt-6-astra", inputTokens: 19567, outputTokens: 5, cacheReadTokens: 13056, cacheWriteTokens: 0,
    reasoningTokens: 0, totalTokens: 19572, inputIncludesCache: true, ttftMs: 2828,
  });

  const [call] = rows(db, "kind = 'tool_call'");
  assert.equal(call.call_id, "call_abc123");
  assert.equal(call.span_id, "038c89db542b7dbc");
  assert.equal(call.text, '{"command":["bash","-lc","ls"],"workdir":"/tmp/work"}');
  assert.deepEqual(dataOf(call), { toolName: "exec_command", success: true, durationMs: 43, otelTraceId: "cd36e249feea84bd9f32aa5425613249" });

  const [skill] = rows(db, "kind = 'native_skill'");
  assert.equal(skill.turn_key, "01a13990-4062-7fb3-bb7c-78e2a3435556");
  assert.equal(dataOf(skill).name, "db-query");
  assert.equal(new Set(rows(db).map((r) => r.session_id)).size, 1, "all three join the same Codex conversation");
});

test("trace() describes model calls and tool runs instead of labelling them a session end", () => {
  const { db, store } = ingested(["claude-otlp-user-prompt.json", "claude-otlp-api-request.json", "claude-otlp-tool-result-skill-read.json"]);
  const { id } = db.prepare("SELECT id FROM sessions").get();
  const steps = store.trace(id);
  assert.deepEqual(steps.map((s) => s.kind), ["prompt", "tool_call", "native_skill", "llm_call"]);
  const llm = steps.find((s) => s.kind === "llm_call");
  assert.equal(llm.detail.kind, "llm_call");
  assert.equal(llm.detail.model, "claude-fable-5-1");
  assert.equal(llm.detail.costUsd, 0.31913075);
  const tokens = llm.detail.inputTokens + llm.detail.outputTokens + llm.detail.cacheReadTokens + llm.detail.cacheCreationTokens;
  assert.equal(tokens, 26343);
  assert.ok(llm.summary.includes(llm.detail.model) && llm.summary.includes(String(tokens)), llm.summary);
  const call = steps.find((s) => s.kind === "tool_call");
  assert.deepEqual([call.detail.kind, call.detail.toolUseId, call.detail.args], ["tool_call", "toolu_read_1", '{"file_path":"/x/.agents/skills/db-query/SKILL.md"}']);
  assert.ok(call.summary.includes(call.detail.toolName) && call.summary.includes(String(call.detail.durationMs)), call.summary);
  // The kind-only fallback branch would describe a step by its kind alone, which is how model calls and tool runs used to render.
  assert.ok(steps.every((s) => Object.keys(s.detail).length > 1), "no step fell through to the kind-only branch");
});

test("trace() reports a Codex tool run with its own duration and a failed run as failed", () => {
  const body = fixture("codex-otlp-tool-result.json");
  const { db, store } = openStore();
  const deps = createIngestDeps(store);
  assert.equal(ingestOtlp(body, deps).status, 200);
  const failed = fixture("codex-otlp-tool-result.json");
  const record = failed.resourceLogs[0].scopeLogs[0].logRecords[0];
  record.attributes.find((a) => a.key === "success").value = { boolValue: false };
  record.attributes.find((a) => a.key === "call_id").value = { stringValue: "call_def456" };
  assert.equal(ingestOtlp(failed, deps).status, 200);
  const { id } = db.prepare("SELECT id FROM sessions").get();
  const [okCall, failedCall] = store.trace(id);
  assert.deepEqual([okCall.detail.success, failedCall.detail.success], [true, false]);
  assert.equal(okCall.detail.toolName, failedCall.detail.toolName);
  assert.equal(okCall.detail.durationMs, 43);
  assert.ok(okCall.summary.includes(okCall.detail.toolName) && okCall.summary.includes(String(okCall.detail.durationMs)), okCall.summary);
  assert.notEqual(okCall.summary, failedCall.summary, "a failed run must not read like a successful one");
});

test("capture level metadata keeps tool arguments out of the store while full capture keeps them", () => {
  const name = "claude-otlp-tool-result-bash-two-skills.json";
  const args = attrOf(name, "tool_input");
  const metadata = ingested([name], { captureLevel: "metadata" });
  const [hidden] = rows(metadata.db, "kind = 'tool_call'");
  assert.equal(hidden.text, null);
  assert.equal(hidden.text_length, args.length);
  assert.match(hidden.text_digest, /^[0-9a-f]{64}$/);
  assert.equal(rows(metadata.db).length, 3, "skill events are still derived from arguments that are not stored");

  const full = ingested([name]);
  assert.equal(rows(full.db, "kind = 'tool_call'")[0].text, args);
});

test("sessions() ignores model calls and tool runs, and ingest.dropped only counts events gisool did not understand", () => {
  const { db, store } = ingested(["claude-otlp-user-prompt.json", "claude-otlp-api-request.json", "claude-otlp-tool-result-bash-two-skills.json",
    "claude-otlp-ignored-events.json", "codex-otlp-ignored-events.json"]);
  const listed = store.sessions({});
  assert.equal(listed.length, 1);
  assert.equal(listed[0].firstPrompt, "Write a commit message please");
  assert.equal(listed[0].state, "not_used");
  assert.equal(rows(db).length, 5);
  assert.equal(store.stats().ingest.dropped, 0);

  const { store: other } = ingested(["claude-otlp-unknown-event.json"]);
  assert.equal(other.stats().ingest.dropped, 1);
});

test("a session that only ever reported model calls and tool runs stays out of the default session list", () => {
  const { db, store } = ingested(["claude-otlp-api-request.json", "claude-otlp-tool-result-other-read.json"]);
  assert.equal(rows(db).length, 2);
  assert.deepEqual(store.sessions({}), []);
  assert.equal(store.sessions({ automated: "include" }).length, 1);
});
