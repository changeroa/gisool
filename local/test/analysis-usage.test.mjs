import assert from "node:assert/strict";
import test from "node:test";
import { distImport } from "./_helpers.mjs";
import { fixture } from "./helpers/ingest.mjs";
import { event, openStore, uri } from "./helpers/store.mjs";

const { sessionTree } = await distImport("analysis/tree.js");
const { aggregateUsage, flowUsage, rangeUsage, sessionUsage } = await distImport("analysis/usage.js");
const { createIngestDeps, ingest, ingestOtlp } = await distImport("ingest/pipeline.js");
const { ingestOtlpTraces } = await distImport("ingest/otlp-traces.js");
const { readFileEvent } = await distImport("ingest/mcp-recorder.js");

const T = 1760320000000;
const CODEX_TURN = "01a13990-4062-7fb3-bb7c-78e2a3435556";

function attr(record, key) {
  return record.attributes.find((a) => a.key === key).value;
}

function record(body) {
  return body.resourceLogs[0].scopeLogs[0].logRecords[0];
}

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
  return { db, store, ref, id, append };
}

test("Claude gisool calls count as skill tool calls while the Bash call is the follow-through", (t) => {
  // Given: one successful and one failed gisool search plus one successful Bash call, all in the reported turn.
  const { db, store } = openStore();
  t.after(() => store.close());
  const deps = createIngestDeps(store, { now: () => T + 10_000 });
  const failed = fixture("claude-otlp-tool-result-gisool-search.json");
  record(failed).timeUnixNano = "1760320005000000000";
  attr(record(failed), "success").stringValue = "false";
  attr(record(failed), "tool_use_id").stringValue = "toolu_mcp_3";
  attr(record(failed), "event.sequence").stringValue = "23";
  const bash = fixture("claude-otlp-tool-result-bash-two-skills.json");
  attr(record(bash), "tool_parameters").stringValue = JSON.stringify({ bash_command: "npm", full_command: "npm test --silent", timeout: 120_000 });
  attr(record(bash), "tool_input").stringValue = JSON.stringify({ command: "npm test --silent", description: "run the suite" });
  for (const body of [fixture("claude-otlp-user-prompt.json"), fixture("claude-otlp-skill-activated.json"), bash,
    fixture("claude-otlp-tool-result-gisool-search.json"), failed]) {
    assert.equal(ingestOtlp(body, deps).status, 200);
  }
  // When: the stored rows are read back through tree + usage analysis.
  assert.deepEqual(db.prepare("SELECT kind, count(*) AS n FROM events GROUP BY kind ORDER BY kind").all().map((r) => [r.kind, r.n]),
    [["native_skill", 1], ["prompt", 1], ["tool_call", 3]]);
  assert.equal(db.prepare("SELECT count(*) AS n FROM events WHERE kind = 'tool_call' AND json_extract(data_json, '$.gisoolMcp') = 1").get().n, 2);
  const id = db.prepare("SELECT id FROM sessions WHERE runtime_session_id = 'claude-sess-1'").get().id;
  const usage = sessionUsage(sessionTree(store, id));
  // Then: discovery calls are reported apart from the work the skill led to.
  assert.equal(usage.spans.length, 1);
  const span = usage.spans[0];
  assert.deepEqual([span.turnId, span.name, span.uri], ["p-1", "commit-helper", null]);
  assert.deepEqual([span.skillToolCalls, span.followThrough, span.toolFailures], [2, 1, 1]);
  assert.deepEqual(span.supportingReads, []);
  assert.deepEqual([span.llmCalls, span.costUsd, span.tokens], [0, null, []]);
  assert.deepEqual([span.activatedAt, span.durationMs], [T, 5000]);
  assert.deepEqual(span.attribution, { reported: 0, single: 3, coActive: 0, total: 3, coActiveShare: 0 });
});

test("a skill span with no tool call at the end of a turn reports zero follow-through and no correction", (t) => {
  // Given: the activation is the last event of the session, so nothing follows it.
  const { db, store } = openStore();
  t.after(() => store.close());
  const deps = createIngestDeps(store, { now: () => T + 10_000 });
  for (const name of ["claude-otlp-user-prompt.json", "claude-otlp-skill-activated.json"]) {
    assert.equal(ingestOtlp(fixture(name), deps).status, 200);
  }
  const id = db.prepare("SELECT id FROM sessions WHERE runtime_session_id = 'claude-sess-1'").get().id;
  // When
  const [span] = sessionUsage(sessionTree(store, id)).spans;
  // Then: "loaded, no action" is 0 follow-through, and unknowns stay null instead of collapsing to 0.
  assert.deepEqual([span.followThrough, span.skillToolCalls, span.toolFailures], [0, 0, 0]);
  assert.deepEqual([span.llmCalls, span.costUsd, span.costUnknownCalls], [0, null, 0]);
  assert.deepEqual(span.tokens, []);
  assert.equal(span.durationMs, 0);
  assert.equal(span.attribution.coActiveShare, null);
  assert.deepEqual(span.nextPromptCorrection, { status: "unknown", label: "heuristic", matched: [], reason: "no_next_prompt" });
});

test("a Codex span sums its reported tokens and leaves cost unknown", (t) => {
  // Given: Codex reports token buckets with cached tokens inside the input count and never reports a cost.
  const { db, store } = openStore();
  t.after(() => store.close());
  const deps = createIngestDeps(store, { now: () => T + 10_000 });
  assert.equal(ingestOtlp(fixture("codex-otlp-user-prompt.json"), deps).status, 200);
  assert.equal(ingestOtlpTraces(fixture("codex-otlp-traces.json"), store, T).kept, 3);
  for (const name of ["codex-otlp-skill-invocation.json", "codex-otlp-sse-event.json"]) {
    assert.equal(ingestOtlp(fixture(name), deps).status, 200);
  }
  const id = db.prepare("SELECT id FROM sessions WHERE conversation_id = 'codex-conv-1'").get().id;
  // When
  const [span] = sessionUsage(sessionTree(store, id)).spans;
  // Then: the fixture's own numbers, with the cache semantics kept on the bucket.
  assert.deepEqual([span.turnId, span.name], [CODEX_TURN, "db-query"]);
  assert.deepEqual(span.tokens, [{ inputIncludesCache: true, calls: 1, inputTokens: 19567, outputTokens: 5, cacheReadTokens: 13056,
    cacheCreationTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, totalTokens: 19572 }]);
  assert.deepEqual([span.llmCalls, span.costUsd, span.costUnknownCalls], [1, null, 1]);
});

test("one span over two runtimes keeps the cache semantics apart and the cost unknown", (t) => {
  // Given: a span whose model calls report both cache conventions, one of them without a cost.
  const { store, append, id } = seeded(t);
  append("prompt", 0, { turnKey: "t1", text: "Write the migration" });
  append("native_skill", 1000, { turnKey: "t1", data: { name: "db-query", via: "otel" } });
  append("llm_call", 2000, { turnKey: "t1", data: { model: "claude-fable-5-1", inputTokens: 2, outputTokens: 4,
    cacheReadTokens: 10_523, cacheCreationTokens: 15_814, inputIncludesCache: false, costUsd: 0.25 } });
  append("llm_call", 3000, { turnKey: "t1", data: { model: "gpt-6-astra", inputTokens: 19_567, outputTokens: 5,
    cacheReadTokens: 13_056, inputIncludesCache: true, totalTokens: 19_572 } });
  // When
  const [span] = sessionUsage(sessionTree(store, id)).spans;
  // Then: no bucket mixes the two conventions and the partially reported cost is null, not 0.25.
  assert.deepEqual(span.tokens, [
    { inputIncludesCache: false, calls: 1, inputTokens: 2, outputTokens: 4, cacheReadTokens: 10_523, cacheCreationTokens: 15_814,
      cacheWriteTokens: 0, reasoningTokens: 0, totalTokens: 0 },
    { inputIncludesCache: true, calls: 1, inputTokens: 19_567, outputTokens: 5, cacheReadTokens: 13_056, cacheCreationTokens: 0,
      cacheWriteTokens: 0, reasoningTokens: 0, totalTokens: 19_572 },
  ]);
  assert.deepEqual([span.llmCalls, span.costUsd, span.costUnknownCalls], [2, null, 1]);
});

for (const { prompt, status, matched } of [
  { prompt: "아니 다시 해줘", status: "correction", matched: ["아니", "다시"] },
  { prompt: "좋아 다음", status: "no_correction", matched: [] },
  { prompt: "No, revert that", status: "correction", matched: ["no,", "revert"] },
  { prompt: "run it against the baseline", status: "no_correction", matched: [] },
]) {
  test(`the next prompt "${prompt}" reads as ${status}`, (t) => {
    // Given: a skill span in the first turn and a captured prompt opening the second.
    const { store, append, id } = seeded(t);
    append("prompt", 0, { turnKey: "t1", text: "Write the migration" });
    append("native_skill", 1000, { turnKey: "t1", data: { name: "db-query", via: "otel" } });
    append("tool_call", 2000, { turnKey: "t1", data: { toolName: "Edit", success: true } });
    append("prompt", 3000, { turnKey: "t2", text: prompt });
    // When
    const [span] = sessionUsage(sessionTree(store, id)).spans;
    // Then: the word list decides, and the label stays heuristic either way.
    assert.deepEqual(span.nextPromptCorrection, { status, label: "heuristic", matched, reason: null });
  });
}

test("capture level metadata leaves the correction unknown instead of guessing", (t) => {
  // Given: the same two prompts ingested once with text captured and once with capture level metadata.
  const second = fixture("claude-otlp-user-prompt.json");
  record(second).timeUnixNano = "1760320006000000000";
  attr(record(second), "prompt.id").stringValue = "p-2";
  attr(record(second), "prompt").stringValue = "아니 다시 해줘";
  attr(record(second), "prompt_length").stringValue = "9";
  const usageFor = (captureLevel) => {
    const { db, store } = openStore();
    t.after(() => store.close());
    const deps = createIngestDeps(store, { captureLevel, now: () => T + 10_000 });
    for (const body of [fixture("claude-otlp-user-prompt.json"), fixture("claude-otlp-skill-activated.json"), second]) {
      assert.equal(ingestOtlp(body, deps).status, 200);
    }
    const id = db.prepare("SELECT id FROM sessions WHERE runtime_session_id = 'claude-sess-1'").get().id;
    assert.equal(db.prepare("SELECT count(*) AS n FROM events WHERE kind = 'prompt'").get().n, 2);
    return sessionUsage(sessionTree(store, id)).spans[0].nextPromptCorrection;
  };
  // When / Then: only the captured run can answer the question.
  assert.deepEqual(usageFor("full"), { status: "correction", label: "heuristic", matched: ["아니", "다시"], reason: null });
  assert.deepEqual(usageFor("metadata"), { status: "unknown", label: "heuristic", matched: [], reason: "text_not_captured" });
});

test("two skills active together share the same follow-through with a co-active share", (t) => {
  // Given: two loads before one tool call, which is what co_active attribution means.
  const { store, append, id } = seeded(t);
  append("prompt", 0, { turnKey: "t1", text: "Review the pull request" });
  append("load", 1000, { turnKey: "t1", skillUri: uri("pr-review-ko"), data: { uri: uri("pr-review-ko") } });
  append("load", 1500, { turnKey: "t1", skillUri: uri("debug-trace"), data: { uri: uri("debug-trace") } });
  append("tool_call", 2000, { turnKey: "t1", data: { toolName: "Edit", success: true } });
  // When
  const usage = sessionUsage(sessionTree(store, id));
  // Then: each span counts the shared call once, and the share says it was not alone.
  assert.deepEqual(usage.spans.map((s) => [s.uri, s.followThrough, s.attribution.coActive, s.attribution.coActiveShare]),
    [[uri("pr-review-ko"), 1, 1, 1], [uri("debug-trace"), 1, 1, 1]]);
});

test("supporting reads come from gisool read_file events and, for native skills, from tool argument paths", (t) => {
  const { store, id, ref } = seeded(t);
  const deps = createIngestDeps(store, { now: () => T + 10_000 });
  const append = (kind, offset, extra = {}) => {
    const e = event(kind, T + offset, ref, extra);
    assert.equal(store.append(e, { sessionId: id, method: "runtime_id" }), true);
  };
  // Given: an MCP-loaded skill reading one of its resources, and a native skill whose files are read with Bash.
  append("prompt", 0, { turnKey: "t1", text: "Summarize the PDF" });
  append("load", 1000, { turnKey: "t1", skillUri: uri("pdf-tools"), data: { uri: uri("pdf-tools") } });
  const ctx = { clientName: "claude-code", meta: { sessionId: "session" } };
  assert.ok(ingest(readFileEvent(ctx, { skillUri: uri("pdf-tools"), uri: `${uri("pdf-tools")}/reference.md`, bytes: 23 }, T + 1500), deps));
  append("native_skill", 2000, { turnKey: "t1", data: { name: "commit-helper", via: "file_read", path: "/Users/u/.claude/skills/commit-helper/SKILL.md" } });
  append("tool_call", 2500, { turnKey: "t1", text: JSON.stringify({ command: "cat /Users/u/.claude/skills/commit-helper/reference.md" }),
    data: { toolName: "Bash", success: true } });
  append("tool_call", 2600, { turnKey: "t1", text: JSON.stringify({ command: "cat /Users/u/projects/app/README.md" }),
    data: { toolName: "Bash", success: true } });
  // When
  const usage = sessionUsage(sessionTree(store, id));
  // Then: the MCP read is reported, the path match is labelled heuristic, and an unrelated path is neither.
  const pdf = usage.spans.find((s) => s.uri === uri("pdf-tools"));
  const commit = usage.spans.find((s) => s.name === "commit-helper");
  assert.deepEqual(pdf.supportingReads.map((r) => [r.kind, r.label, r.uri]), [["read_file", "reported", uri("pdf-tools")]]);
  assert.deepEqual(commit.supportingReads.map((r) => [r.kind, r.label]), [["tool_call", "heuristic"]]);
  assert.deepEqual([commit.followThrough, pdf.followThrough], [2, 2]);
});

test("a native skill's supporting reads stop at the directory boundary", (t) => {
  // Given: a sibling directory whose name starts with the skill's name, and a file nested inside the skill.
  const { store, append, id } = seeded(t);
  append("prompt", 0, { turnKey: "t1", text: "Implement the query" });
  append("native_skill", 1000, { turnKey: "t1", data: { name: "db-query", via: "file_read", path: "/skills/db-query/SKILL.md" } });
  append("tool_call", 2000, { turnKey: "t1", text: JSON.stringify({ command: "cat /skills/db-query-backup/reference.md" }),
    data: { toolName: "Bash", success: true } });
  const nested = append("tool_call", 3000, { turnKey: "t1", text: JSON.stringify({ command: "cat /skills/db-query/reference/deep.md" }),
    data: { toolName: "Bash", success: true } });
  // When
  const [span] = sessionUsage(sessionTree(store, id)).spans;
  // Then: only the nested file is a supporting read, while both calls remain follow-through.
  assert.deepEqual(span.supportingReads.map((r) => [r.eventId, r.label]), [[nested, "heuristic"]]);
  assert.equal(span.followThrough, 2);
});

test("range usage aggregates every eligible session and declares a shortened detail list", (t) => {
  // Given: 101 sessions in the range, one skill span and one tool call each.
  const { db, store } = openStore();
  t.after(() => store.close());
  for (let i = 0; i < 101; i += 1) {
    const ref = { runtime: "claude-code", runtimeSessionId: `range-${i}` };
    const sessionId = store.upsertSession(ref, T + i * 100);
    const add = (kind, delta, extra = {}) =>
      assert.equal(store.append(event(kind, T + i * 100 + delta, ref, extra), { sessionId, method: "runtime_id" }), true);
    add("prompt", 0, { turnKey: "t", text: "Implement the query" });
    add("load", 10, { turnKey: "t", skillUri: uri("database-query"), data: { uri: uri("database-query") } });
    add("tool_call", 20, { turnKey: "t", data: { toolName: "Bash", success: true } });
  }
  assert.equal(db.prepare("SELECT count(*) AS n FROM sessions").get().n, 101);
  // When
  const whole = rangeUsage(store, { from: T - 1, to: T + 101 * 100 });
  const capped = rangeUsage(store, { from: T - 1, to: T + 101 * 100, detailLimit: 10 });
  // Then: the aggregate covers all 101 either way, and a shortened detail list says so.
  assert.deepEqual([whole.sessionCount, whole.sessions.length, whole.truncated], [101, 101, false]);
  assert.deepEqual(whole.skills.map((s) => [s.skill, s.spans, s.followThrough]), [[uri("database-query"), 101, 101]]);
  assert.deepEqual([capped.sessionCount, capped.sessions.length, capped.truncated], [101, 10, true]);
  assert.deepEqual(capped.skills.map((s) => [s.spans, s.followThrough]), [[101, 101]]);
});

test("aggregates sum spans per skill and keep an unknown cost unknown", (t) => {
  // Given: the same skill active in two turns, one with a reported cost and one without.
  const { store, append, id } = seeded(t);
  append("prompt", 0, { turnKey: "t1", text: "Write the migration" });
  append("load", 1000, { turnKey: "t1", skillUri: uri("database-query"), data: { uri: uri("database-query") } });
  append("tool_call", 2000, { turnKey: "t1", data: { toolName: "Edit", success: true } });
  append("llm_call", 2500, { turnKey: "t1", data: { inputTokens: 10, outputTokens: 2, inputIncludesCache: false, costUsd: 0.5 } });
  append("prompt", 3000, { turnKey: "t2", text: "Now add the index" });
  append("load", 4000, { turnKey: "t2", skillUri: uri("database-query"), data: { uri: uri("database-query") } });
  append("tool_call", 5000, { turnKey: "t2", data: { toolName: "Bash", success: false } });
  append("llm_call", 5500, { turnKey: "t2", data: { inputTokens: 7, outputTokens: 3, inputIncludesCache: false } });
  // When
  const usage = sessionUsage(sessionTree(store, id));
  const [aggregate] = aggregateUsage(usage.spans);
  // Then: counts add up and the group cost stays null because one call reported none.
  assert.deepEqual([aggregate.skill, aggregate.spans, aggregate.spansWithoutFollowThrough], [uri("database-query"), 2, 0]);
  assert.deepEqual([aggregate.followThrough, aggregate.toolFailures, aggregate.llmCalls], [2, 1, 2]);
  assert.deepEqual([aggregate.costUsd, aggregate.costUnknownCalls], [null, 1]);
  assert.deepEqual(aggregate.tokens, [{ inputIncludesCache: false, calls: 2, inputTokens: 17, outputTokens: 5, cacheReadTokens: 0,
    cacheCreationTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, totalTokens: 0 }]);
  assert.deepEqual(aggregate.corrections, { correction: 0, no_correction: 1, unknown: 1 });
});

test("flow and range usage report the same spans for a herdr-linked session", (t) => {
  // Given: one session linked to a pane of a workspace.
  const { db, store, append, id } = seeded(t);
  append("prompt", 0, { turnKey: "t1", text: "Review the pull request" });
  append("load", 1000, { turnKey: "t1", skillUri: uri("pr-review-ko"), data: { uri: uri("pr-review-ko") } });
  append("tool_call", 2000, { turnKey: "t1", data: { toolName: "Edit", success: true } });
  db.prepare("INSERT INTO herdr_workspaces (id, label) VALUES (?, ?)").run("w", "workspace");
  db.prepare("INSERT INTO herdr_tabs (id, workspace_id, created_ms) VALUES (?, ?, ?)").run("tab", "w", T);
  db.prepare("INSERT INTO herdr_panes (id, workspace_id, tab_id, created_ms) VALUES (?, ?, ?, ?)").run("pane", "w", "tab", T);
  db.prepare("INSERT INTO pane_sessions (pane_id, agent_session_value, session_id, source, first_seen_ms) VALUES (?, ?, ?, ?, ?)")
    .run("pane", "session", id, "herdr:agent_session", T);
  // When
  const flow = flowUsage(store, "w");
  const range = rangeUsage(store, { from: T - 1, to: T + 100_000 });
  // Then: both entry points carry the span and its aggregate.
  assert.deepEqual(flow.sessions.map((s) => s.spans.map((span) => [span.uri, span.followThrough])), [[[uri("pr-review-ko"), 1]]]);
  assert.deepEqual(flow.skills.map((s) => [s.skill, s.spans, s.followThrough]), [[uri("pr-review-ko"), 1, 1]]);
  assert.deepEqual(range.sessions.map((s) => s.sessionId), [id]);
  assert.deepEqual([range.sessionCount, range.truncated], [1, false]);
  assert.deepEqual(range.skills.map((s) => s.skill), [uri("pr-review-ko")]);
  assert.equal(flowUsage(store, "does-not-exist"), undefined);
});
