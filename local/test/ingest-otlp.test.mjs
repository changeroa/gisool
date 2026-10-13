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
  assert.deepEqual(e.ref, { runtime: "claude-code", runtimeSessionId: "claude-sess-1" });
  assert.equal(e.data.name, "commit-helper");
  assert.equal(e.data.via, "otel");
  assert.equal(e.data.trigger, "claude-proactive");
});

test("tool_result Read of .../db-query/SKILL.md -> native_skill file_read named db-query", () => {
  const { events } = parse("claude-otlp-tool-result-skill-read.json");
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, "native_skill");
  assert.equal(events[0].data.via, "file_read");
  assert.equal(events[0].data.name, "db-query");
  assert.equal(events[0].toolUseId, "toolu_read_1");
  assert.deepEqual(events[0].ref, { runtime: "claude-code", runtimeSessionId: "claude-sess-1" });
});

test("tool_result Read of a non-SKILL.md file produces nothing", () => {
  const result = parse("claude-otlp-tool-result-other-read.json");
  assert.deepEqual(result.events, []);
  assert.equal(result.unknown, 0);
});

test("tool_result Bash whose command touches SKILL.md -> native_skill file_read", () => {
  const { events } = parse("claude-otlp-tool-result-bash-skill.json");
  assert.equal(events.length, 1);
  assert.equal(events[0].data.name, "pdf-tools");
  assert.equal(events[0].data.via, "file_read");
});

test("tool_result for the gisool MCP server is ignored (MCP recorder covers it)", () => {
  const result = parse("claude-otlp-tool-result-gisool-mcp.json");
  assert.deepEqual(result.events, []);
  assert.equal(result.ignored, 1);
  assert.equal(result.unknown, 0);
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

test("codex.skill_invocation -> native_skill with scope and invocation type", () => {
  const [e] = parse("codex-otlp-skill-invocation.json").events;
  assert.equal(e.kind, "native_skill");
  assert.deepEqual(e.ref, { runtime: "codex", conversationId: "codex-conv-1" });
  assert.deepEqual([e.data.name, e.data.via, e.data.scope, e.data.invocationType], ["db-query", "otel", "user", "implicit"]);
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
