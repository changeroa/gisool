import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test, { before, after } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { PACKAGE_ROOT, distImport } from "./_helpers.mjs";
import { join } from "node:path";
import { bearer, http, startTestServer } from "./helpers/api.mjs";
import { descendants, installDom } from "./helpers/dashboard-dom.mjs";
import { seedEvidence } from "./helpers/dashboard-evidence.mjs";

// Mutate the actual bundled component code, not fixture values or expected assertions.
export const mutations = {
  ranks: ["skill.rankInSearch}", "999}"],
  unranked: ['skill.rankInSearch ?? "not_in_results"', 'skill.rankInSearch ?? 0'],
  candidates: ["candidate.copies}", "999}"],
  abstention: ["abstention.reason}", '"mutated"}'],
  native: ["finding.nativeWithoutSearch}", "false}"],
  missed: ["finding.missedLater.map", "[].map"],
  correction: ["correction.status}", '"unknown"}'],
  correctionBasis: ["correction.label}", '"reported"}'],
  unknownCorrection: ['correction.reason ?? "none"', '"mutated"'],
  reads: ["read.eventId}", '"mutated"}'],
  readBasis: ["read.label}", '"unknown"}'],
  readPath: ['typeof event?.data.uri === "string" ? event.data.uri', 'typeof event?.data.uri === "string" ? "mutated"'],
  sharedCost: ["known.reduce((sum, cost) => sum + cost, 0)", "spans.reduce((sum, span) => sum + (span.costUsd ?? 0), 0)"],
  distinctCost: ["known.reduce((sum, cost) => sum + cost, 0)", "known[0]"],
  unknownCost: ["known.length === costs.size", "true"],
  callIdentity: ["event.callId ?? event.id", "event.id"],
  eventIdentity: ["event.callId ?? event.id", "event.callId"],
  matchingMode: ['specStep.together ? "together" : "alternatives"', 'specStep.together ? "alternatives" : "together"'],
  window: ['data-session-window="outside"', 'data-session-window="inside"'],
  lifecycle: ['? "end_not_observed" : "in_progress"', '? "in_progress" : "in_progress"'],
  unresolvedCount: ["data-unattributed-count={loads.count}", "data-unattributed-count={0}"],
  unresolvedUris: ["loads.uris.map", "[].map"],
  uncertainStep: ["uncertain && step.panes.length > 0", "false"],
};

const mutation = process.env.GISOOL_DASHBOARD_MUTATION;
const reword = process.env.GISOOL_DASHBOARD_REWORD === "1";
const bundled = await build({
  stdin: {
    contents: 'export * from "./dashboard/views/workspaces.tsx"; export * from "./dashboard/components/skill-evidence.tsx"; export {h, render} from "preact";',
    resolveDir: fileURLToPath(PACKAGE_ROOT), loader: "tsx",
  },
  bundle: true, write: false, format: "esm", platform: "node", jsx: "automatic", jsxImportSource: "preact", logLevel: "silent",
  plugins: mutation || reword ? [{
    name: "regression-mutation",
    setup(build) {
      build.onLoad({ filter: /(?:workspaces|skill-evidence)\.tsx$/ }, async ({ path }) => {
        const replacements = mutation ? [mutations[mutation]] : [
          ['"not in results (or no preceding search)"', '"absent from the preceding search"'],
          ['"next prompt text not captured"', '"following prompt content unavailable"'],
          ['"no next prompt observed"', '"following prompt unavailable"'],
        ];
        const source = await readFile(path, "utf8");
        if (reword && path.endsWith("skill-evidence.tsx")) {
          const count = replacements.filter(([from]) => source.includes(from)).length;
          assert.equal(count, 3, "the probe must reword all three display strings");
          console.log(`Reword probe: replaced ${count} display strings; semantic values unchanged.`);
        }
        return { contents: replacements.reduce((text, [from, to]) => text.replaceAll(from, to), source), loader: "tsx" };
      });
    },
  }] : [],
});
// Load before installing the DOM: view-local styles are a browser concern.
const ui = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`);
const newRoot = installDom();
let server, fixture, report, workspaceReport, versions;
const reports = {};
const costReports = {};
before(async () => {
  server = await startTestServer();
  fixture = seedEvidence(server.gisoolHome);
  const get = async (path) => {
    const response = await http(server.port, { path, headers: bearer(server.token) });
    assert.equal(response.status, 200);
    return response.json;
  };
  report = await get(`/api/flows/${fixture.flowId}`);
  workspaceReport = await get("/api/flows/ws:evidence-ws");
  versions = await get("/api/workflows/evidence-spec/versions");
  for (const [key, id] of Object.entries(fixture.ids)) reports[key] = await get(`/api/sessions/${id}/skill-report`);
  for (const [key, id] of Object.entries(fixture.costFlows)) costReports[key] = await get(`/api/flows/${id}`);
});
after(async () => { if (server) await server.stop(); delete globalThis.document; delete globalThis.HTMLDetailsElement; });

function render(Component, props) {
  const root = newRoot();
  ui.render(ui.h(Component, props), root);
  return root;
}
function attr(root, name, value) {
  const found = descendants(root).find((node) => node.attrs[name] === String(value));
  assert.ok(found, `${name}=${value} in ${root.textContent}`);
  return found;
}
const finding = (index = 0) => reports.evidence.finding.turns[index];
const findingView = (index = 0) => render(ui.FindingEvidence, { finding: finding(index) });

test("a real scoped flow report renders an unended session without inventing termination", (t) => {
  // Given the API's actual execution slice, not the workspace's unscoped session.
  const link = report.tree.tabs.flatMap((tab) => tab.panes.flatMap((pane) => pane.sessions))
    .find((item) => item.sessionId === fixture.ids.evidence);
  assert.ok(link?.session);
  assert.equal(reports.evidence.endedAt, null);
  // When the same Session component used by the dashboard renders that slice.
  const root = render(ui.Session, { link, session: link.session, flow: report.flow,
    route: { view: "workspaces", filter: {} }, findings: new Map(), usageBySpan: new Map() });
  t.after(() => ui.render(null, root));
  // Then the semantic status remains unobserved, although the analysis interval ended.
  assert.equal(link.session.endedAt, null);
  attr(root, "data-session-status", "end_not_observed");
});

test("a real scoped report still renders a genuinely observed session end", async (t) => {
  // Given a real termination event strictly inside the execution, delivered late.
  const { openDb } = await distImport("store/db.js");
  const { createStore } = await distImport("store/index.js");
  const store = createStore(openDb(join(server.gisoolHome, "gisool.db")));
  const endedAt = report.flow.endedMs - 1;
  try {
    store.append({ id: "observed-end-control", kind: "session_end", source: "hook", ts: endedAt,
      ref: { runtime: "claude-code", runtimeSessionId: "evidence" }, data: {} },
    { sessionId: fixture.ids.evidence, method: "runtime_id" });
  } finally { store.close(); }
  // When the actual API slice is rendered through Session.
  const result = await http(server.port, { path: `/api/flows/${fixture.flowId}`, headers: bearer(server.token) });
  assert.equal(result.status, 200);
  const link = result.json.tree.tabs[0].panes[0].sessions[0];
  const root = render(ui.Session, { link, session: link.session, flow: result.json.flow,
    route: { view: "workspaces", filter: {} }, findings: new Map(), usageBySpan: new Map() });
  t.after(() => ui.render(null, root));
  // Then the observed end survives separately from the later analysis boundary.
  assert.equal(link.session.endedAt, endedAt);
  assert.equal(link.session.executionWindow.to, report.flow.endedMs);
  attr(root, "data-session-status", "ended");
});
function usageView(name, index = 0) {
  const session = reports.evidence;
  const turn = session.tree.turns[index];
  const span = session.usage.spans.find((item) => item.name === name && item.turnId === turn.id);
  assert.ok(span);
  return render(ui.UsageEvidence, { usage: span, events: turn.events });
}

for (const scope of ["flow", "session"]) test(`${scope} unresolved loads render the real API count and every affected URI`, () => {
  // Given the corresponding real report, including its unresolved attribution population.
  const loads = (scope === "flow" ? report : reports.evidence).unattributedLoads;
  assert.equal(loads.count, 2);
  assert.equal(loads.uris.length, 2);
  // When the shared production disclosure renders it.
  const root = render(ui.UnresolvedLoadNotice, { loads });
  // Then its uncertainty, count and complete URI set have machine-readable semantics.
  attr(root, "data-load-attribution", "unresolved");
  attr(root, "data-unattributed-count", 2);
  assert.deepEqual(descendants(root).flatMap((node) => node.attrs["data-unattributed-uri"] ?? []), loads.uris);
});

test("a zero unresolved-load count renders no uncertainty disclosure", () => {
  const root = render(ui.UnresolvedLoadNotice, { loads: { count: 0, uris: [] } });
  assert.equal(descendants(root).some((node) => node.attrs["data-load-attribution"] !== undefined), false);
});

test("lower-ranked loaded skill retains its machine rank and rendered value", () => {
  const node = attr(findingView(), "data-used-skill", "lower");
  assert.equal(node.attrs["data-rank"], "2");
  assert.match(node.textContent, /rank 2/);
});
test("candidate copies expose collapsed rank and original rank", () => {
  const root = findingView();
  const copy = attr(root, "data-candidate", finding().candidates.find((item) => item.name === "first-copy").uri);
  assert.equal(copy.attrs["data-rank"], "1");
  assert.equal(copy.attrs["data-raw-rank"], "2");
  assert.equal(copy.attrs["data-copies"], "2");
  assert.match(copy.textContent, /copies 2/);
});
test("abstention preserves its reported reason and query", () => {
  const root = findingView(1);
  assert.match(attr(root, "data-abstention", "below_threshold").textContent, /below_threshold/);
  assert.match(root.textContent, /missing specialist/);
});
test("native-before-search remains visible when another finding label wins", () => {
  assert.equal(finding().label, "found_lower");
  attr(findingView(), "data-native-without-search", "true");
});
test("out-of-results use does not invent a rank", () => {
  const node = attr(findingView(1), "data-used-skill", "outside");
  assert.equal(node.attrs["data-rank"], "not_in_results");
  assert.equal(node.attrs["data-via"], "load");
});
test("missed-later link opens and focuses the actual folded turn", () => {
  const session = reports.evidence;
  const index = ui.reportIndex({ finding: { sessions: [session.finding] }, usage: { sessions: [session.usage] } });
  const target = render(ui.Turn, { turn: session.tree.turns[2], index: 2, finding: finding(2), usageBySpan: index.usageBySpan, open: false });
  const source = findingView();
  const missed = attr(source, "data-missed-skill", "later-missed");
  const anchor = missed.querySelector("a");
  assert.equal(anchor.attrs.href, "#turn-evidence-3");
  const [type, listener] = Object.entries(anchor.listeners).find(([name]) => name.toLowerCase() === "click");
  listener.call(anchor, { type, currentTarget: anchor, preventDefault() {} });
  assert.equal(attr(target, "data-turn", "evidence-3").open, true);
  assert.equal(target.querySelector("summary").focused, true);
});
test("correction status exposes matched terms and heuristic basis", () => {
  const node = attr(usageView("lower"), "data-correction", "correction");
  assert.equal(node.attrs["data-basis"], "heuristic");
  assert.match(node.textContent, /wrong/);
});
test("uncaptured next prompt remains unknown with heuristic basis", () => {
  const node = attr(usageView("outside", 1), "data-correction", "unknown");
  assert.equal(node.attrs["data-basis"], "heuristic");
  assert.equal(node.attrs["data-correction-reason"], "text_not_captured");
});
test("absent next prompt stays unknown rather than no correction", () => {
  const node = attr(usageView("later-missed", 2), "data-correction", "unknown");
  assert.equal(node.attrs["data-basis"], "heuristic");
  assert.equal(node.attrs["data-correction-reason"], "no_next_prompt");
});
test("reported supporting read shows actual resource and event provenance", () => {
  const root = usageView("lower");
  const read = reports.evidence.usage.spans.find((span) => span.name === "lower").supportingReads[0];
  const node = attr(root, "data-read", read.eventId);
  assert.equal(node.attrs["data-basis"], "reported");
  assert.match(node.textContent, /skill:\/\/agents\/lower\/reference\.md/);
  assert.ok(node.textContent.includes(read.eventId));
});
test("heuristic supporting read shows the tool argument and event", () => {
  const root = usageView("native-before");
  const read = reports.evidence.usage.spans.find((span) => span.name === "native-before").supportingReads[0];
  const node = attr(root, "data-read", read.eventId);
  assert.equal(node.attrs["data-basis"], "heuristic");
  assert.match(node.textContent, /\/skills\/native-before\/reference\.md/);
});

function costView(key) {
  return render(ui.Header, { report: costReports[key], backHref: "#/workspaces", onRefresh() {}, busy: false });
}
test("flow header charges one 0.02 model call once for two co-active spans", () => {
  assert.match(costView("shared").textContent, /cost \$0\.0200/);
  const session = reports.shared;
  assert.deepEqual(session.usage.spans.map((span) => span.costUsd), [0.02, 0.02]);
  for (const span of session.tree.turns[0].skillSpans) {
    const node = render(ui.Span, { span, usage: session.usage.spans.find((item) => item.spanId === span.id) });
    attr(node, "data-shared-cost", "true");
    assert.match(node.textContent, /cost \$0\.0200/);
  }
});
test("flow header adds two distinct model call costs exactly once", () => {
  assert.match(costView("distinct").textContent, /cost \$0\.0500/);
});
test("flow header preserves unknown cost for any unreported relevant call", () => {
  assert.match(costView("unknown").textContent, /cost unknown/);
});
test("flow header counts model calls without active skills", () => {
  assert.match(costView("unskilled").textContent, /cost \$0\.0400/);
});
test("flow header deduplicates repeated observations by model call identity", () => {
  assert.match(costView("repeated").textContent, /cost \$0\.0200/);
});
test("flow header uses event identity when model call IDs are absent", () => {
  assert.match(costView("event-only").textContent, /cost \$0\.0500/);
});
test("step cards render together and alternative modes from the exact spec version", () => {
  const spec = versions.find((item) => item.version === report.spec.version);
  for (const [i, mode] of ["together", "alternatives"].entries()) {
    const step = report.comparison.steps[i];
    attr(render(ui.StepRow, { step, specStep: spec.steps.find((item) => item.id === step.stepId) }), "data-skill-mode", mode);
  }
});
test("unresolved loads qualify a mapped step's non-use without hiding an unmapped step", () => {
  // Given uncertainty and an otherwise empty mapped step.
  const step = { ...report.comparison.steps[0], usedSkills: [], status: "no_skill_used" };
  // When the actual step component renders mapped and unmapped variants.
  const mapped = render(ui.StepRow, { step, uncertain: true });
  const unmapped = render(ui.StepRow, { step: { ...step, panes: [], status: "not_run" }, uncertain: true });
  // Then missing attribution is unknown, but an absent mapping remains a known not-run result.
  attr(mapped, "data-step-attribution", "uncertain");
  assert.equal(descendants(unmapped).some((node) => node.attrs["data-step-attribution"] === "uncertain"), false);
  attr(unmapped, "data-status", "not_run");
});
test("pane history and missing ends stay distinct from the registered execution", () => {
  const pane = workspaceReport.tree.tabs[0].panes[0];
  const link = pane.sessions.find((item) => item.agentSessionValue === "earlier");
  assert.ok(link, "implicit workspace retains the earlier pane session");
  assert.equal(report.tree.tabs[0].panes[0].sessions.some((item) => item.sessionId === link.sessionId), false);
  const props = { session: link.session, link, route: { filter: {} }, findings: new Map(), usageBySpan: new Map() };
  const ended = render(ui.Session, { ...props, flow: report.flow });
  const header = render(ui.Header, { report, backHref: "#/workspaces", onRefresh() {}, busy: false });
  assert.equal(descendants(header).some((node) => node.attrs["data-pane-history"] === "true"), false);
  attr(ended, "data-session-window", "outside");
  attr(ended, "data-session-status", "end_not_observed");
  attr(render(ui.Session, { ...props, newerSession: true }), "data-session-status", "end_not_observed");
  attr(render(ui.Session, { ...props, paneClosed: true }), "data-session-status", "end_not_observed");
  attr(render(ui.Session, props), "data-session-status", "in_progress");
});
