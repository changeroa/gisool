import assert from "node:assert/strict";
import { test } from "node:test";
import { distImport } from "./_helpers.mjs";
import { fixture } from "./helpers/ingest.mjs";

const { parseOtlpLogs } = await distImport("ingest/otlp.js");
const NOW = 1_800_000_000_000;

function parse(name) {
  const result = parseOtlpLogs(fixture(name), NOW);
  assert.equal(result.ok, true);
  assert.deepEqual(result.response, { partialSuccess: {} });
  return result;
}

test("claude_code.user_prompt -> prompt with session.id, prompt.id, text, and record timestamp", () => {
  const { events } = parse("claude-otlp-user-prompt.json");
  assert.equal(events.length, 1);
  const [e] = events;
  assert.equal(e.kind, "prompt");
  assert.equal(e.source, "otel");
  assert.deepEqual(e.ref, { runtime: "claude-code", runtimeSessionId: "claude-sess-1" });
  assert.equal(e.text, "Write a commit message please");
  assert.equal(e.data.promptId, "p-1");
  assert.equal(e.turnKey, "p-1");
  assert.equal(e.ts, 1_760_320_000_000);
});

test("redacted Claude prompt yields a prompt event without text", () => {
  const body = fixture("claude-otlp-user-prompt.json");
  const attrs = body.resourceLogs[0].scopeLogs[0].logRecords[0].attributes;
  attrs.find((a) => a.key === "prompt").value = { stringValue: "<REDACTED>" };
  const { events } = parseOtlpLogs(body, NOW);
  assert.equal(events[0].text, undefined);
  assert.equal(events[0].data.promptUnavailable, true);
  assert.equal(events[0].data.promptLength, 27);
});

test("claude_code.skill_activated -> native_skill via otel", () => {
  const [e] = parse("claude-otlp-skill-activated.json").events;
  assert.equal(e.kind, "native_skill");
  assert.equal(e.turnKey, "p-1");
  assert.deepEqual(e.ref, { runtime: "claude-code", runtimeSessionId: "claude-sess-1" });
  assert.equal(e.data.name, "commit-helper");
  assert.equal(e.data.via, "otel");
  assert.equal(e.data.trigger, "claude-proactive");
});

test("tool_result Read of .../db-query/SKILL.md -> tool_call plus native_skill file_read named db-query", () => {
  const { events } = parse("claude-otlp-tool-result-skill-read.json");
  assert.deepEqual(events.map((e) => e.kind), ["tool_call", "native_skill"]);
  const [call, skill] = events;
  assert.equal(call.data.toolName, "Read");
  assert.equal(call.data.success, true);
  assert.equal(call.data.durationMs, 4);
  assert.equal(call.text, '{"file_path":"/x/.agents/skills/db-query/SKILL.md"}');
  assert.equal(skill.data.via, "file_read");
  assert.equal(skill.data.name, "db-query");
  assert.equal(skill.toolUseId, "toolu_read_1");
  assert.deepEqual(skill.ref, { runtime: "claude-code", runtimeSessionId: "claude-sess-1" });
});

test("tool_result Read of a non-SKILL.md file yields the tool_call and no skill event", () => {
  const result = parse("claude-otlp-tool-result-other-read.json");
  assert.deepEqual(result.events.map((e) => e.kind), ["tool_call"]);
  assert.equal(result.unknown, 0);
});

test("tool_result Bash whose command touches SKILL.md -> tool_call plus native_skill file_read", () => {
  const { events } = parse("claude-otlp-tool-result-bash-skill.json");
  assert.deepEqual(events.map((e) => e.kind), ["tool_call", "native_skill"]);
  assert.equal(events[0].data.toolName, "Bash");
  assert.equal(events[1].data.name, "pdf-tools");
  assert.equal(events[1].data.via, "file_read");
});

test("tool_result for the gisool MCP server -> one tool_call marked gisoolMcp and no skill reads", () => {
  for (const name of ["claude-otlp-tool-result-gisool-mcp.json", "claude-otlp-tool-result-gisool-search.json"]) {
    const result = parse(name);
    assert.deepEqual(result.events.map((e) => e.kind), ["tool_call"], name);
    assert.equal(result.events[0].data.gisoolMcp, true, name);
    assert.equal(result.ignored, 0, name);
    assert.equal(result.unknown, 0, name);
  }
});

test("claude_code.api_request -> llm_call with tokens, cost and latency from all three AnyValue shapes", () => {
  const { events } = parse("claude-otlp-api-request.json");
  assert.equal(events.length, 1);
  const [e] = events;
  assert.equal(e.kind, "llm_call");
  assert.deepEqual(e.ref, { runtime: "claude-code", runtimeSessionId: "claude-sess-1" });
  assert.equal(e.turnKey, "p-1");
  assert.deepEqual(e.data, {
    model: "claude-fable-5-1", inputTokens: 2, outputTokens: 4, cacheReadTokens: 10523, cacheCreationTokens: 15814,
    inputIncludesCache: false, costUsd: 0.31913075, durationMs: 2292, ttftMs: 2276, requestId: "req_011CXplaceholder",
  });
});

test("codex.sse_event response.completed -> llm_call; any other SSE kind is ignored", () => {
  const { events } = parse("codex-otlp-sse-event.json");
  assert.equal(events.length, 1);
  assert.deepEqual(events[0].ref, { runtime: "codex", conversationId: "codex-conv-1" });
  assert.deepEqual(events[0].data, {
    model: "gpt-6-astra", inputTokens: 19567, outputTokens: 5, cacheReadTokens: 13056, cacheWriteTokens: 0,
    reasoningTokens: 0, totalTokens: 19572, inputIncludesCache: true, ttftMs: 2828,
  });
  const body = fixture("codex-otlp-sse-event.json");
  body.resourceLogs[0].scopeLogs[0].logRecords[0].attributes.find((a) => a.key === "event.kind").value = { stringValue: "response.output_text.delta" };
  const other = parseOtlpLogs(body, NOW);
  assert.deepEqual(other.events, []);
  assert.equal(other.ignored, 1);
  assert.equal(other.unknown, 0);
});

test("codex.tool_result -> tool_call with call id, arguments text and the log's span context", () => {
  const { events } = parse("codex-otlp-tool-result.json");
  assert.equal(events.length, 1);
  const [e] = events;
  assert.equal(e.kind, "tool_call");
  assert.equal(e.callId, "call_abc123");
  assert.equal(e.spanId, "038c89db542b7dbc");
  assert.equal(e.data.otelTraceId, "cd36e249feea84bd9f32aa5425613249");
  assert.equal(e.text, '{"command":["bash","-lc","ls"],"workdir":"/tmp/work"}');
  assert.equal(e.data.toolName, "exec_command");
  assert.equal(e.data.success, true);
  assert.equal(e.data.durationMs, 43);
});

test("known but unneeded event names are ignored, never counted as unknown", () => {
  const claude = parse("claude-otlp-ignored-events.json");
  assert.deepEqual(claude.events, []);
  assert.equal(claude.ignored, 6);
  assert.equal(claude.unknown, 0);
  const codex = parse("codex-otlp-ignored-events.json");
  assert.deepEqual(codex.events, []);
  assert.equal(codex.ignored, 5);
  assert.equal(codex.unknown, 0);
});

test("source_key is stable across a replay and distinct per derived event of one record", () => {
  const first = parse("claude-otlp-tool-result-bash-two-skills.json").events;
  const again = parse("claude-otlp-tool-result-bash-two-skills.json").events;
  assert.deepEqual(first.map((e) => e.kind), ["tool_call", "native_skill", "native_skill"]);
  assert.deepEqual(first.map((e) => e.sourceKey), again.map((e) => e.sourceKey));
  assert.equal(new Set(first.map((e) => e.sourceKey)).size, 3);
  assert.ok(first.every((e) => /^[0-9a-f]{64}$/.test(e.sourceKey)));
  const other = parse("claude-otlp-tool-result-skill-read.json").events;
  assert.equal(new Set([...first, ...other].map((e) => e.sourceKey)).size, 5);
});

test("unparseable numbers and missing attributes never produce NaN or a crash", () => {
  const body = fixture("claude-otlp-api-request.json");
  const attrs = body.resourceLogs[0].scopeLogs[0].logRecords[0].attributes;
  attrs.find((a) => a.key === "input_tokens").value = { intValue: "not-a-number" };
  attrs.find((a) => a.key === "cost_usd").value = { stringValue: "" };
  attrs.find((a) => a.key === "ttft_ms").value = { boolValue: true };
  const { events } = parseOtlpLogs(body, NOW);
  assert.equal(events.length, 1);
  assert.equal(events[0].data.inputTokens, undefined);
  assert.equal(events[0].data.costUsd, undefined);
  assert.equal(events[0].data.ttftMs, undefined);
  assert.equal(events[0].data.outputTokens, 4);

  const bare = { resourceLogs: [{ resource: { attributes: [{ key: "service.name", value: { stringValue: "claude-code" } }] }, scopeLogs: [{ logRecords: [
    { attributes: [{ key: "event.name", value: { stringValue: "tool_result" } }] },
  ] }] }] };
  const minimal = parseOtlpLogs(bare, NOW);
  assert.equal(minimal.events.length, 1);
  assert.equal(minimal.events[0].kind, "tool_call");
  assert.equal(minimal.events[0].data.toolName, "unknown");
  assert.equal(minimal.events[0].data.success, undefined);
  assert.equal(minimal.events[0].text, undefined);
  assert.equal(minimal.events[0].ts, NOW);
});

test("unknown events are counted and dropped", () => {
  const result = parse("claude-otlp-unknown-event.json");
  assert.deepEqual(result.events, []);
  assert.equal(result.unknown, 1);
});

test("codex.user_prompt -> prompt keyed by conversation.id", () => {
  const [e] = parse("codex-otlp-user-prompt.json").events;
  assert.equal(e.kind, "prompt");
  assert.deepEqual(e.ref, { runtime: "codex", conversationId: "codex-conv-1" });
  assert.equal(e.text, "로그인 버그 고쳐줘 please");
});

test("codex.skill_invocation -> native_skill with scope, invocation type and the turn key", () => {
  const [e] = parse("codex-otlp-skill-invocation.json").events;
  assert.equal(e.kind, "native_skill");
  assert.deepEqual(e.ref, { runtime: "codex", conversationId: "codex-conv-1" });
  assert.deepEqual([e.data.name, e.data.via, e.data.scope, e.data.invocationType], ["db-query", "otel", "user", "implicit"]);
  assert.equal(e.turnKey, "01a13990-4062-7fb3-bb7c-78e2a3435556");
});

test("codex.conversation_starts -> session_start", () => {
  const [e] = parse("codex-otlp-conversation-starts.json").events;
  assert.equal(e.kind, "session_start");
  assert.deepEqual(e.ref, { runtime: "codex", conversationId: "codex-conv-1" });
});

test("bare event.name without body falls back to the service hint", () => {
  const body = { resourceLogs: [{ resource: { attributes: [{ key: "service.name", value: { stringValue: "claude-code" } }] }, scopeLogs: [{ logRecords: [{ attributes: [
    { key: "event.name", value: { stringValue: "user_prompt" } }, { key: "session.id", value: { stringValue: "s9" } }, { key: "prompt", value: { stringValue: "hi" } },
  ] }] }] }] };
  const result = parseOtlpLogs(body, NOW);
  assert.equal(result.events[0].kind, "prompt");
  assert.equal(result.events[0].ts, NOW);
  assert.equal(result.events[0].ref.runtimeSessionId, "s9");
});

test("malformed OTLP -> bad_otlp 400", () => {
  for (const body of [{}, null, [], "x", { resourceLogs: {} }]) {
    const result = parseOtlpLogs(body, NOW);
    assert.equal(result.ok, false);
    assert.equal(result.status, 400);
    assert.equal(result.error.code, "bad_otlp");
  }
});
