import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { PACKAGE_ROOT } from "./_helpers.mjs";

// The dashboard ships as one esbuild bundle; the view modules are bundled the same way here so the
// exported helpers run in node without a DOM (nothing touches `document` at module load).
async function loadModule(relative) {
  const result = await build({
    entryPoints: [fileURLToPath(new URL(relative, PACKAGE_ROOT))],
    bundle: true,
    write: false,
    format: "esm",
    platform: "node",
    target: "es2022",
    jsx: "automatic",
    jsxImportSource: "preact",
    logLevel: "silent",
  });
  const code = result.outputFiles[0].text;
  return import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
}

const trace = await loadModule("dashboard/views/trace.tsx");
const candidates = await loadModule("dashboard/components/candidates.tsx");
const fixtures = JSON.parse(readFileSync(new URL("dashboard/dev-fixtures.json", PACKAGE_ROOT), "utf8"));

const EVENT_KINDS = ["session_start", "prompt", "search", "load", "read_file", "native_skill", "session_end", "error"];
const ALL_KINDS_SESSION = "ses_ac514fa3a9";
const ABSTAINED_SESSION = "ses_bb85bd8f72";
const NEVER_CONSULTED_SESSION = "ses_b143443884";

test("fixtures cover every step kind, one abstained search, and one session with no search", () => {
  const allKinds = fixtures.traces[ALL_KINDS_SESSION];
  assert.ok(allKinds, `trace ${ALL_KINDS_SESSION} exists`);
  for (const kind of EVENT_KINDS) assert.ok(allKinds.some((step) => step.kind === kind), `fixture has a ${kind} step`);
  const everyKind = new Set(Object.values(fixtures.traces).flat().map((step) => step.kind));
  assert.deepEqual([...everyKind].sort(), [...EVENT_KINDS].sort());

  const abstained = fixtures.traces[ABSTAINED_SESSION].find((step) => step.kind === "search");
  assert.equal(abstained.detail.abstained.reason, "no_overlap");
  assert.equal(abstained.detail.candidates.length, 0);

  assert.equal(fixtures.traces[NEVER_CONSULTED_SESSION].filter((step) => step.kind === "search").length, 0);
  assert.ok(fixtures.sessions.some((row) => row.id === NEVER_CONSULTED_SESSION && row.state === "not_used"));
});

test("every kind has a label and the never-consulted copy is the shipped sentence", () => {
  assert.deepEqual(Object.keys(trace.KIND_LABEL).sort(), [...EVENT_KINDS].sort());
  for (const kind of EVENT_KINDS) assert.ok(trace.KIND_LABEL[kind].length > 0, kind);
  assert.equal(trace.NEVER_CONSULTED, "This session never consulted gisool");
  assert.deepEqual(Object.keys(trace.ABSTAIN_LABEL).sort(), ["below_threshold", "empty_query", "explicit_only", "no_overlap"]);
  assert.deepEqual(Object.keys(trace.MODE_LABEL).sort(), ["automatic", "discovery", "explicit"]);
});

test("traceCounts tallies each kind and abstained searches", () => {
  assert.deepEqual(trace.traceCounts(fixtures.traces[ALL_KINDS_SESSION]), { steps: 10, searches: 1, abstained: 0, loads: 2, reads: 2, natives: 1, errors: 1 });
  assert.deepEqual(trace.traceCounts(fixtures.traces[ABSTAINED_SESSION]), { steps: 4, searches: 1, abstained: 1, loads: 0, reads: 0, natives: 0, errors: 0 });
  assert.deepEqual(trace.traceCounts(fixtures.traces[NEVER_CONSULTED_SESSION]), { steps: 3, searches: 0, abstained: 0, loads: 0, reads: 0, natives: 0, errors: 0 });
  assert.deepEqual(trace.traceCounts([]), { steps: 0, searches: 0, abstained: 0, loads: 0, reads: 0, natives: 0, errors: 0 });
});

test("candidates render in rank order and the loaded ones are marked from either source", () => {
  const search = fixtures.traces[ALL_KINDS_SESSION].find((step) => step.kind === "search").detail;
  const ordered = candidates.orderCandidates(search.candidates);
  assert.deepEqual(ordered.map((c) => c.rank), [1, 2, 3, 4]);

  const picked = candidates.chosenUris(search.candidates, search.chosen);
  assert.deepEqual([...picked], ["skill://local/agents/db-migration/SKILL.md", "skill://local/agents/api-contract/SKILL.md"]);
  assert.equal(picked.has("skill://local/agents/pr-review-ko/SKILL.md"), false);

  const flagged = candidates.chosenUris([{ ...search.candidates[3], chosen: true }], undefined);
  assert.deepEqual([...flagged], ["skill://local/agents/pr-review-ko/SKILL.md"], "the store's per-candidate flag also marks a row");

  const shuffled = [
    { uri: "a", name: "a", description: "", score: 0.2, rank: 3, invocation: "automatic", digest: "", matched: [] },
    { uri: "b", name: "b", description: "", score: 0.9, rank: 1, invocation: "explicit", digest: "", matched: [] },
    { uri: "c", name: "c", description: "", score: 0.9, rank: 2, invocation: "automatic", digest: "", matched: [] },
  ];
  assert.deepEqual(candidates.orderCandidates(shuffled).map((c) => c.uri), ["b", "c", "a"]);
  const lowTop = [{ ...shuffled[0], rank: 1 }, { ...shuffled[1], rank: 2 }];
  assert.deepEqual(candidates.orderCandidates(lowTop).map((c) => c.uri), ["a", "b"], "a weaker match score never reorders ranks");
});

test("coverage label counts query terms the candidate matched with the router's term rules", () => {
  const search = fixtures.traces[ALL_KINDS_SESSION].find((step) => step.kind === "search").detail;
  assert.equal(candidates.coverageLabel(search.query, search.candidates[0].matched), "6/8 terms");
  assert.equal(candidates.coverageLabel("review this PR", ["review", "PR"]), "2/2 terms");
  assert.equal(candidates.coverageLabel("deploy", []), "0/1 term");
  assert.equal(candidates.coverageLabel("", ["x"]), undefined);
  assert.equal(candidates.coverageLabel("how to", ["x"]), undefined, "stopword-only query has no terms to cover");
});

test("root hints appear only for names that repeat across roots", () => {
  const search = fixtures.traces[ALL_KINDS_SESSION].find((step) => step.kind === "search").detail;
  const hints = candidates.rootHints(search.candidates);
  assert.deepEqual([...hints], [
    ["skill://local/agents/db-migration/SKILL.md", "agents"],
    ["skill://local/codex/db-migration/SKILL.md", "codex"],
  ]);
  assert.equal(candidates.rootOf("skill://local/claude/cloudflare-one-migrations/SKILL.md"), "claude");
  assert.equal(candidates.rootOf("skill://local/my%20root/x/SKILL.md"), "my root");
  assert.equal(candidates.rootOf("not-a-uri"), undefined);
});

test("score formatting is two decimals and bar widths are clamped percentages", () => {
  assert.equal(candidates.formatScore(0.82), "0.82");
  assert.equal(candidates.formatScore(1), "1.00");
  assert.equal(candidates.formatScore(Number.NaN), "-");
  assert.equal(candidates.scoreWidth(0.82), "82%");
  assert.equal(candidates.scoreWidth(1.7), "100%");
  assert.equal(candidates.scoreWidth(-1), "0%");
  assert.equal(candidates.scoreWidth(Number.NaN), "0%");
  assert.deepEqual(candidates.INVOCATION_LABEL, { automatic: "auto", explicit: "explicit" });
});

test("searchDetail normalizes a sparse detail and evalCasePayload posts query plus fromTraceId", () => {
  const step = fixtures.traces[ABSTAINED_SESSION].find((s) => s.kind === "search");
  const detail = trace.searchDetail(step);
  assert.equal(detail.traceId, "tr_c03785ef");
  assert.equal(detail.query, "Terraform으로 R2 버킷 만들어줘");
  assert.equal(detail.mode, "automatic");
  assert.deepEqual(detail.candidates, []);
  assert.deepEqual(detail.abstained, { reason: "no_overlap", hint: "No skill mentions Terraform or R2; add aliases or a new skill." });
  assert.equal(detail.elapsedMs, 4);
  assert.equal(detail.total, 0);
  assert.deepEqual(trace.evalCasePayload(detail), { query: "Terraform으로 R2 버킷 만들어줘", fromTraceId: "tr_c03785ef" });

  const sparse = trace.searchDetail({ ts: 1, kind: "search", summary: "", detail: { kind: "search", candidates: [{ uri: "x", score: 0.5, rank: 1 }] } });
  assert.deepEqual(sparse, { kind: "search", traceId: "", chosen: [], query: "", mode: "automatic", candidates: [{ uri: "x", score: 0.5, rank: 1 }], abstained: undefined, elapsedMs: 0, total: 1 });
  assert.deepEqual(trace.evalCasePayload(sparse), { query: "" }, "no trace id -> fromTraceId omitted");
  assert.equal(trace.isSearchStep(step), true);
  assert.equal(trace.isSearchStep(fixtures.traces[ABSTAINED_SESSION][0]), false);
});

test("prompt fold keeps 600 code points and reports whether it folded", () => {
  const short = "a".repeat(600);
  assert.deepEqual(trace.foldText(short), { head: short, folded: false });
  const long = "가".repeat(601);
  const folded = trace.foldText(long);
  assert.equal(folded.folded, true);
  assert.equal(Array.from(folded.head).length, 600);
  const emoji = "😀".repeat(5);
  assert.deepEqual(trace.foldText(emoji, 2), { head: "😀😀", folded: true }, "surrogate pairs are not split");
  assert.equal(trace.PROMPT_FOLD_CHARS, 600);
});

test("load, read and time formatters produce the compact labels the timeline shows", () => {
  assert.equal(trace.shortDigest("3011f937739e79c8"), "3011f937");
  assert.equal(trace.shortDigest("sha256:faf648b56dcf0a1b"), "faf648b5", "catalog digests carry a sha256: prefix");
  assert.equal(trace.shortDigest(""), "");
  assert.equal(trace.formatMs(3.446750000002794), "3.4 ms");
  assert.equal(trace.formatMs(0.0131), "0.01 ms");
  assert.equal(trace.formatMs(245.6), "246 ms");
  assert.equal(trace.formatMs(-1), "-");
  assert.equal(trace.resourcePath("skill://local/agents/db-migration/SKILL.md", "skill://local/agents/db-migration/references/rollback.md"), "references/rollback.md");
  assert.equal(trace.resourcePath("skill://local/agents/db-migration/SKILL.md", "skill://local/other/x.md"), "skill://local/other/x.md");
  assert.equal(trace.resourcePath("", "skill://local/other/x.md"), "skill://local/other/x.md");
  assert.equal(trace.formatBytes(1203), "1.2 KB");
  assert.equal(trace.formatBytes(512), "512 B");
  assert.equal(trace.formatBytes(3 * 1024 * 1024), "3.0 MB");
  assert.equal(trace.formatBytes(-1), "-");
  assert.equal(trace.formatOffset(0), "+0.0s");
  assert.equal(trace.formatOffset(2400), "+2.4s");
  assert.equal(trace.formatOffset(48_000), "+48s");
  assert.equal(trace.formatOffset(61_000), "+1m 01s");
  assert.equal(trace.formatOffset(3_720_000), "+1h 02m");
  assert.equal(trace.formatOffset(-5), "");
  assert.equal(trace.formatDuration(20_000), "<1m");
  assert.equal(trace.formatDuration(42 * 60e3), "42m");
  assert.equal(trace.formatDuration(62 * 60e3), "1h 2m");
  assert.equal(trace.formatDuration(120 * 60e3), "2h");
});

test("session bounds prefer the session row and fall back to the steps", () => {
  const steps = fixtures.traces[ALL_KINDS_SESSION];
  const row = fixtures.sessions.find((r) => r.id === ALL_KINDS_SESSION);
  assert.deepEqual(trace.sessionBounds(steps, row), { startedAt: row.startedAt, endedAt: row.endedAt, lastTs: steps[steps.length - 1].ts });
  assert.deepEqual(trace.sessionBounds(steps, undefined), { startedAt: steps[0].ts, endedAt: steps[steps.length - 1].ts, lastTs: steps[steps.length - 1].ts });
  assert.deepEqual(trace.sessionBounds([], undefined), { startedAt: undefined, endedAt: undefined, lastTs: undefined });
  const open = fixtures.traces.unattributed;
  assert.equal(trace.sessionBounds(open, undefined).endedAt, undefined, "no session_end step -> still open");

  assert.equal(trace.firstPromptOf(steps, row), row.firstPrompt);
  assert.equal(trace.firstPromptOf(steps, undefined), "Write a migration that adds an index on orders(status) and backfills the column");
  assert.equal(trace.firstPromptOf(fixtures.traces[NEVER_CONSULTED_SESSION], undefined), undefined, "uncaptured prompt text stays undefined");
});
