import assert from "node:assert/strict";
import { join } from "node:path";
import test, { after, before } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { PACKAGE_ROOT, distImport } from "./_helpers.mjs";
import { bearer, http, startTestServer } from "./helpers/api.mjs";
import { DAY, NOW as T, uri } from "./helpers/store.mjs";

// The Workspaces view is fed by the real read APIs, so the fixture is a seeded daemon rather than a hand-written DTO:
// what the view's helpers are asserted against is exactly what the browser receives.

async function loadModule(relative) {
  const result = await build({
    entryPoints: [fileURLToPath(new URL(relative, PACKAGE_ROOT))],
    bundle: true, write: false, format: "esm", platform: "node", target: "es2022",
    jsx: "automatic", jsxImportSource: "preact", logLevel: "silent",
  });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
}

const workspaces = await loadModule("dashboard/views/workspaces.tsx");
const calls = await loadModule("dashboard/components/calls.tsx");
const factsMod = await loadModule("dashboard/components/facts.tsx");
const trace = await loadModule("dashboard/views/trace.tsx");
const state = await loadModule("dashboard/state.ts");

const { openDb } = await distImport("store/db.js");
const { createStore } = await distImport("store/index.js");

const AUTOMATED_PROMPT = "Generate a concise, single-line task title for this conversation.";
const SPEC = {
  name: "qa-flow",
  steps: [
    { id: "plan", skills: ["research-deep"], together: false, expectTools: [] },
    { id: "build", skills: ["docs-writer", "commit-helper"], together: true, expectTools: [] },
  ],
};

let seq = 0;
const candidate = (name, rank) => ({ uri: uri(name), name, description: "", score: 10 - rank, rank, invocation: "automatic", digest: `sha256:${name}`, matched: [] });

/** One registered flow over two panes: a Claude session that searched and loaded, a Codex session that went native. */
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
        store.append({ id: `ws-ev-${seq}`, kind, ts, source: rest.source ?? "otel", data: {}, ...rest, ref }, { sessionId: id, method: "runtime_id" });
      }
      ids[key] = id;
      return id;
    };

    store.putLoad({ loadId: "ws-load-plan", traceId: "ws-trace-plan", uri: uri("research-deep"), manifestDigest: "sha256:manifest-research-deep", resources: [] });

    session("ws-plan", "claude-code", T - 120_000, [
      { kind: "session_start", ts: T - 120_000, source: "hook" },
      { kind: "prompt", ts: T - 119_000, text: "research the auth flow", textLength: 22, turnKey: "ws-turn-plan", source: "hook" },
      { kind: "search", ts: T - 118_000, source: "mcp", traceId: "ws-trace-plan", turnKey: "ws-turn-plan",
        data: { query: "research the auth flow", mode: "discovery", candidates: [candidate("research-deep", 1), candidate("docs-writer", 2)], elapsedMs: 3, total: 2 } },
      { kind: "load", ts: T - 117_000, source: "mcp", traceId: "ws-trace-plan", loadId: "ws-load-plan", skillUri: uri("research-deep"), turnKey: "ws-turn-plan",
        data: { uri: uri("research-deep"), manifestDigest: "sha256:manifest-research-deep" } },
      { kind: "tool_call", ts: T - 116_000, turnKey: "ws-turn-plan", data: { toolName: "Edit", name: "Edit", success: true, durationMs: 12 } },
      { kind: "tool_call", ts: T - 115_500, turnKey: "ws-turn-plan", data: { toolName: "Bash", name: "Bash", success: false, durationMs: 4 } },
      { kind: "llm_call", ts: T - 115_000, turnKey: "ws-turn-plan",
        data: { model: "claude-fable-5-1", inputTokens: 100, outputTokens: 20, cacheReadTokens: 5, inputIncludesCache: false, costUsd: 0.25, durationMs: 900 } },
    ]);
    session("ws-build", "codex", T - 100_000, [
      { kind: "prompt", ts: T - 99_000, text: "write the docs", textLength: 14, turnKey: "ws-turn-build", source: "hook" },
      { kind: "native_skill", ts: T - 98_000, turnKey: "ws-turn-build", data: { name: "docs-writer", via: "otel" } },
      { kind: "tool_call", ts: T - 97_000, turnKey: "ws-turn-build", data: { toolName: "Edit", name: "Edit", success: true, durationMs: 8 } },
      { kind: "llm_call", ts: T - 96_000, turnKey: "ws-turn-build", data: { model: "gpt-6", inputTokens: 500, outputTokens: 30, cacheReadTokens: 200, inputIncludesCache: true } },
    ]);
    session("ws-auto", "claude-code", T - 90_000, [
      { kind: "prompt", ts: T - 89_000, text: AUTOMATED_PROMPT, textLength: AUTOMATED_PROMPT.length, turnKey: "ws-turn-auto", source: "hook" },
      { kind: "native_skill", ts: T - 88_000, turnKey: "ws-turn-auto", data: { name: "commit-helper", via: "otel" } },
    ]);

    const workspace = db.prepare("INSERT INTO herdr_workspaces (id, label, created_ms, closed_ms) VALUES (?, ?, ?, ?)");
    workspace.run("ws-main", "Auth work", T - 600_000, null);
    workspace.run("ws-solo", null, T - 60_000, null);
    db.prepare("INSERT INTO herdr_tabs (id, workspace_id, label, created_ms, closed_ms) VALUES (?, ?, ?, ?, ?)").run("tab-main", "ws-main", "main", T - 600_000, null);
    const pane = db.prepare("INSERT INTO herdr_panes (id, workspace_id, tab_id, label, cwd, created_ms, closed_ms) VALUES (?, ?, ?, ?, ?, ?, ?)");
    pane.run("pane-plan", "ws-main", "tab-main", "plan", "/tmp/ws", T - 590_000, null);
    pane.run("pane-build", "ws-main", "tab-main", "build", "/tmp/ws", T - 580_000, null);
    const link = db.prepare("INSERT INTO pane_sessions (pane_id, agent, source, agent_session_value, session_id, first_seen_ms, last_seen_ms) VALUES (?, ?, ?, ?, ?, ?, ?)");
    link.run("pane-plan", "claude", "herdr:reported", "ws-plan", ids["ws-plan"], T - 120_000, T - 115_000);
    link.run("pane-plan", "claude", "herdr:reported", "ws-never-matched", null, T - 110_000, T - 110_000);
    link.run("pane-build", "codex", "inferred:cwd_time", "ws-build", ids["ws-build"], T - 100_000, T - 96_000);
    link.run("pane-build", "claude", "herdr:reported", "ws-auto", ids["ws-auto"], T - 90_000, T - 88_000);

    const { row: spec } = store.putWorkflowSpec(SPEC);
    clock = T - 300_000;
    const { flow } = store.createFlow({ workspaceId: "ws-main", tabId: "tab-main", specId: spec.id, label: "Auth flow" });
    store.mapFlowStep(flow.id, "pane-plan", "plan");
    store.mapFlowStep(flow.id, "pane-build", "build");
    return { ids, flowId: flow.id, specId: spec.id };
  } finally {
    store.close();
  }
}

let server;
let fixture;
let list;
let report;
let sessionReport;
let sessionSteps;

before(async () => {
  server = await startTestServer();
  fixture = seedStore(server.gisoolHome);
  const get = (path) => http(server.port, { path, headers: bearer(server.token) });
  list = (await get(`/api/flows?from=${T - DAY}&to=${T + DAY}`)).json;
  report = (await get(`/api/flows/${fixture.flowId}`)).json;
  sessionReport = (await get(`/api/sessions/${fixture.ids["ws-plan"]}/skill-report`)).json;
  sessionSteps = (await get(`/api/sessions/${fixture.ids["ws-plan"]}/trace`)).json;
});
after(async () => { await server.stop(); });

test("a list row carries the flow's structure as keyed values, and an unlabelled workspace falls back to its id", () => {
  const entry = list.flows.find((flow) => flow.id === fixture.flowId);
  const solo = list.flows.find((flow) => flow.id === "ws:ws-solo");
  assert.equal(workspaces.flowTitle(entry), entry.label);
  assert.equal(solo.label, null);
  assert.equal(workspaces.flowTitle(solo), "ws-solo");

  assert.deepEqual(workspaces.specTagParts(entry.spec), { name: entry.spec.name, version: `v${entry.spec.version}` },
    "the spec name and its version stay separate so the name can truncate on its own");
  assert.equal(solo.spec, null);
  assert.equal(workspaces.specTagParts(solo.spec).version, null);

  assert.deepEqual(entry.attribution, { reported: 1, inferred: 1, unlinked: 1 });
  assert.deepEqual(workspaces.entryFacts(entry), [
    { key: "workspace", value: entry.workspaceId },
    { key: "tab", value: entry.tabId },
    { key: "panes", value: 2 },
    { key: "sessions", value: 2 },
    { key: "inferred", value: 1 },
    { key: "unlinked", value: 1 },
  ]);
  assert.deepEqual(workspaces.entryFacts({ ...entry, attribution: { reported: 2, inferred: 0, unlinked: 0 } }).map((fact) => fact.key),
    ["workspace", "tab", "panes", "sessions"], "a zero count is left out, not carried as 0");
  assert.deepEqual(workspaces.entryFacts(solo).map((fact) => [fact.key, fact.value]),
    [["workspace", "ws-solo"], ["panes", 0], ["sessions", 0]], "a workspace with no tab carries no tab fact");
});

test("the flow summary counts turns, found-via-search and spans with calls after activation, and leaves an unreported cost null", () => {
  assert.deepEqual(workspaces.flowSummary(report), {
    turns: 2, foundViaSearch: 1, abstainedTurns: 0, spans: 2, spansWithCalls: 2, costUsd: null,
  });
  assert.deepEqual(report.finding.aggregate.labels, {
    found_top1: 1, found_lower: 0, loaded_outside_results: 0, native_without_search: 1, searched_none_used: 0, no_search: 0,
  });

  const spans = report.usage.sessions.flatMap((session) => session.spans);
  assert.deepEqual(spans.map((span) => span.costUsd), [0.25, null], "Codex reports no cost, so that span stays null");
  assert.deepEqual(workspaces.summaryFacts(workspaces.flowSummary(report)), [
    { key: "turns", value: 2 },
    { key: "found", value: 1 },
    { key: "spans", withCalls: 2, total: 2 },
    { key: "cost", value: null },
  ], "an unreported cost reaches the row as null, never as a number");

  const planOnly = {
    flow: null, tree: { tabs: [], sessions: [sessionReport.tree] },
    finding: { id: "plan", sessions: [sessionReport.finding], aggregate: sessionReport.finding.aggregate },
    usage: { id: "plan", sessions: [sessionReport.usage], skills: [] },
  };
  assert.equal(workspaces.flowSummary(planOnly).costUsd, 0.25, "a flow whose unique calls reported costs sums them");
  assert.deepEqual(workspaces.summaryFacts(workspaces.flowSummary(planOnly)).find((fact) => fact.key === "cost"), { key: "cost", value: 0.25 });
});

test("the tree index keys every turn finding and span usage the view renders", () => {
  const { findings, usageBySpan } = workspaces.reportIndex(report);
  const turns = report.tree.tabs.flatMap((tab) => tab.panes.flatMap((pane) => pane.sessions.flatMap((link) => link.session?.turns ?? [])));
  const spans = turns.flatMap((turn) => turn.skillSpans);
  assert.equal(turns.length, 2);
  assert.equal(spans.length, 2);
  for (const turn of turns) assert.ok(findings.has(turn.id), `finding for ${turn.id}`);
  for (const span of spans) assert.ok(usageBySpan.has(span.id), `usage for ${span.id}`);
  assert.deepEqual([...new Set(turns.map((turn) => turn.basis))], ["reported"]);

  const planSpan = spans.find((span) => span.name === "research-deep");
  assert.equal(planSpan.skill, planSpan.uri, "a loaded skill is keyed by its uri, and the name is what the view prints");
  const planUsage = usageBySpan.get(planSpan.id);
  assert.deepEqual(workspaces.attributionParts(planUsage.attribution).map((part) => part.key), ["single"],
    "a share of 0 is left out of the attribution labels");
  assert.deepEqual(workspaces.spanFacts(planSpan, undefined, 3), [
    { key: "active", value: planSpan.endedAt - planSpan.startedAt },
    { key: "calls", value: 3 },
    { key: "cost", value: null },
  ], "a span with no usage row reports its own window and an unknown cost");
  assert.deepEqual(workspaces.spanFacts(planSpan, planUsage, 3), [
    { key: "active", value: planUsage.durationMs },
    { key: "callsAfter", value: 2 },
    { key: "commands", value: 1 },
    { key: "failed", value: 1 },
    { key: "cost", value: 0.25 },
  ]);
});

test("a span's call rows carry name, duration, outcome, tokens and an unreported cost as unknown", () => {
  const spans = report.tree.tabs.flatMap((tab) => tab.panes.flatMap((pane) => pane.sessions.flatMap((link) => link.session?.turns.flatMap((turn) => turn.skillSpans) ?? [])));
  const planRows = calls.callRows(spans.find((span) => span.name === "research-deep").events);
  assert.deepEqual(planRows.map((row) => row.name), ["Edit", "Bash", "claude-fable-5-1"]);
  assert.deepEqual(planRows.map((row) => row.kind), ["tool_call", "tool_call", "llm_call"]);
  assert.deepEqual(planRows.map((row) => row.success), [true, false, null]);
  assert.deepEqual(planRows.map((row) => row.cost), [null, null, "$0.2500"]);
  assert.deepEqual(planRows[2].tokens.map((part) => [part.key, part.value]), [["inputTokens", 100], ["outputTokens", 20], ["cacheReadTokens", 5]]);
  assert.equal(planRows[0].duration, calls.formatLapse(12));
  assert.notEqual(planRows[0].duration, calls.UNKNOWN);

  const codexRows = calls.callRows(spans.find((span) => span.name === "docs-writer").events);
  assert.equal(codexRows.find((row) => row.kind === "llm_call").cost, calls.UNKNOWN);
  assert.equal(codexRows.find((row) => row.kind === "tool_call").duration, calls.formatLapse(8));
  assert.equal(calls.callRow({ id: "x", kind: "tool_call", data: {} }).duration, calls.UNKNOWN, "an unmeasured duration is unknown, not 0");
  assert.notEqual(calls.formatCostUsd(0), calls.formatCostUsd(null));
  assert.equal(calls.formatCostUsd(null), calls.UNKNOWN);
});

test("token buckets are summed per measurement and an unreported bucket is absent, not zero", () => {
  const { usageBySpan } = workspaces.reportIndex(report);
  const [planUsage, codexUsage] = [...usageBySpan.values()];
  assert.deepEqual(calls.tokenParts(planUsage.tokens).map((part) => [part.key, part.value]),
    [["inputTokens", 100], ["outputTokens", 20], ["cacheReadTokens", 5]]);
  assert.deepEqual(calls.tokenParts(codexUsage.tokens).map((part) => [part.key, part.value]),
    [["inputTokens", 500], ["outputTokens", 30], ["cacheReadTokens", 200]]);
  assert.deepEqual(calls.tokenParts([]), []);
  assert.deepEqual(Object.keys(calls.TOKEN_LABEL), ["inputTokens", "outputTokens", "cacheReadTokens", "cacheCreationTokens", "cacheWriteTokens", "reasoningTokens", "totalTokens"]);
});

test("the spec comparison reaches the view with one status per step and the together step partial", () => {
  const byId = Object.fromEntries(report.comparison.steps.map((step) => [step.stepId, step]));
  assert.deepEqual(Object.keys(byId), ["plan", "build"]);
  assert.equal(byId.plan.status, "matched");
  assert.deepEqual(byId.plan.usedSkills, ["research-deep"]);
  assert.equal(byId.build.status, "partial");
  assert.deepEqual(byId.build.missingSkills, ["commit-helper"]);
  for (const step of report.comparison.steps) {
    assert.ok(step.status in state.STEP_STATUS_LABEL, step.status);
    assert.ok(step.status in state.STEP_STATUS_TITLE, step.status);
  }
  assert.deepEqual(report.comparison.unplanned, []);
  assert.equal(report.excludedSessions.length, 1, "the automated session is reported as left out");
});

test("skill spans fold the calls they own out of the flat timeline and keep the turn's finding label", () => {
  const kinds = sessionSteps.map((step) => step.kind);
  assert.deepEqual(kinds.filter((kind) => kind === "tool_call").length, 2);
  assert.deepEqual(kinds.filter((kind) => kind === "llm_call").length, 1);

  const plain = trace.planTimeline(sessionSteps, undefined);
  assert.equal(plain.length, sessionSteps.length);
  assert.deepEqual([...new Set(plain.map((item) => item.kind))], ["step"], "without a skill report nothing is folded");

  const items = trace.planTimeline(sessionSteps, sessionReport);
  const spanItems = items.filter((item) => item.kind === "span");
  assert.equal(spanItems.length, 1);
  assert.equal(spanItems[0].span.name, "research-deep");
  assert.equal(spanItems[0].finding, "found_top1");
  assert.equal(calls.callRows(spanItems[0].span.events).length, 3);
  assert.equal(items.filter((item) => item.kind === "step" && (item.step.kind === "tool_call" || item.step.kind === "llm_call")).length, 0,
    "every call the span owns moved inside it");
  assert.equal(items.length, sessionSteps.length - 3 + 1);

  const loadIndex = items.findIndex((item) => item.kind === "step" && item.step.kind === "load");
  assert.equal(items[loadIndex + 1].kind, "span", "the span sits right after the step that activated it");
  assert.deepEqual(trace.spanFacts(spanItems[0].span, 3, spanItems[0].finding), [
    { key: "active", value: spanItems[0].span.endedAt - spanItems[0].span.startedAt },
    { key: "calls", value: 3 },
    { key: "finding", value: "found_top1" },
  ]);
  assert.deepEqual(trace.spanFacts(spanItems[0].span, 3).map((fact) => fact.key), ["active", "calls"],
    "a turn with no finding carries no finding fact");
});

test("every label map the views index into covers its whole value set", () => {
  assert.deepEqual(Object.keys(state.FINDING_LABEL).sort(),
    ["found_lower", "found_top1", "loaded_outside_results", "native_without_search", "no_search", "searched_none_used"]);
  assert.deepEqual(Object.keys(state.FINDING_LABEL).sort(), Object.keys(state.FINDING_TITLE).sort());
  assert.deepEqual(Object.keys(state.STEP_STATUS_LABEL).sort(), ["different", "matched", "no_skill_used", "not_run", "partial"]);
  assert.deepEqual(Object.keys(state.STEP_STATUS_LABEL).sort(), Object.keys(state.STEP_STATUS_TITLE).sort());
  assert.deepEqual(Object.keys(state.BASIS_LABEL).sort(), ["inferred_time", "reported", "span_join"]);
  assert.deepEqual(Object.keys(state.BASIS_LABEL).sort(), Object.keys(state.BASIS_TITLE).sort());
  assert.deepEqual(Object.keys(state.SPAN_ATTRIBUTION_LABEL).sort(), ["co_active", "no_skill", "reported", "single"]);
  assert.equal(new Set(Object.values(state.FINDING_LABEL)).size, Object.keys(state.FINDING_LABEL).length, "no two labels read the same");
});

test("the workspaces routes round-trip through the hash, including an implicit ws: id", () => {
  assert.deepEqual(state.parseHash("#/workspaces"), { view: "workspaces", filter: {} });
  assert.deepEqual(state.parseHash("#/workspaces?automated=include"), { view: "workspaces", filter: { automated: "include" } });
  const detail = { view: "workspace", flowId: "ws:ws-main", filter: { runtime: ["codex"] } };
  assert.equal(state.buildHash(detail), "#/workspaces/ws%3Aws-main?runtime=codex");
  assert.deepEqual(state.parseHash(state.buildHash(detail)), detail);
  assert.deepEqual(state.parseHash(state.buildHash({ view: "workspace", flowId: fixture.flowId, filter: {} })),
    { view: "workspace", flowId: fixture.flowId, filter: {} });
});

test("every fact the views build is renderable, and only a finding fact carries a definition", () => {
  const entry = list.flows.find((flow) => flow.id === fixture.flowId);
  const { usageBySpan } = workspaces.reportIndex(report);
  const span = report.tree.tabs.flatMap((tab) => tab.panes.flatMap((pane) => pane.sessions.flatMap((link) => link.session?.turns.flatMap((turn) => turn.skillSpans) ?? [])))[0];
  const built = [
    ...workspaces.entryFacts(entry),
    ...workspaces.summaryFacts(workspaces.flowSummary(report)),
    ...workspaces.spanFacts(span, usageBySpan.get(span.id), 3),
    ...trace.spanFacts(span, 3, "found_top1"),
  ];
  assert.ok(built.length >= 12, String(built.length));
  for (const fact of built) {
    assert.equal(typeof factsMod.factText(fact), "string", fact.key);
    assert.notEqual(factsMod.factText(fact).length, 0, fact.key);
  }
  assert.equal(new Set(built.map((fact) => fact.key)).size >= 8, true);
  assert.equal(factsMod.factTitle({ key: "finding", value: "found_top1" }), state.FINDING_TITLE.found_top1);
  assert.equal(factsMod.factTitle({ key: "turns", value: 1 }), undefined);
  assert.notEqual(factsMod.factText({ key: "cost", value: null }), factsMod.factText({ key: "cost", value: 0 }),
    "an unknown cost never renders as a zero cost");
});

test("the list query carries only the filter keys GET /api/flows accepts", () => {
  assert.deepEqual(workspaces.flowsQuery({ view: "workspaces", filter: {} }), {});
  assert.deepEqual(workspaces.flowsQuery({ view: "workspaces", filter: { from: 1, to: 2, automated: "only", runtime: ["codex"], q: "x" } }),
    { from: 1, to: 2, automated: "only" });
  assert.equal(workspaces.turnsOpen(workspaces.TURNS_OPEN_MAX), true);
  assert.equal(workspaces.turnsOpen(workspaces.TURNS_OPEN_MAX + 1), false);
  assert.ok(workspaces.SUMMARY_CONCURRENCY >= 1);
});
