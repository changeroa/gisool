import assert from "node:assert/strict";
import test from "node:test";
import { distImport } from "./_helpers.mjs";
import { event, openStore, uri } from "./helpers/store.mjs";

const { aggregateFindings, analyzeSession, flowFinding, sessionFinding } = await distImport("analysis/finding.js");
const { sessionTree } = await distImport("analysis/tree.js");

const T = 1760320000000;
const NO_LABELS = { found_top1: 0, found_lower: 0, loaded_outside_results: 0, native_without_search: 0, searched_none_used: 0, no_search: 0 };

function appender(store, id, ref) {
  return (kind, offset, extra = {}) => {
    const e = event(kind, T + offset, ref, extra);
    assert.equal(store.append(e, { sessionId: id, method: "runtime_id" }), true);
    return e.id;
  };
}

function seeded(t, runtime = "claude-code", key = "session") {
  const { db, store } = openStore();
  t.after(() => store.close());
  const ref = { runtime, runtimeSessionId: key };
  const id = store.upsertSession(ref, T);
  return { db, store, ref, id, append: appender(store, id, ref) };
}

const candidate = (name, rank, { rootId = "agents", digest = `sha256:${name}` } = {}) => ({
  uri: `skill://local/${rootId}/${name}/SKILL.md`, name, description: `${name} skill`, score: 10 - rank, rank,
  invocation: "automatic", digest, matched: [],
});
const searchData = (query, candidates, extra = {}) => ({ query, mode: "discovery", candidates, elapsedMs: 3, total: candidates.length, ...extra });
const load = (name, offset) => ["load", offset, { traceId: "tr", loadId: `load-${name}-${offset}`, skillUri: uri(name),
  data: { uri: uri(name), manifestDigest: `sha256:manifest-${name}` } }];
const native = (name, offset) => ["native_skill", offset, { data: { name, via: "otel" } }];

/** Seeds one Claude turn (prompt p1 carries the reported turn key) and returns its finding. */
function oneTurn(t, seed) {
  const ctx = seeded(t);
  ctx.append("prompt", 0, { turnKey: "p1", text: "help me" });
  seed(ctx);
  const finding = sessionFinding(ctx.store, ctx.id);
  return { ...ctx, finding, turn: finding.turns[0] };
}

test("a turn that loads the top hit reads found_top1 with its query, candidates and rank", (t) => {
  // Given: one search whose first candidate is the skill the turn then loads.
  const { turn } = oneTurn(t, ({ append }) => {
    append("search", 1000, { traceId: "tr", data: searchData("database query", [candidate("database-query", 1), candidate("docs-writer", 2)]) });
    append(...load("database-query", 2000));
  });
  // Then: every field names a seeded value.
  assert.equal(turn.label, "found_top1");
  assert.equal(turn.searched, true);
  assert.deepEqual(turn.queries, ["database query"]);
  assert.deepEqual(turn.candidates, [
    { uri: uri("database-query"), name: "database-query", rank: 1, rawRank: 1, copies: 1 },
    { uri: uri("docs-writer"), name: "docs-writer", rank: 2, rawRank: 2, copies: 1 },
  ]);
  assert.deepEqual(turn.loadedSkills, [{ uri: uri("database-query"), name: "database-query", via: "load", ts: T + 2000, rankInSearch: 1 }]);
  assert.equal(turn.abstained, null);
  assert.equal(turn.nativeWithoutSearch, false);
  assert.deepEqual(turn.missedLater, []);
});

test("a turn that loads a lower candidate reads found_lower with that rank", (t) => {
  // Given
  const { turn } = oneTurn(t, ({ append }) => {
    append("search", 1000, { traceId: "tr", data: searchData("docs", [candidate("database-query", 1), candidate("docs-writer", 2)]) });
    append(...load("docs-writer", 2000));
  });
  // Then
  assert.equal(turn.label, "found_lower");
  assert.deepEqual(turn.loadedSkills.map((s) => s.rankInSearch), [2]);
});

test("identical copies share one rank, so the distinct skill behind them is rank 2", (t) => {
  // Given: two copies with the same SKILL.md digest at reported ranks 1 and 2, a distinct skill at reported rank 3.
  const { turn } = oneTurn(t, ({ append }) => {
    append("search", 1000, { traceId: "tr", data: searchData("debug the release", [
      candidate("debugging", 1, { digest: "sha256:same-body" }),
      candidate("debugging", 2, { rootId: "team", digest: "sha256:same-body" }),
      candidate("release-plan", 3),
    ]) });
    append(...load("release-plan", 2000));
  });
  // Then
  assert.deepEqual(turn.candidates, [
    { uri: "skill://local/agents/debugging/SKILL.md", name: "debugging", rank: 1, rawRank: 1, copies: 2 },
    { uri: "skill://local/team/debugging/SKILL.md", name: "debugging", rank: 1, rawRank: 2, copies: 2 },
    { uri: uri("release-plan"), name: "release-plan", rank: 2, rawRank: 3, copies: 1 },
  ]);
  assert.deepEqual(turn.loadedSkills.map((s) => s.rankInSearch), [2]);
  assert.equal(turn.label, "found_lower");
});

test("loading the second identical copy still reads the collapsed rank 1", (t) => {
  // Given: the copy reported at rank 2 is the one the turn loads.
  const ctx = seeded(t);
  ctx.append("prompt", 0, { turnKey: "p1" });
  ctx.append("search", 1000, { traceId: "tr", data: searchData("debug", [
    candidate("debugging", 1, { digest: "sha256:same-body" }),
    candidate("debugging", 2, { rootId: "team", digest: "sha256:same-body" }),
  ]) });
  ctx.append("load", 2000, { traceId: "tr", loadId: "copy", skillUri: "skill://local/team/debugging/SKILL.md",
    data: { uri: "skill://local/team/debugging/SKILL.md", manifestDigest: "sha256:manifest-copy" } });
  // When
  const turn = sessionFinding(ctx.store, ctx.id).turns[0];
  // Then
  assert.deepEqual(turn.loadedSkills.map((s) => [s.uri, s.rankInSearch]), [["skill://local/team/debugging/SKILL.md", 1]]);
  assert.equal(turn.label, "found_top1");
});

test("a load that no candidate matches reads loaded_outside_results with rank null", (t) => {
  // Given
  const { turn } = oneTurn(t, ({ append }) => {
    append("search", 1000, { traceId: "tr", data: searchData("database", [candidate("database-query", 1)]) });
    append(...load("commit-helper", 2000));
  });
  // Then
  assert.equal(turn.label, "loaded_outside_results");
  assert.deepEqual(turn.loadedSkills, [{ uri: uri("commit-helper"), name: "commit-helper", via: "load", ts: T + 2000, rankInSearch: null }]);
});

test("a native skill used with no earlier search reads native_without_search", (t) => {
  // Given
  const { turn } = oneTurn(t, ({ append }) => {
    append(...native("debugging", 1000));
    append("tool_call", 2000, { data: { toolName: "Bash", success: true } });
  });
  // Then
  assert.equal(turn.label, "native_without_search");
  assert.equal(turn.nativeWithoutSearch, true);
  assert.equal(turn.searched, false);
  assert.deepEqual(turn.loadedSkills, [{ uri: null, name: "debugging", via: "native", ts: T + 1000, rankInSearch: null }]);
});

test("a search whose candidates stay unused reads searched_none_used", (t) => {
  // Given
  const { turn } = oneTurn(t, ({ append }) => {
    append("search", 1000, { traceId: "tr", data: searchData("database", [candidate("database-query", 1)]) });
    append("tool_call", 2000, { data: { toolName: "Bash", success: true } });
  });
  // Then
  assert.equal(turn.label, "searched_none_used");
  assert.deepEqual(turn.loadedSkills, []);
  assert.deepEqual(turn.missedLater, []);
});

test("a turn with no search and no skill reads no_search", (t) => {
  // Given
  const { turn } = oneTurn(t, ({ append }) => {
    append("tool_call", 1000, { data: { toolName: "Bash", success: true } });
  });
  // Then
  assert.deepEqual([turn.label, turn.searched, turn.queries.length], ["no_search", false, 0]);
});

test("the latest search before a load decides its rank", (t) => {
  // Given: two searches in one turn rank the loaded skill 1 and then 2.
  const { turn } = oneTurn(t, ({ append }) => {
    append("search", 1000, { traceId: "tr1", data: searchData("database", [candidate("database-query", 1)]) });
    append("search", 2000, { traceId: "tr2", data: searchData("docs database", [candidate("docs-writer", 1), candidate("database-query", 2)]) });
    append(...load("database-query", 3000));
  });
  // Then
  assert.deepEqual(turn.queries, ["database", "docs database"]);
  assert.deepEqual(turn.loadedSkills.map((s) => s.rankInSearch), [2]);
  assert.equal(turn.label, "found_lower");
  assert.deepEqual(turn.candidates.map((c) => [c.name, c.rank]), [["docs-writer", 1], ["database-query", 2]]);
});

test("a load before the turn's only search has no rank", (t) => {
  // Given
  const { turn } = oneTurn(t, ({ append }) => {
    append(...load("database-query", 1000));
    append("search", 2000, { traceId: "tr", data: searchData("database", [candidate("database-query", 1)]) });
  });
  // Then
  assert.deepEqual([turn.label, turn.searched, turn.loadedSkills[0].rankInSearch], ["loaded_outside_results", true, null]);
});

test("an abstained search keeps its reason and the native use after it is not native_without_search", (t) => {
  // Given
  const { turn } = oneTurn(t, ({ append }) => {
    append("search", 1000, { traceId: "tr", data: searchData("커밋 메시지 정리해줘", [], { abstained: { reason: "no_overlap", hint: "rephrase" } }) });
    append(...native("commit-helper", 2000));
  });
  // Then
  assert.deepEqual(turn.abstained, { reason: "no_overlap", hint: "rephrase" });
  assert.deepEqual(turn.candidates, []);
  assert.equal(turn.nativeWithoutSearch, false);
  assert.equal(turn.label, "loaded_outside_results");
});

test("a skill used in a later turn that this turn's search did not surface is reported as missedLater", (t) => {
  // Given: turn p1 searches, p2 loads a skill the search never returned, p3 uses a skill it did return.
  const ctx = seeded(t);
  ctx.append("prompt", 0, { turnKey: "p1" });
  ctx.append("search", 1000, { traceId: "tr", data: searchData("database", [candidate("database-query", 1)]) });
  ctx.append("prompt", 2000, { turnKey: "p2" });
  ctx.append(...load("release-plan", 3000));
  ctx.append("prompt", 4000, { turnKey: "p3" });
  ctx.append(...native("database-query", 5000));
  // When
  const { turns } = sessionFinding(ctx.store, ctx.id);
  // Then
  assert.deepEqual(turns.map((turn) => turn.label), ["searched_none_used", "loaded_outside_results", "native_without_search"]);
  assert.deepEqual(turns[0].missedLater, [{ uri: uri("release-plan"), name: "release-plan", via: "load", turnId: "p2", ts: T + 3000 }]);
  assert.deepEqual(turns[1].missedLater, []);
  assert.deepEqual(turns[2].missedLater, []);
});

test("session aggregates count labels, average the ranks of used skills and count abstentions", (t) => {
  // Given: found_top1, found_lower and an abstained turn in one session.
  const ctx = seeded(t);
  ctx.append("prompt", 0, { turnKey: "p1" });
  ctx.append("search", 1000, { traceId: "tr1", data: searchData("database", [candidate("database-query", 1), candidate("docs-writer", 2)]) });
  ctx.append(...load("database-query", 2000));
  ctx.append("prompt", 3000, { turnKey: "p2" });
  ctx.append("search", 4000, { traceId: "tr2", data: searchData("docs database", [candidate("docs-writer", 1), candidate("database-query", 2)]) });
  ctx.append(...load("database-query", 5000));
  ctx.append("prompt", 6000, { turnKey: "p3" });
  ctx.append("search", 7000, { traceId: "tr3", data: searchData("날씨", [], { abstained: { reason: "no_overlap", hint: "rephrase" } }) });
  // When
  const finding = sessionFinding(ctx.store, ctx.id);
  // Then
  assert.deepEqual(finding.turns.map((turn) => turn.label), ["found_top1", "found_lower", "searched_none_used"]);
  assert.deepEqual(finding.aggregate, { turns: 3, labels: { ...NO_LABELS, found_top1: 1, found_lower: 1, searched_none_used: 1 },
    meanRank: 1.5, abstentions: 1 });
  assert.equal(finding.sessionId, ctx.id);
  assert.deepEqual(aggregateFindings([]), { turns: 0, labels: NO_LABELS, meanRank: null, abstentions: 0 });
});

test("a finding is recomputed from the store rather than returning the earlier state", (t) => {
  // Given: a searched turn with nothing loaded yet.
  const ctx = seeded(t);
  ctx.append("prompt", 0, { turnKey: "p1" });
  ctx.append("search", 1000, { traceId: "tr", data: searchData("database", [candidate("database-query", 1)]) });
  const before = sessionFinding(ctx.store, ctx.id);
  // When: the load arrives afterwards.
  ctx.append(...load("database-query", 2000));
  const after = sessionFinding(ctx.store, ctx.id);
  // Then
  assert.deepEqual([before.turns[0].label, before.aggregate.meanRank], ["searched_none_used", null]);
  assert.deepEqual([after.turns[0].label, after.aggregate.meanRank], ["found_top1", 1]);
});

test("flow findings cover every linked session and missing ids return undefined", (t) => {
  // Given: one workspace with two panes, each linked to a session.
  const { db, store, id, append } = seeded(t);
  append("prompt", 0, { turnKey: "p1" });
  append("search", 1000, { traceId: "tr", data: searchData("database", [candidate("database-query", 1)]) });
  append(...load("database-query", 2000));
  const other = store.upsertSession({ runtime: "codex", conversationId: "second" }, T + 3000);
  const appendOther = appender(store, other, { runtime: "codex", conversationId: "second" });
  appendOther("prompt", 3000);
  appendOther("tool_call", 4000, { data: { toolName: "Bash", success: true } });
  db.prepare("INSERT INTO herdr_workspaces (id, label) VALUES (?, ?)").run("w", "workspace");
  db.prepare("INSERT INTO herdr_tabs (id, workspace_id, created_ms) VALUES (?, ?, ?)").run("tab", "w", T);
  const pane = db.prepare("INSERT INTO herdr_panes (id, workspace_id, tab_id, created_ms) VALUES (?, ?, ?, ?)");
  pane.run("a", "w", "tab", T);
  pane.run("b", "w", "tab", T + 1);
  const link = db.prepare("INSERT INTO pane_sessions (pane_id, agent_session_value, session_id, source, first_seen_ms) VALUES (?, ?, ?, ?, ?)");
  link.run("a", "first", id, "herdr:report", T);
  link.run("b", "second", other, "inferred:cwd_time", T + 3000);
  // When
  const flow = flowFinding(store, "w");
  // Then
  assert.deepEqual(flow.sessions.map((s) => [s.sessionId, s.turns.map((turn) => turn.label)]), [[id, ["found_top1"]], [other, ["no_search"]]]);
  assert.deepEqual(flow.aggregate, { turns: 2, labels: { ...NO_LABELS, found_top1: 1, no_search: 1 }, meanRank: 1, abstentions: 0 });
  assert.equal(flowFinding(store, "does-not-exist"), undefined);
  assert.equal(sessionFinding(store, "does-not-exist"), undefined);
});

test("session analysis does not mutate the tree it reads", (t) => {
  // Given
  const ctx = seeded(t);
  ctx.append("prompt", 0, { turnKey: "p1" });
  ctx.append("search", 1000, { traceId: "tr", data: searchData("database", [candidate("database-query", 1)]) });
  ctx.append(...load("database-query", 2000));
  const tree = sessionTree(ctx.store, ctx.id);
  const before = structuredClone(tree);
  // When
  const finding = analyzeSession(tree);
  // Then
  assert.deepEqual(tree, before);
  assert.equal(finding.turns[0].label, "found_top1");
});
