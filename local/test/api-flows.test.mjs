import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { distImport } from "./_helpers.mjs";
import { bearer, http, startTestServer } from "./helpers/api.mjs";
import { DAY, NOW as T, uri } from "./helpers/store.mjs";

const { openDb } = await distImport("store/db.js");
const { createStore } = await distImport("store/index.js");

const SPEC = {
  name: "qa-flow",
  steps: [
    { id: "plan", skills: ["research-deep"], together: false, expectTools: [] },
    { id: "build", skills: ["docs-writer", "commit-helper"], together: true, expectTools: ["Edit"] },
  ],
};

const AUTOMATED_PROMPT = "Generate a concise, single-line task title for this conversation.";

let seq = 0;
const candidate = (name, rank) => ({ uri: uri(name), name, description: "", score: 10 - rank, rank, invocation: "automatic", digest: `sha256:${name}`, matched: [] });

/** Seeds the running daemon's database through a second connection: WAL lets both read and write the same file. */
function seedStore(gisoolHome) {
  let clock = T;
  const db = openDb(join(gisoolHome, "gisool.db"));
  const store = createStore(db, { now: () => clock });
  const ids = {};
  try {
    const session = (key, runtime, startedAt, events) => {
      const ref = { runtime, runtimeSessionId: key };
      const id = store.upsertSession(ref, startedAt);
      for (const { kind, ts, ...rest } of events) {
        seq += 1;
        store.append({ id: `ev-${seq}`, kind, ts, source: rest.source ?? "otel", data: {}, ...rest, ref }, { sessionId: id, method: "runtime_id" });
      }
      ids[key] = id;
      return id;
    };

    store.putLoad({ loadId: "load-plan", traceId: "trace-plan", uri: uri("research-deep"), manifestDigest: "sha256:manifest-research-deep", resources: [] });
    store.putLoad({ loadId: "load-auto", traceId: "trace-auto", uri: uri("commit-helper"), manifestDigest: "sha256:manifest-commit-helper", resources: [] });
    store.putLoad({ loadId: "load-loose", traceId: "trace-loose", uri: uri("aside-browser"), manifestDigest: "sha256:manifest-aside-browser", resources: [] });

    session("sess-plan", "claude-code", T - 120_000, [
      { kind: "prompt", ts: T - 119_000, text: "research the auth flow", textLength: 22, turnKey: "turn-plan", source: "hook" },
      { kind: "search", ts: T - 118_000, source: "mcp", traceId: "trace-plan",
        data: { query: "research the auth flow", mode: "discovery", candidates: [candidate("research-deep", 1), candidate("docs-writer", 2)], elapsedMs: 3, total: 2 } },
      { kind: "load", ts: T - 117_000, source: "mcp", traceId: "trace-plan", loadId: "load-plan", skillUri: uri("research-deep"),
        data: { uri: uri("research-deep"), manifestDigest: "sha256:manifest-research-deep" } },
      { kind: "tool_call", ts: T - 116_000, turnKey: "turn-plan", data: { toolName: "Edit", name: "Edit", success: true, durationMs: 12 } },
      { kind: "llm_call", ts: T - 115_000, turnKey: "turn-plan",
        data: { model: "claude-fable-5-1", inputTokens: 100, outputTokens: 20, cacheReadTokens: 5, inputIncludesCache: false, costUsd: 0.25 } },
    ]);
    session("sess-build", "codex", T - 100_000, [
      { kind: "prompt", ts: T - 99_000, text: "write the docs", textLength: 14, turnKey: "turn-build", source: "hook" },
      { kind: "native_skill", ts: T - 98_000, turnKey: "turn-build", data: { name: "docs-writer", via: "otel" } },
      { kind: "tool_call", ts: T - 97_000, turnKey: "turn-build", data: { toolName: "Edit", name: "Edit", success: true, durationMs: 8 } },
      { kind: "llm_call", ts: T - 96_000, turnKey: "turn-build",
        data: { model: "gpt-6", inputTokens: 500, outputTokens: 30, cacheReadTokens: 200, inputIncludesCache: true } },
    ]);
    session("sess-auto", "claude-code", T - 90_000, [
      { kind: "prompt", ts: T - 89_000, text: AUTOMATED_PROMPT, textLength: AUTOMATED_PROMPT.length, turnKey: "turn-auto", source: "hook" },
      { kind: "load", ts: T - 88_000, source: "mcp", traceId: "trace-auto", loadId: "load-auto", skillUri: uri("commit-helper"),
        data: { uri: uri("commit-helper"), manifestDigest: "sha256:manifest-commit-helper" } },
    ]);
    session("sess-loose", "claude-code", T - 80_000, [
      { kind: "prompt", ts: T - 79_000, text: "check the browser", textLength: 17, turnKey: "turn-loose", source: "hook" },
      { kind: "load", ts: T - 78_000, source: "mcp", traceId: "trace-loose", loadId: "load-loose", skillUri: uri("aside-browser"),
        data: { uri: uri("aside-browser"), manifestDigest: "sha256:manifest-aside-browser" } },
      { kind: "tool_call", ts: T - 77_000, turnKey: "turn-loose", data: { toolName: "Bash", name: "Bash", success: false, durationMs: 4 } },
    ]);

    const workspace = db.prepare("INSERT INTO herdr_workspaces (id, label, created_ms, closed_ms) VALUES (?, ?, ?, ?)");
    workspace.run("ws-qa", "QA workspace", T - 600_000, null);
    workspace.run("ws-loose", "Loose workspace", T - 60_000, null);
    const tab = db.prepare("INSERT INTO herdr_tabs (id, workspace_id, label, created_ms, closed_ms) VALUES (?, ?, ?, ?, ?)");
    tab.run("tab-qa", "ws-qa", "main", T - 600_000, null);
    tab.run("tab-loose", "ws-loose", "main", T - 60_000, null);
    const pane = db.prepare("INSERT INTO herdr_panes (id, workspace_id, tab_id, label, cwd, created_ms, closed_ms) VALUES (?, ?, ?, ?, ?, ?, ?)");
    pane.run("pane-plan", "ws-qa", "tab-qa", "plan", "/tmp/qa", T - 590_000, null);
    pane.run("pane-build", "ws-qa", "tab-qa", "build", "/tmp/qa", T - 580_000, null);
    pane.run("pane-loose", "ws-loose", "tab-loose", "loose", "/tmp/loose", T - 50_000, null);
    const link = db.prepare("INSERT INTO pane_sessions (pane_id, agent, source, agent_session_value, session_id, first_seen_ms, last_seen_ms) VALUES (?, ?, ?, ?, ?, ?, ?)");
    link.run("pane-plan", "claude", "herdr:reported", "sess-plan", ids["sess-plan"], T - 120_000, T - 115_000);
    link.run("pane-plan", "claude", "herdr:reported", "sess-unmatched", null, T - 110_000, T - 110_000);
    link.run("pane-build", "codex", "inferred:cwd_time", "sess-build", ids["sess-build"], T - 100_000, T - 96_000);
    link.run("pane-build", "claude", "herdr:reported", "sess-auto", ids["sess-auto"], T - 90_000, T - 88_000);
    link.run("pane-loose", "claude", "herdr:reported", "sess-loose", ids["sess-loose"], T - 80_000, T - 77_000);

    const { row: spec } = store.putWorkflowSpec(SPEC);
    clock = T - 300_000;
    const { flow } = store.createFlow({ workspaceId: "ws-qa", tabId: "tab-qa", specId: spec.id, label: "QA flow" });
    store.mapFlowStep(flow.id, "pane-plan", "plan");
    store.mapFlowStep(flow.id, "pane-build", "build");
    return { ids, specId: spec.id, flowId: flow.id };
  } finally {
    store.close();
  }
}

let s;
let fixture;
before(async () => {
  s = await startTestServer();
  fixture = seedStore(s.gisoolHome);
});
after(async () => { await s.stop(); });

const get = (path) => http(s.port, { path, headers: bearer(s.token) });
const RANGE = () => `from=${T - DAY}&to=${T + DAY}`;

test("the flows list pairs registered flows with the herdr workspaces that have none, newest first", async () => {
  const { ids, flowId, specId } = fixture;
  const res = await get("/api/flows");
  assert.equal(res.status, 200);
  assert.equal(typeof res.json.generatedAt, "number");
  assert.equal(res.json.automated, "exclude");
  assert.equal(res.json.limit, 20);
  assert.deepEqual([res.json.from, res.json.to, res.json.nextCursor], [null, null, null]);
  assert.deepEqual(res.json.flows.map((f) => f.id), ["ws:ws-loose", flowId]);

  assert.deepEqual(res.json.flows[0], {
    id: "ws:ws-loose", kind: "workspace", workspaceId: "ws-loose", tabId: null, label: "Loose workspace", registered: false,
    spec: null, startedMs: T - 60_000, endedMs: null, paneIds: ["pane-loose"], sessionIds: [ids["sess-loose"]],
    counts: { panes: 1, sessions: 1 }, attribution: { reported: 1, inferred: 0, unlinked: 0 },
  });
  assert.deepEqual(res.json.flows[1], {
    id: flowId, kind: "flow", workspaceId: "ws-qa", tabId: "tab-qa", label: "QA flow", registered: true,
    spec: { id: specId, name: "qa-flow", version: 1 }, startedMs: T - 300_000, endedMs: null,
    paneIds: ["pane-plan", "pane-build"], sessionIds: [ids["sess-plan"], ids["sess-build"]],
    counts: { panes: 2, sessions: 2 }, attribution: { reported: 1, inferred: 1, unlinked: 1 },
  });
});

test("the automated session is left out of the list unless automated=include or only asks for it", async () => {
  const { ids, flowId } = fixture;
  const included = await get("/api/flows?automated=include");
  assert.equal(included.json.automated, "include");
  const withAuto = included.json.flows.find((f) => f.id === flowId);
  assert.deepEqual(withAuto.sessionIds, [ids["sess-plan"], ids["sess-build"], ids["sess-auto"]]);
  assert.deepEqual(withAuto.counts, { panes: 2, sessions: 3 });
  assert.deepEqual(withAuto.attribution, { reported: 2, inferred: 1, unlinked: 1 });

  const only = await get("/api/flows?automated=only");
  const automatedOnly = only.json.flows.find((f) => f.id === flowId);
  assert.deepEqual(automatedOnly.sessionIds, [ids["sess-auto"]]);
  assert.deepEqual(automatedOnly.counts, { panes: 2, sessions: 1 });
  assert.deepEqual(only.json.flows.find((f) => f.id === "ws:ws-loose").sessionIds, []);
});

test("the list pages by cursor and refuses a limit, range or cursor it did not issue", async () => {
  const { flowId } = fixture;
  const first = await get("/api/flows?limit=1");
  assert.deepEqual(first.json.flows.map((f) => f.id), ["ws:ws-loose"]);
  assert.equal(typeof first.json.nextCursor, "string");

  const second = await get(`/api/flows?limit=1&cursor=${encodeURIComponent(first.json.nextCursor)}`);
  assert.deepEqual(second.json.flows.map((f) => f.id), [flowId]);
  assert.equal(second.json.nextCursor, null);

  const ranged = await get(`/api/flows?from=${T - 200_000}`);
  assert.deepEqual(ranged.json.flows.map((f) => f.id), ["ws:ws-loose"]);
  assert.equal(ranged.json.from, T - 200_000);

  for (const [query, error] of [
    ["limit=101", "bad_filter"],
    ["limit=0", "bad_filter"],
    ["limit=abc", "bad_filter"],
    ["limit=1.5", "bad_filter"],
    ["from=2&to=1", "bad_filter"],
    ["from=1&from=2", "bad_filter"],
    ["automated=yes", "bad_filter"],
    ["cursor=zzz", "bad_cursor"],
    [`cursor=${Buffer.from("no-colon-here", "utf8").toString("base64url")}`, "bad_cursor"],
    [`cursor=${Buffer.from("nan:id", "utf8").toString("base64url")}`, "bad_cursor"],
  ]) {
    const res = await get(`/api/flows?${query}`);
    assert.equal(res.status, 400, `${query}: ${res.text}`);
    assert.equal(res.json.error, error, query);
  }
});

test("a flow report joins tree, finding, usage and spec comparison for the sessions it shows", async () => {
  const { ids, flowId, specId } = fixture;
  const res = await get(`/api/flows/${flowId}`);
  assert.equal(res.status, 200);
  assert.equal(typeof res.json.generatedAt, "number");
  assert.deepEqual(
    { id: res.json.id, kind: res.json.kind, workspaceId: res.json.workspaceId, label: res.json.label, registered: res.json.registered, automated: res.json.automated },
    { id: flowId, kind: "flow", workspaceId: "ws-qa", label: "QA flow", registered: true, automated: "exclude" },
  );
  assert.deepEqual(res.json.flow, { registeredMs: T - 300_000, endedMs: null, tabId: "tab-qa" });
  assert.deepEqual(res.json.spec, { id: specId, name: "qa-flow", version: 1 });

  const panes = res.json.tree.tabs[0].panes;
  assert.deepEqual(res.json.tree.tabs.map((tab) => tab.id), ["tab-qa"]);
  assert.deepEqual(panes.map((p) => p.id), ["pane-plan", "pane-build"]);
  assert.deepEqual(panes[0].sessions.map((link) => [link.sessionId, link.basis]), [[ids["sess-plan"], "reported"], [null, "reported"]]);
  assert.deepEqual(panes[1].sessions.map((link) => [link.sessionId, link.basis]), [[ids["sess-build"], "inferred"]]);
  assert.deepEqual(res.json.excludedSessions, [{ sessionId: ids["sess-auto"], reason: "codex_title" }]);
  assert.deepEqual(panes[0].sessions[0].session.turns.map((turn) => [turn.id, turn.basis]), [["turn-plan", "reported"]]);

  const finding = Object.fromEntries(res.json.finding.sessions.map((row) => [row.sessionId, row]));
  const planTurn = finding[ids["sess-plan"]].turns[0];
  assert.equal(planTurn.label, "found_top1");
  assert.deepEqual(planTurn.usedSkills, [{ uri: uri("research-deep"), name: "research-deep", via: "load", ts: T - 117_000, rankInSearch: 1 }]);
  assert.equal("loadedSkills" in planTurn, false, "the DTO reports used skills under usedSkills only");
  assert.deepEqual(planTurn.candidates.map((c) => [c.uri, c.rank]), [[uri("research-deep"), 1], [uri("docs-writer"), 2]]);
  const buildTurn = finding[ids["sess-build"]].turns[0];
  assert.equal(buildTurn.label, "native_without_search");
  assert.deepEqual(buildTurn.usedSkills.map((skill) => [skill.name, skill.via, skill.rankInSearch]), [["docs-writer", "native", null]]);
  assert.deepEqual(res.json.finding.aggregate, {
    turns: 2, labels: { found_top1: 1, found_lower: 0, loaded_outside_results: 0, native_without_search: 1, searched_none_used: 0, no_search: 0 },
    meanRank: 1, abstainedSearches: 0, abstainedTurns: 0,
  });

  assert.deepEqual(res.json.usage.skills.map((skill) => skill.skill), ["docs-writer", uri("research-deep")]);
  const [docs, research] = res.json.usage.skills;
  assert.deepEqual(
    { spans: research.spans, followThrough: research.followThrough, toolFailures: research.toolFailures, llmCalls: research.llmCalls, costUsd: research.costUsd },
    { spans: 1, followThrough: 1, toolFailures: 0, llmCalls: 1, costUsd: 0.25 },
  );
  assert.deepEqual(research.tokens, [{ inputIncludesCache: false, calls: 1, inputTokens: 100, outputTokens: 20, cacheReadTokens: 5, cacheCreationTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, totalTokens: 0 }]);
  assert.deepEqual(
    { followThrough: docs.followThrough, llmCalls: docs.llmCalls, costUsd: docs.costUsd, costUnknownCalls: docs.costUnknownCalls },
    { followThrough: 1, llmCalls: 1, costUsd: null, costUnknownCalls: 1 },
    "Codex reports no cost, so the cost stays unknown instead of counting as 0",
  );

  assert.deepEqual(res.json.comparison.steps.map((step) => [step.stepId, step.status]), [["plan", "matched"], ["build", "partial"]]);
  assert.deepEqual(res.json.comparison.steps[1].usedSkills, ["docs-writer"]);
  assert.deepEqual(res.json.comparison.steps[1].missingSkills, ["commit-helper"]);
  assert.deepEqual(res.json.comparison.unplanned, []);
});

test("automated=include adds the hidden session to the report and to the comparison", async () => {
  const { ids, flowId } = fixture;
  const res = await get(`/api/flows/${flowId}?automated=include`);
  assert.equal(res.json.automated, "include");
  assert.deepEqual(res.json.excludedSessions, []);
  assert.deepEqual(res.json.finding.sessions.map((row) => row.sessionId).sort(),
    [ids["sess-plan"], ids["sess-build"], ids["sess-auto"]].sort());
  assert.deepEqual(res.json.comparison.steps.map((step) => step.status), ["matched", "matched"]);
  assert.deepEqual(res.json.comparison.steps[1].usedSkills, ["commit-helper", "docs-writer"]);
  assert.deepEqual(res.json.usage.skills.map((skill) => skill.skill), ["docs-writer", uri("commit-helper"), uri("research-deep")]);
});

test("a herdr workspace with no registered flow is addressable as ws:<workspaceId>", async () => {
  const { ids } = fixture;
  const res = await get("/api/flows/ws:ws-loose");
  assert.equal(res.status, 200);
  assert.deepEqual(
    { id: res.json.id, kind: res.json.kind, registered: res.json.registered, spec: res.json.spec, flow: res.json.flow, comparison: res.json.comparison },
    { id: "ws:ws-loose", kind: "workspace", registered: false, spec: null, flow: null, comparison: null },
  );
  assert.deepEqual(res.json.tree.tabs[0].panes.map((pane) => pane.id), ["pane-loose"]);
  assert.deepEqual(res.json.usage.sessions.map((row) => row.sessionId), [ids["sess-loose"]]);
  const [loose] = res.json.usage.skills;
  assert.deepEqual(
    { skill: loose.skill, followThrough: loose.followThrough, toolFailures: loose.toolFailures, llmCalls: loose.llmCalls, costUsd: loose.costUsd },
    { skill: uri("aside-browser"), followThrough: 1, toolFailures: 1, llmCalls: 0, costUsd: null },
  );
  assert.equal(res.json.finding.sessions[0].turns[0].label, "loaded_outside_results");

  assert.equal((await get("/api/flows/ws-loose")).json.id, "ws:ws-loose", "a bare workspace id resolves too");
  assert.equal((await get("/api/flows/does-not-exist")).status, 404);
  assert.equal((await get("/api/flows/ws:nope")).json.error, "flow_not_found");
});

test("a session skill report carries its finding, usage and automation state", async () => {
  const { ids } = fixture;
  const res = await get(`/api/sessions/${ids["sess-plan"]}/skill-report`);
  assert.equal(res.status, 200);
  assert.deepEqual(
    { sessionId: res.json.sessionId, runtime: res.json.runtime, startedAt: res.json.startedAt, endedAt: res.json.endedAt, automated: res.json.automated },
    { sessionId: ids["sess-plan"], runtime: "claude-code", startedAt: T - 120_000, endedAt: null, automated: null },
  );
  assert.deepEqual(res.json.tree.turns.map((turn) => turn.events.length), [5]);
  assert.deepEqual(res.json.tree.turns[0].events.map((e) => [e.kind, e.basis]), [
    ["prompt", "reported"], ["search", "inferred_time"], ["load", "inferred_time"], ["tool_call", "reported"], ["llm_call", "reported"],
  ]);
  assert.equal(res.json.finding.turns[0].label, "found_top1");
  assert.deepEqual(res.json.usage.spans.map((span) => [span.name, span.followThrough, span.costUsd]), [["research-deep", 1, 0.25]]);
  assert.equal(res.json.usage.spans[0].nextPromptCorrection.status, "unknown");
  assert.equal(res.json.usage.spans[0].nextPromptCorrection.reason, "no_next_prompt");

  const hidden = await get(`/api/sessions/${ids["sess-auto"]}/skill-report`);
  assert.equal(hidden.status, 404);
  assert.equal(hidden.json.error, "automated_excluded");
  assert.equal(hidden.json.automated, "codex_title");

  const shown = await get(`/api/sessions/${ids["sess-auto"]}/skill-report?automated=include`);
  assert.equal(shown.status, 200);
  assert.equal(shown.json.automated, "codex_title");
  assert.equal((await get(`/api/sessions/${ids["sess-plan"]}/skill-report?automated=only`)).status, 404);
  assert.equal((await get("/api/sessions/nope/skill-report")).json.error, "session_not_found");
  assert.equal((await get(`/api/sessions/${ids["sess-plan"]}/skill-report?automated=maybe`)).status, 400);
});

test("skill usage aggregates a bounded range and keeps an unreported cost null", async () => {
  const res = await get(`/api/skills/usage?${RANGE()}`);
  assert.equal(res.status, 200);
  assert.deepEqual(
    { from: res.json.from, to: res.json.to, automated: res.json.automated, detailLimit: res.json.detailLimit, sessionCount: res.json.sessionCount, truncated: res.json.truncated },
    { from: T - DAY, to: T + DAY, automated: "exclude", detailLimit: 20, sessionCount: 3, truncated: false },
  );
  assert.deepEqual(res.json.skills.map((skill) => skill.skill), ["docs-writer", uri("aside-browser"), uri("research-deep")]);
  assert.deepEqual(res.json.skills.map((skill) => skill.costUsd), [null, null, 0.25]);
  assert.deepEqual(res.json.skills.map((skill) => skill.spansWithoutFollowThrough), [0, 0, 0]);

  const included = await get(`/api/skills/usage?${RANGE()}&automated=include`);
  assert.equal(included.json.sessionCount, 4);
  const only = await get(`/api/skills/usage?${RANGE()}&automated=only`);
  assert.equal(only.json.sessionCount, 1);
  assert.deepEqual(only.json.skills.map((skill) => [skill.skill, skill.spans, skill.followThrough]), [[uri("commit-helper"), 1, 0]]);

  const bounded = await get(`/api/skills/usage?${RANGE()}&detail=0`);
  assert.deepEqual(bounded.json.sessions, []);
  assert.equal(bounded.json.truncated, true);
  assert.equal(bounded.json.sessionCount, 3);

  for (const query of [`from=${T}&to=${T - 1}`, `from=0&to=${T}`, `${RANGE()}&detail=200`, `${RANGE()}&detail=-1`]) {
    const res400 = await get(`/api/skills/usage?${query}`);
    assert.equal(res400.status, 400, `${query}: ${res400.text}`);
    assert.equal(res400.json.error, "bad_filter", query);
  }
});

test("the read APIs take the same bearer auth as the other /api routes", async () => {
  const { ids, flowId } = fixture;
  for (const path of ["/api/flows", `/api/flows/${flowId}`, `/api/sessions/${ids["sess-plan"]}/skill-report`, "/api/skills/usage"]) {
    const res = await http(s.port, { path });
    assert.equal(res.status, 401, path);
    assert.equal(res.json.error, "unauthorized", path);
  }
});
