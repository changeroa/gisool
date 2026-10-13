import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { PACKAGE_ROOT } from "./_helpers.mjs";

// The chart module ships inside the dashboard bundle, so it is bundled the same way here (preact is inert without a DOM).
async function loadChart() {
  const result = await build({
    entryPoints: [fileURLToPath(new URL("dashboard/charts/heatmap.tsx", PACKAGE_ROOT))],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    target: "es2022",
    jsx: "automatic",
    jsxImportSource: "preact",
    logLevel: "silent",
  });
  const code = result.outputFiles[0].text;
  return import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
}

const chart = await loadChart();
const {
  AUTO_BUCKET_BELOW, autoBucket, buildGrid, buildSkillWeekGrid, cellLabel, cellSelected, cellTip, extendSelection, formatShare, formatWeek,
  gridTotal, hourLabels, hourRangeLabel, isoWeekRange, legendRanges, levelScale, localeWeekStart, ratio, selectionCount, selectionFromFilter,
  withSelection, withoutCellFilter, HEATMAP_CSS,
} = chart;

const fixtures = JSON.parse(readFileSync(new URL("dashboard/dev-fixtures.json", PACKAGE_ROOT), "utf8"));
const sum = (xs) => xs.reduce((a, b) => a + b, 0);

test("levelScale: zero is level 0, quartiles of the non-zero counts fill 1-3, the max is always level 4", () => {
  const level = levelScale([0, 1, 2, 3, 4, 5, 6, 7, 8, 0]);
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 7, 8].map(level), [0, 1, 1, 2, 2, 3, 3, 4, 4]);
  const sparse = levelScale([1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 2]);
  assert.equal(sparse(1), 1);
  assert.equal(sparse(2), 4);
  const flat = levelScale([3, 3, 3]);
  assert.equal(flat(3), 4, "a single distinct value is the busiest value");
  assert.equal(levelScale([])(5), 0);
  assert.equal(level(Number.NaN), 0);
  assert.equal(level(-2), 0);
});

test("legendRanges labels the count span behind each swatch and never prints NaN", () => {
  const level = levelScale([1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual(legendRanges(level, 8), ["0", "1-2", "3-4", "5-6", "7-8"]);
  assert.deepEqual(legendRanges(levelScale([]), 0), ["0", "-", "-", "-", "-"]);
  assert.ok(!legendRanges(level, Number.NaN).join().includes("NaN"));
});

test("buildGrid renders the 40-session fixture as 7 x 24 and its totals equal the fixture session count", () => {
  const grid = buildGrid(fixtures.heatmap);
  assert.equal(grid.bucketHours, 1);
  assert.equal(grid.weekStart, 1);
  assert.deepEqual(grid.dows, [1, 2, 3, 4, 5, 6, 0]);
  assert.equal(grid.rows.length, 7);
  assert.ok(grid.rows.every((row) => row.length === 24));
  assert.equal(grid.total, fixtures.sessions.length);
  assert.equal(sum(grid.rowTotals), fixtures.sessions.length);
  assert.equal(sum(grid.colTotals), fixtures.sessions.length);
  assert.deepEqual(grid.rowTotals, grid.dows.map((dow) => fixtures.heatmap.rowTotals[dow]), "row totals follow the week-start order");
  assert.deepEqual(grid.colTotals, fixtures.heatmap.colTotals);
  assert.equal(gridTotal(fixtures.heatmap), 40);
  assert.ok(grid.rows.flat().every((cell) => cell.level >= 0 && cell.level <= 4 && Number.isFinite(cell.share)));
  assert.equal(grid.rows.flat().filter((cell) => cell.level === 4).length >= 1, true);
  assert.equal(grid.maxCount, Math.max(...fixtures.heatmap.cells.map((c) => c.count)));
});

test("buildGrid re-buckets 1 h data into 2 h and 4 h columns without losing sessions", () => {
  const two = buildGrid(fixtures.heatmap, { bucketHours: 2 });
  assert.equal(two.hours.length, 12);
  assert.deepEqual(two.hours, [0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22]);
  assert.equal(two.total, 40);
  assert.deepEqual(two.colTotals, Array.from({ length: 12 }, (_, i) => fixtures.heatmap.colTotals[2 * i] + fixtures.heatmap.colTotals[2 * i + 1]));
  const four = buildGrid(fixtures.heatmap, { bucketHours: 4 });
  assert.equal(four.hours.length, 6);
  assert.equal(four.total, 40);
  assert.deepEqual(four.rowTotals, two.rowTotals);
  const sunday = buildGrid(fixtures.heatmap, { weekStart: 0 });
  assert.deepEqual(sunday.dows, [0, 1, 2, 3, 4, 5, 6]);
  assert.equal(sunday.rowTotals[0], fixtures.heatmap.rowTotals[0]);
});

test("buildGrid never splits a coarser DTO and tolerates sparse or malformed cells", () => {
  const twelve = buildGrid(fixtures.heatmap12, { bucketHours: 1 });
  assert.equal(twelve.bucketHours, 2, "a 2 h DTO cannot be rendered at 1 h");
  assert.equal(twelve.total, fixtures.sessions12.length);
  assert.deepEqual(twelve.colTotals, fixtures.heatmap12.colTotals);
  const dirty = buildGrid({ tz: "UTC", weekStart: 1, bucketHours: 1, cells: [
    { dow: 1, hour: 9, count: 2 }, { dow: 9, hour: 1, count: 5 }, { dow: 1, hour: 30, count: 5 }, { dow: 2, hour: 3, count: Number.NaN }, { dow: 2, hour: 4, count: "3" },
  ], rowTotals: [], colTotals: [] });
  assert.equal(dirty.total, 5);
  assert.equal(dirty.rowTotals[0], 2);
  assert.equal(dirty.rowTotals[1], 3);
  const empty = buildGrid({ tz: "UTC", weekStart: 0, bucketHours: 1, cells: [], rowTotals: new Array(7).fill(0), colTotals: new Array(24).fill(0) });
  assert.equal(empty.total, 0);
  assert.ok(empty.rows.flat().every((cell) => cell.level === 0 && cell.share === 0));
  assert.equal(ratio(3, 0), 0);
  assert.equal(ratio(3, 6), 0.5);
});

test("autoBucket widens to 2 h below the threshold or on a narrow viewport", () => {
  assert.equal(AUTO_BUCKET_BELOW, 50);
  assert.equal(autoBucket(40), 2);
  assert.equal(autoBucket(49), 2);
  assert.equal(autoBucket(50), 1);
  assert.equal(autoBucket(500), 1);
  assert.equal(autoBucket(500, true), 2);
});

test("localeWeekStart maps Intl firstDay 7 to Sunday and everything else to Monday", () => {
  assert.equal(localeWeekStart("en-US"), 0);
  assert.equal(localeWeekStart("de-DE"), 1);
  assert.equal(localeWeekStart("en-GB"), 1);
  assert.equal(localeWeekStart("ar-EG"), 1, "Saturday-start locales fall back to Monday");
  assert.equal(localeWeekStart("not a locale!!"), 1, "an invalid tag falls back to Monday");
  assert.equal(localeWeekStart(""), 1, "no locale at all falls back to Monday");
  assert.equal(localeWeekStart(), localeWeekStart(globalThis.navigator?.language), "the default argument is navigator.language");
});

test("labels and tooltips: hour ranges wrap at midnight, shares are percentages, no NaN anywhere", () => {
  assert.equal(hourRangeLabel(9, 1), "09:00-10:00");
  assert.equal(hourRangeLabel(22, 2), "22:00-00:00");
  assert.equal(cellLabel({ dow: 1, hour: 9 }, 2), "Mon 09:00-11:00");
  assert.equal(formatShare(3, 40), "7.5%");
  assert.equal(formatShare(10, 40), "25%");
  assert.equal(formatShare(1, 3), "33%");
  assert.equal(formatShare(0, 0), "0%");
  assert.equal(formatShare(2, 0), "0%");
  assert.equal(cellTip({ dow: 1, hour: 9, count: 3 }, 1, 40), "Mon 09:00-10:00 \u00b7 3 sessions \u00b7 7.5%");
  assert.equal(cellTip({ dow: 1, hour: 9, count: 1 }, 1, 40), "Mon 09:00-10:00 \u00b7 1 session \u00b7 2.5%");
  assert.equal(cellTip({ dow: 0, hour: 0, count: 0 }, 4, 0), "Sun 00:00-04:00 \u00b7 no sessions");
  assert.deepEqual(hourLabels(1).filter(Boolean), ["0", "3", "6", "9", "12", "15", "18", "21"]);
  assert.deepEqual(hourLabels(2).filter(Boolean), ["0", "4", "8", "12", "16", "20"]);
  assert.deepEqual(hourLabels(4), ["0", "4", "8", "12", "16", "20"]);
});

test("ISO weeks resolve to Monday..Sunday UTC dates", () => {
  const w35 = isoWeekRange("2026-W35");
  assert.equal(w35.start.toISOString().slice(0, 10), "2026-08-24");
  assert.equal(w35.end.toISOString().slice(0, 10), "2026-08-30");
  assert.equal(isoWeekRange("2026-W01").start.toISOString().slice(0, 10), "2025-12-29");
  assert.equal(isoWeekRange("2020-W53").start.toISOString().slice(0, 10), "2020-12-28");
  assert.equal(isoWeekRange("2021-W01").start.toISOString().slice(0, 10), "2021-01-04");
  assert.equal(isoWeekRange("nope"), undefined);
  assert.equal(isoWeekRange("2026-W60"), undefined);
  assert.equal(formatWeek("2026-W35").short, "W35");
  assert.equal(formatWeek("garbage").range, "garbage");
  assert.ok(!formatWeek("2026-W35").range.includes("NaN"));
});

test("buildSkillWeekGrid keeps only skills with loads, sorted by total, on the shared level scale", () => {
  const grid = buildSkillWeekGrid(fixtures.skillWeek);
  assert.deepEqual(grid.weeks, fixtures.skillWeek.weeks);
  assert.equal(grid.rows.length, fixtures.skillWeek.rows.filter((row) => sum(row.counts) > 0).length);
  const totals = grid.rows.map((row) => row.total);
  assert.deepEqual(totals, [...totals].sort((a, b) => b - a), "rows sorted by total descending");
  assert.equal(grid.total, sum(fixtures.skillWeek.rows.flatMap((row) => row.counts)));
  assert.deepEqual(grid.colTotals, fixtures.skillWeek.weeks.map((_, i) => sum(fixtures.skillWeek.rows.map((row) => row.counts[i]))));
  assert.ok(grid.rows.every((row) => row.levels.length === grid.weeks.length && row.levels.every((l) => l >= 0 && l <= 4)));
  assert.ok(grid.rows.some((row) => row.levels.includes(4)));
  const padded = buildSkillWeekGrid({ weeks: ["2026-W41", "2026-W42"], rows: [
    { uri: "skill://local/a/x/SKILL.md", name: "", counts: [1] }, { uri: "skill://local/a/y/SKILL.md", name: "y", counts: [0, 0] }, { uri: "skill://local/a/z/SKILL.md", name: "z", counts: [0, 4, 9] },
  ] });
  assert.deepEqual(padded.rows.map((row) => [row.name, row.counts]), [["z", [0, 4]], ["x", [1, 0]]]);
  assert.equal(padded.total, 5);
  assert.equal(buildSkillWeekGrid({ weeks: [], rows: [] }).total, 0);
});

test("selection: shift-click unions hours within one row, restarts on another row, and maps to the Filter contract", () => {
  const first = extendSelection(undefined, { dow: 1, hour: 10 }, 2);
  assert.deepEqual(first, { dow: 1, hour: 10, hourSpan: 2 });
  assert.deepEqual(extendSelection(first, { dow: 1, hour: 14 }, 2), { dow: 1, hour: 10, hourSpan: 6 });
  assert.deepEqual(extendSelection(first, { dow: 1, hour: 6 }, 2), { dow: 1, hour: 6, hourSpan: 6 });
  assert.deepEqual(extendSelection(first, { dow: 1, hour: 10 }, 2), first, "re-clicking the anchor keeps the span");
  assert.deepEqual(extendSelection(first, { dow: 3, hour: 10 }, 2), { dow: 3, hour: 10, hourSpan: 2 });
  assert.deepEqual(extendSelection({ dow: 0, hour: 20, hourSpan: 1 }, { dow: 0, hour: 20 }, 4), { dow: 0, hour: 20, hourSpan: 4 });
  const range = { dow: 1, hour: 10, hourSpan: 6 };
  assert.equal(cellSelected(range, { dow: 1, hour: 14 }), true);
  assert.equal(cellSelected(range, { dow: 1, hour: 16 }), false);
  assert.equal(cellSelected(range, { dow: 2, hour: 12 }), false);
  assert.equal(cellSelected(undefined, { dow: 1, hour: 10 }), false);
  assert.deepEqual(selectionFromFilter({ dow: 2, hour: 9, hourSpan: 2 }), { dow: 2, hour: 9, hourSpan: 2 });
  assert.deepEqual(selectionFromFilter({ dow: 2, hour: 9 }), { dow: 2, hour: 9, hourSpan: 1 });
  assert.equal(selectionFromFilter({ dow: 2 }), undefined);
  assert.deepEqual(withoutCellFilter({ runtime: ["codex"], dow: 2, hour: 9, hourSpan: 2, q: "x" }), { runtime: ["codex"], q: "x" });
  assert.deepEqual(withSelection({ runtime: ["codex"], dow: 5, hour: 1, hourSpan: 4 }, { dow: 1, hour: 9, hourSpan: 1 }), { runtime: ["codex"], dow: 1, hour: 9 }, "a 1 h bucket omits hourSpan");
  assert.deepEqual(withSelection({}, { dow: 1, hour: 10, hourSpan: 2 }), { dow: 1, hour: 10, hourSpan: 2 }, "a 2 h bucket sends hourSpan 2");
  const grid = buildGrid(fixtures.heatmap, { bucketHours: 2 });
  const monday = grid.rows[grid.dows.indexOf(1)];
  assert.equal(selectionCount(grid, { dow: 1, hour: 0, hourSpan: 24 }), fixtures.heatmap.rowTotals[1]);
  assert.equal(selectionCount(grid, { dow: 1, hour: 10, hourSpan: 4 }), monday.filter((c) => c.hour >= 10 && c.hour < 14).reduce((a, c) => a + c.count, 0));
});

test("the scoped stylesheet only uses design tokens for color, spacing, and radius", () => {
  const hex = HEATMAP_CSS.match(/#[0-9a-f]{3,8}\b/gi) ?? [];
  assert.deepEqual(hex, [], "no hard-coded hex colors");
  const rgb = HEATMAP_CSS.match(/\brgba?\(/g) ?? [];
  assert.deepEqual(rgb, [], "no hard-coded rgb colors");
  for (const name of ["--accent", "--ink", "--wash", "--surface", "--line", "--s-1", "--s-4", "--r-sm", "--r-md", "--fs-cap", "--t-micro"]) {
    assert.ok(HEATMAP_CSS.includes(`var(${name})`), `uses ${name}`);
  }
  assert.ok(/\.hm__cell--l4 \{ background: var\(--hm-l4\); \}/.test(HEATMAP_CSS));
});

const NARROW_BLOCK = "@media (max-width: 639.98px) {";
const wideCss = HEATMAP_CSS.slice(0, HEATMAP_CSS.indexOf(NARROW_BLOCK));
const narrowCss = HEATMAP_CSS.slice(HEATMAP_CSS.indexOf(NARROW_BLOCK));

/** Declarations of the `selector { ... }` rule in a stylesheet slice, as a property -> value map. */
function declarations(css, selector) {
  const pattern = new RegExp(`^\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\{([^}]*)\\}`, "m");
  const match = pattern.exec(css);
  assert.ok(match, `rule for ${selector}`);
  return Object.fromEntries(match[1].split(";").map((d) => d.trim()).filter(Boolean).map((d) => {
    const colon = d.indexOf(":");
    return [d.slice(0, colon).trim(), d.slice(colon + 1).trim()];
  }));
}

test("narrow widths give each skill name its own full-width wrapping line; desktop keeps the ellipsised label column", () => {
  assert.ok(wideCss.length > 0 && narrowCss.length > 0, "the narrow media block exists");
  const wideSkill = declarations(wideCss, ".hm__skill");
  assert.equal(wideSkill["white-space"], "nowrap");
  assert.equal(wideSkill["text-overflow"], "ellipsis");
  assert.equal(declarations(wideCss, ".hm__d--skill")["max-width"], "18ch");
  assert.equal(declarations(wideCss, ".hm")["grid-template-columns"], "max-content repeat(var(--hm-cols), minmax(0, 1fr)) max-content");
  assert.equal(declarations(narrowCss, ".hm--skills")["grid-template-columns"], "repeat(var(--hm-cols), minmax(0, 1fr)) max-content", "no label column on phones");
  const narrowLabel = declarations(narrowCss, ".hm--skills .hm__d");
  assert.equal(narrowLabel["grid-column"], "1 / -1", "the row header spans the whole grid row");
  assert.equal(narrowLabel["max-width"], "none");
  assert.equal(narrowLabel["white-space"], "normal");
  const narrowSkill = declarations(narrowCss, ".hm--skills .hm__skill");
  assert.equal(narrowSkill["white-space"], "normal");
  assert.equal(narrowSkill["overflow"], "visible");
  assert.equal(narrowSkill["text-overflow"], "clip");
  assert.equal(narrowSkill["max-width"], "none");
  assert.ok(!/max-width: \d+ch/.test(narrowCss), "no character cap on phone labels");
  const corner = declarations(narrowCss, ".hm--skills .hm__corner");
  assert.equal(corner.position, "absolute", "the Skill column header leaves the grid flow but stays in the accessibility tree");
  assert.notEqual(corner.display, "none");
  assert.equal(declarations(wideCss, ".hm__d")["grid-column"], undefined, "desktop row headers keep their column");
});

test("legend swatches carry a hairline ring so the level-0 tile is visible on the card in both schemes", () => {
  const swatch = declarations(HEATMAP_CSS, ".hm__sw");
  assert.equal(swatch["box-shadow"], "inset 0 0 0 1px var(--line-2)");
  assert.equal(swatch.width, "var(--s-3)");
  assert.equal(declarations(HEATMAP_CSS, ".hm-stack")["--hm-l0"], "var(--wash)", "the swatch keeps the same fill as an empty cell");
});
