import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { PACKAGE_ROOT } from "./_helpers.mjs";

// The dashboard ships as one esbuild bundle, so state.ts is bundled the same way here instead of imported from dist.
async function loadState() {
  const result = await build({
    entryPoints: [fileURLToPath(new URL("dashboard/state.ts", PACKAGE_ROOT))],
    bundle: true,
    write: false,
    format: "esm",
    platform: "neutral",
    target: "es2022",
    logLevel: "silent",
  });
  const code = result.outputFiles[0].text;
  return import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
}

const state = await loadState();
const { parseFilter, serializeFilter, parseHash, buildHash, withoutFilterKey, isEmptyFilter, matchesFilter, skillName, FILTER_KEYS } = state;

const SKILL_A = "skill://local/agents/pr-review-ko/SKILL.md";
const SKILL_B = "skill://local/claude/db migration/SKILL.md";

const FULL_FILTER = {
  from: 1791500000000,
  to: 1791800000000,
  runtime: ["codex", "claude-code"],
  skill: [SKILL_A, SKILL_B],
  state: ["loaded", "exposed_only"],
  dow: 1,
  hour: 9,
  hourSpan: 2,
  q: "주문 테이블 & status=pending",
};

test("FILTER_KEYS covers every Filter field exactly once", () => {
  assert.deepEqual([...FILTER_KEYS].sort(), ["dow", "from", "hour", "hourSpan", "q", "runtime", "skill", "state", "to"]);
});

test("every Filter field round-trips through serialize -> parse", () => {
  for (const key of FILTER_KEYS) {
    const single = { [key]: FULL_FILTER[key] };
    assert.deepEqual(parseFilter(serializeFilter(single)), single, `field ${key}`);
  }
  assert.deepEqual(parseFilter(serializeFilter(FULL_FILTER)), FULL_FILTER);
});

test("serialize is canonical: parse -> serialize returns the same string and keeps FILTER_KEYS order", () => {
  const text = serializeFilter(FULL_FILTER);
  assert.equal(serializeFilter(parseFilter(text)), text);
  const keys = text.split("&").map((pair) => pair.slice(0, pair.indexOf("=")));
  assert.deepEqual(keys, [...FILTER_KEYS]);
  assert.match(text, /^from=1791500000000&to=1791800000000&runtime=codex,claude-code&skill=skill:\/\/local\/agents\/pr-review-ko\/SKILL\.md,/);
  assert.ok(!text.includes(" ") && !text.includes("&q=주문"), "values are percent-encoded");
});

test("parse accepts URLSearchParams input and the same query string the server receives", () => {
  const params = new URLSearchParams();
  params.set("runtime", "codex,gemini");
  params.set("skill", `${SKILL_A},${SKILL_B}`);
  params.set("q", "DB 조회가 느려요");
  params.set("hour", "22");
  const parsed = parseFilter(params);
  assert.deepEqual(parsed, { runtime: ["codex", "gemini"], skill: [SKILL_A, SKILL_B], hour: 22, q: "DB 조회가 느려요" });
  assert.deepEqual(parseFilter(`?${params.toString()}`), parsed, "leading ? is tolerated");
  assert.deepEqual(parseFilter("q=a+b"), { q: "a b" }, "plus decodes as space");
});

test("invalid or unknown values are dropped instead of poisoning the filter", () => {
  assert.deepEqual(parseFilter("runtime=codex,nope&state=loaded,bogus&dow=7&hour=24&hourSpan=0&from=abc&to=-5&q=%20%20&zzz=1"), {
    runtime: ["codex"],
    state: ["loaded"],
  });
  assert.deepEqual(parseFilter(""), {});
  assert.deepEqual(parseFilter("runtime=,,"), {});
  assert.deepEqual(parseFilter("runtime=codex,codex"), { runtime: ["codex"] }, "duplicates collapse");
  assert.equal(serializeFilter({}), "");
  assert.equal(serializeFilter({ runtime: [], q: "   ", skill: undefined }), "");
});

test("hash routes carry the view, the session id, and the filter", () => {
  for (const hash of ["", "#", "#/", "#/sessions", "#/unknown-view"]) {
    assert.deepEqual(parseHash(hash), { view: "sessions", filter: {} }, `hash "${hash}"`);
  }
  assert.deepEqual(parseHash("#/flow?runtime=codex"), { view: "flow", filter: { runtime: ["codex"] } });
  assert.deepEqual(parseHash("#/heatmap?dow=3&hour=14&hourSpan=4"), { view: "heatmap", filter: { dow: 3, hour: 14, hourSpan: 4 } });
  assert.deepEqual(parseHash("#/sessions/ses_01?q=review"), { view: "trace", sessionId: "ses_01", filter: { q: "review" } });
  assert.deepEqual(parseHash("#/sessions/a%2Fb"), { view: "trace", sessionId: "a/b", filter: {} });
});

test("buildHash -> parseHash round-trips every view and keeps the filter query shareable", () => {
  const routes = [
    { view: "sessions", filter: {} },
    { view: "sessions", filter: FULL_FILTER },
    { view: "trace", sessionId: "ses_abc/1", filter: { runtime: ["gajae"] } },
    { view: "flow", filter: { skill: [SKILL_A] } },
    { view: "heatmap", filter: { dow: 0, hour: 0, hourSpan: 1 } },
  ];
  for (const route of routes) {
    const hash = buildHash(route);
    assert.ok(hash.startsWith("#/"), hash);
    assert.deepEqual(parseHash(hash), route, hash);
  }
  assert.equal(buildHash({ view: "sessions", filter: {} }), "#/sessions");
  assert.equal(buildHash({ view: "trace", sessionId: "ses_1", filter: { q: "x" } }), "#/sessions/ses_1?q=x");
});

test("withoutFilterKey removes one field and hourSpan follows hour", () => {
  const { q, ...rest } = FULL_FILTER;
  assert.ok(q);
  assert.deepEqual(withoutFilterKey(FULL_FILTER, "q"), rest);
  assert.deepEqual(withoutFilterKey({ dow: 1, hour: 9, hourSpan: 2 }, "hour"), { dow: 1 });
  assert.equal(isEmptyFilter({}), true);
  assert.equal(isEmptyFilter({ q: "x" }), false);
});

test("skillName takes the directory segment of a skill URI", () => {
  assert.equal(skillName(SKILL_A), "pr-review-ko");
  assert.equal(skillName(SKILL_B), "db migration");
  assert.equal(skillName("not-a-uri"), "not-a-uri");
});

test("matchesFilter applies every field client-side", () => {
  const started = new Date(2026, 9, 12, 9, 30).getTime();
  const row = { id: "ses_1", runtime: "codex", startedAt: started, endedAt: started + 60e3, firstPrompt: "주문 테이블에 상태 컬럼 추가", skills: [SKILL_A], state: "loaded", attribution: "vendor_meta" };
  assert.equal(matchesFilter(row, {}), true);
  assert.equal(matchesFilter(row, { runtime: ["codex"], state: ["loaded"], skill: [SKILL_A] }), true);
  assert.equal(matchesFilter(row, { runtime: ["gemini"] }), false);
  assert.equal(matchesFilter(row, { state: ["no_match"] }), false);
  assert.equal(matchesFilter(row, { skill: [SKILL_B] }), false);
  assert.equal(matchesFilter(row, { from: started + 1 }), false);
  assert.equal(matchesFilter(row, { to: started - 1 }), false);
  assert.equal(matchesFilter(row, { from: started, to: started }), true);
  assert.equal(matchesFilter(row, { dow: new Date(started).getDay() }), true);
  assert.equal(matchesFilter(row, { dow: (new Date(started).getDay() + 1) % 7 }), false);
  assert.equal(matchesFilter(row, { hour: 9 }), true);
  assert.equal(matchesFilter(row, { hour: 8, hourSpan: 2 }), true);
  assert.equal(matchesFilter(row, { hour: 10 }), false);
  assert.equal(matchesFilter(row, { q: "상태 컬럼" }), true);
  assert.equal(matchesFilter(row, { q: "pr-review" }), true, "skill names are searchable");
  assert.equal(matchesFilter(row, { q: "terraform" }), false);
});
