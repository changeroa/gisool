import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { PACKAGE_ROOT } from "./_helpers.mjs";

// The dashboard ships as one esbuild bundle; each module under test is bundled the same way (preact JSX, browser platform)
// and imported from a data: URL, so the pure helpers run in node without a DOM.
async function loadModule(relPath) {
  const result = await build({
    entryPoints: [fileURLToPath(new URL(relPath, PACKAGE_ROOT))],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    target: "es2022",
    jsx: "automatic",
    jsxImportSource: "preact",
    logLevel: "silent",
  });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
}

const [sankey, flow, state] = await Promise.all([
  loadModule("dashboard/charts/sankey.tsx"),
  loadModule("dashboard/views/flow.tsx"),
  loadModule("dashboard/state.ts"),
]);
const fixtures = JSON.parse(readFileSync(new URL("dashboard/dev-fixtures.json", PACKAGE_ROOT), "utf8"));
const FLOW = fixtures.flow;
const FLOW12 = fixtures.flow12;
const EMPTY = { ...FLOW, nodes: [], links: [], sessionCount: 0 };

const columnOf = (dto) => new Map(dto.nodes.map((n) => [n.id, n.column]));
const linkIndex = (dto, source, target, st) => {
  const i = dto.links.findIndex((l) => l.source === source && l.target === target && l.state === st);
  assert.ok(i >= 0, `fixture link ${source} -> ${target} (${st})`);
  return i;
};
const identity = (value) => (value.startsWith("skill://") ? value : undefined);
const PR_REVIEW = "skill://local/agents/pr-review-ko/SKILL.md";

test("defaultMode: the top-paths table is the default below 30 sessions, the chart from 30", () => {
  assert.equal(flow.TABLE_THRESHOLD, 30);
  assert.equal(flow.defaultMode(0), "table");
  assert.equal(flow.defaultMode(FLOW12.sessionCount), "table");
  assert.equal(flow.defaultMode(29), "table");
  assert.equal(flow.defaultMode(30), "chart");
  assert.equal(flow.defaultMode(FLOW.sessionCount), "chart");
  assert.equal(flow.DEFAULT_TOP, 7);
  assert.equal(flow.EXPANDED_TOP, 15);
});

test("legend is one line and names the unit", () => {
  assert.equal(flow.legendText("first_load"), "Band width = sessions (unit: first loaded skill)");
  assert.ok(flow.legendText("all_loads").includes("all loaded skills"));
  assert.ok(!flow.legendText("all_loads").includes("\n"));
});

test("topPaths derives one row per task -> skill -> outcome from the task->skill links, sorted by sessions", () => {
  const rows = flow.topPaths(FLOW);
  const cols = columnOf(FLOW);
  const expected = FLOW.links.filter((l) => cols.get(l.source) === 0 && cols.get(l.target) === 1);
  assert.equal(rows.length, expected.length);
  assert.equal(rows[0].count, Math.max(...expected.map((l) => l.count)));
  for (let i = 1; i < rows.length; i++) assert.ok(rows[i - 1].count >= rows[i].count, "sorted by count desc");
  for (const row of rows) {
    const link = FLOW.links[row.index];
    assert.equal(link.state, row.state);
    assert.equal(link.count, row.count);
    assert.equal(row.share, row.count / FLOW.sessionCount);
    assert.equal(row.task, FLOW.nodes.find((n) => n.id === link.source).label);
    assert.equal(row.skill, FLOW.nodes.find((n) => n.id === link.target).label);
  }
  assert.ok(rows.some((r) => r.task === "Other" && r.skillNode.id === "s:terraform-r2"), "Other task bucket keeps its paths");
  assert.deepEqual(flow.topPaths(EMPTY), []);
});

test("targetFilter maps skill nodes to `skill`, outcome nodes to `state`, bands to both, and nothing else to q", () => {
  const skillNode = { id: `s:${PR_REVIEW}`, column: 1, label: "pr-review-ko", count: 5 };
  const stateNode = { id: "a:no_match", column: 2, label: "no_match", count: 6 };
  const taskNode = { id: "t:review", column: 0, label: "코드 리뷰", count: 7 };
  const noneNode = { id: "s:(none)", column: 1, label: "(no skill)", count: 11 };
  const otherNode = { id: "s:__other__", column: 1, label: "Other (3)", count: 4, other: true };
  const nodes = [skillNode, stateNode, taskNode, noneNode, otherNode];
  const node = (n) => ({ kind: "node", node: n });

  assert.deepEqual(flow.targetFilter(node(skillNode), nodes, identity), { skill: [PR_REVIEW] });
  assert.deepEqual(flow.targetFilter(node(stateNode), nodes, identity), { state: ["no_match"] });
  assert.equal(flow.targetFilter(node(taskNode), nodes, identity), undefined);
  assert.equal(flow.targetFilter(node(noneNode), nodes, identity), undefined);
  assert.equal(flow.targetFilter(node(otherNode), nodes, identity), undefined);

  const band = (source, target, st) => ({ kind: "link", link: { source, target, count: 1, state: st }, index: 0 });
  assert.deepEqual(flow.targetFilter(band("t:review", `s:${PR_REVIEW}`, "loaded"), nodes, identity), { skill: [PR_REVIEW], state: ["loaded"] });
  assert.deepEqual(flow.targetFilter(band(`s:${PR_REVIEW}`, "a:no_match", "no_match"), nodes, identity), { skill: [PR_REVIEW], state: ["no_match"] });
  assert.deepEqual(flow.targetFilter(band("t:review", "s:(none)", "not_used"), nodes, identity), { state: ["not_used"] });
  assert.deepEqual(flow.targetFilter(band("t:review", "s:__other__", "aborted"), nodes, identity), { state: ["aborted"] });
});

test("fixture skill nodes carry names; skillResolver maps them to catalog URIs and the state node prefix is ignored", () => {
  const resolve = flow.skillResolver(fixtures.skills);
  assert.equal(resolve("pr-review-ko"), PR_REVIEW);
  assert.equal(resolve(PR_REVIEW), PR_REVIEW);
  assert.equal(resolve("no-such-skill"), undefined);
  const fixtureSkill = FLOW.nodes.find((n) => n.id === "s:pr-review-ko");
  assert.deepEqual(flow.targetFilter({ kind: "node", node: fixtureSkill }, FLOW.nodes, resolve), { skill: [PR_REVIEW] });
  assert.equal(flow.targetFilter({ kind: "node", node: fixtureSkill }, FLOW.nodes, flow.skillResolver([])), undefined);
  const fixtureState = FLOW.nodes.find((n) => n.id === "st:loaded");
  assert.deepEqual(flow.targetFilter({ kind: "node", node: fixtureState }, FLOW.nodes, resolve), { state: ["loaded"] });
});

test("sessionsRoute keeps the current filter, replaces skill/state, and builds a #/sessions hash with skill=", () => {
  const route = { view: "flow", filter: { runtime: ["codex"], skill: ["skill://local/agents/old/SKILL.md"], hour: 9, hourSpan: 2 } };
  const next = flow.sessionsRoute(route, { skill: [PR_REVIEW], state: ["loaded"] });
  assert.deepEqual(next, { view: "sessions", filter: { runtime: ["codex"], skill: [PR_REVIEW], state: ["loaded"], hour: 9, hourSpan: 2 } });
  const hash = state.buildHash(next);
  assert.ok(hash.startsWith("#/sessions?"), hash);
  assert.ok(hash.includes("skill=skill://local/agents/pr-review-ko/SKILL.md"), hash);
  assert.ok(hash.includes("state=loaded"), hash);
  assert.deepEqual(state.parseHash(hash), next);
});

test("layoutFlow pins nodes to their column, sorts by value with Other last, and emits SVG paths for every link", () => {
  const width = 960;
  const height = 480;
  const top = 24;
  const layout = sankey.layoutFlow(FLOW, { width, height, top });
  const linked = new Set(FLOW.links.flatMap((l) => [l.source, l.target]));
  assert.equal(layout.nodes.length, FLOW.nodes.filter((n) => linked.has(n.id)).length);
  assert.equal(layout.links.length, FLOW.links.length);

  for (const node of layout.nodes) {
    for (const key of ["x0", "x1", "y0", "y1", "value"]) assert.ok(Number.isFinite(node[key]), `${node.id}.${key} finite`);
    assert.equal(node.x1 - node.x0, 10, "node width");
    assert.ok(node.y0 >= top && node.y1 <= height && node.y1 > node.y0, `${node.id} inside the extent`);
    assert.equal(node.x0, [0, (width - 10) / 2, width - 10][node.column], `${node.id} column x`);
  }
  for (const column of [0, 1, 2]) {
    const inColumn = layout.nodes.filter((n) => n.column === column);
    for (let i = 1; i < inColumn.length; i++) {
      assert.ok(inColumn[i - 1].y1 <= inColumn[i].y0, "no vertical overlap");
      if (!inColumn[i].other) assert.ok(inColumn[i - 1].value >= inColumn[i].value, `column ${column} sorted by value`);
    }
    const otherAt = inColumn.findIndex((n) => n.other);
    if (otherAt >= 0) assert.equal(otherAt, inColumn.length - 1, `Other is last in column ${column}`);
  }
  for (const link of layout.links) {
    const original = FLOW.links[link.index];
    assert.equal(link.source, original.source);
    assert.equal(link.target, original.target);
    assert.equal(link.count, original.count);
    assert.equal(link.state, original.state);
    assert.ok(link.width > 0 && Number.isFinite(link.width));
    assert.match(link.path, /^M[\d.e+-]+,[\d.e+-]+C/);
  }
  const widths = layout.links.map((l) => l.width / l.count);
  assert.ok(Math.max(...widths) - Math.min(...widths) < 1e-9, "band width is proportional to sessions");
});

test("layoutFlow survives narrow widths, drops dangling links, and yields nothing for an empty or unmeasured chart", () => {
  const narrow = sankey.layoutFlow(FLOW, { width: 358, height: 300, top: 24, nodePadding: 10 });
  assert.equal(narrow.links.length, FLOW.links.length);
  for (const node of narrow.nodes) assert.ok(Number.isFinite(node.y0) && Number.isFinite(node.y1));
  const dangling = { ...FLOW, links: [...FLOW.links, { source: "t:review", target: "s:missing", count: 3, state: "loaded" }] };
  assert.equal(sankey.layoutFlow(dangling, { width: 960, height: 480 }).links.length, FLOW.links.length);
  assert.deepEqual(sankey.layoutFlow(EMPTY, { width: 960, height: 480 }), { nodes: [], links: [] });
  assert.deepEqual(sankey.layoutFlow(FLOW, { width: 0, height: 480 }), { nodes: [], links: [] });
  assert.equal(sankey.chartHeight(FLOW12, false) >= 260, true);
  assert.equal(sankey.chartHeight(FLOW, true) <= 560, true);
});

test("connected follows a session's state through both hops (upstream and downstream)", () => {
  const cols = columnOf(FLOW);
  const loaded = sankey.connected(FLOW, { kind: "node", node: FLOW.nodes.find((n) => n.id === "st:loaded") });
  const allLoaded = new Set(FLOW.links.map((l, i) => (l.state === "loaded" ? i : -1)).filter((i) => i >= 0));
  assert.deepEqual(loaded.links, allLoaded, "outcome node lights every band that ends in it");
  assert.ok(loaded.nodes.has("t:review") && loaded.nodes.has("s:pr-review-ko") && !loaded.nodes.has("st:no_match"));

  const review = sankey.connected(FLOW, { kind: "node", node: FLOW.nodes.find((n) => n.id === "t:review") });
  const expected = new Set([
    linkIndex(FLOW, "t:review", "s:pr-review-ko", "loaded"),
    linkIndex(FLOW, "s:pr-review-ko", "st:loaded", "loaded"),
    linkIndex(FLOW, "t:review", "s:none", "not_used"),
    linkIndex(FLOW, "s:none", "st:not_used", "not_used"),
  ]);
  assert.deepEqual(review.links, expected, "task node lights its bands and their continuations only");
  assert.deepEqual([...review.nodes].sort(), ["s:none", "s:pr-review-ko", "st:loaded", "st:not_used", "t:review"]);

  const none = sankey.connected(FLOW, { kind: "node", node: FLOW.nodes.find((n) => n.id === "s:none") });
  const touching = new Set(FLOW.links.map((l, i) => (l.source === "s:none" || l.target === "s:none" ? i : -1)).filter((i) => i >= 0));
  assert.deepEqual(none.links, touching);

  const docsNoMatch = linkIndex(FLOW, "t:docs", "s:none", "no_match");
  const noneNoMatch = linkIndex(FLOW, "s:none", "st:no_match", "no_match");
  const band = sankey.connected(FLOW, { kind: "link", link: FLOW.links[docsNoMatch], index: docsNoMatch });
  assert.deepEqual(band.links, new Set([docsNoMatch, noneNoMatch]));
  const back = sankey.connected(FLOW, { kind: "link", link: FLOW.links[noneNoMatch], index: noneNoMatch });
  const upstream = FLOW.links.map((l, i) => (cols.get(l.source) === 0 && l.target === "s:none" && l.state === "no_match" ? i : -1)).filter((i) => i >= 0);
  assert.deepEqual(back.links, new Set([noneNoMatch, ...upstream]));
  assert.ok(upstream.length >= 2, "fixture has several task types ending in no_match without a skill");
});

test("percent and nodeValue helpers", () => {
  assert.equal(sankey.percent(5, 40), "13%");
  assert.equal(sankey.percent(0, 40), "0%");
  assert.equal(sankey.percent(1, 400), "<1%");
  assert.equal(sankey.percent(3, 0), "0%");
  assert.equal(sankey.nodeValue({ id: `s:${PR_REVIEW}` }), PR_REVIEW);
  assert.equal(sankey.nodeValue({ id: "st:loaded" }), "loaded");
  assert.equal(sankey.nodeValue({ id: "plain" }), "plain");
});
