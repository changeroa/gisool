import assert from "node:assert/strict";
import { test } from "node:test";
import { distImport } from "./_helpers.mjs";

const { openDb } = await distImport("store/db.js");
const { createSearchIndex, calibrate, fuse, termCoverage, DEFAULT_THRESHOLD, SEARCH_TOOL_GUIDANCE } = await distImport("search/index.js");
const { buildLexical } = await distImport("search/lexical.js");
const { FtsIndex } = await distImport("search/fts.js");

const entry = (name, extra = {}) => ({
  uri: `skill://local/test/${name}/SKILL.md`, rootId: "test", dir: name, name, description: `${name} skill`, tags: [],
  examples: [], aliasesKo: [], invocation: "automatic", bodyHead: "", digest: `d-${name}`, manifestDigest: `m-${name}`,
  resources: [], mtimeMs: 0, ...extra,
});

const ENTRIES = [
  entry("commit", { description: "Write a conventional commit message for staged changes.", aliasesKo: ["커밋 메시지", "변경 사항 요약"] }),
  entry("committer-guide", { description: "Guide for commit commit commit hygiene and commit history.", bodyHead: "commit commit commit" }),
  entry("database-query", { description: "Inspect SQL query plans and index selection for slow database access.", aliasesKo: ["느린 쿼리", "DB 조회 지연"], examples: ["find the slow query"] }),
  entry("log-inspection", { description: "Read service logs to locate failed requests and error patterns.", aliasesKo: ["서비스 로그", "오류 패턴"] }),
  entry("release-plan", { description: "Plan a release with rollback gates.", aliasesKo: ["롤백 절차"], invocation: "explicit" }),
];

function withIndex(fn, entries = ENTRIES) {
  const db = openDb(":memory:");
  try {
    const index = createSearchIndex(db);
    index.rebuild(entries);
    return fn(index, db);
  } finally {
    db.close();
  }
}

const setThreshold = (db, value) => db.prepare("INSERT INTO meta(key, value) VALUES ('search_threshold', ?)").run(String(value));

test("candidates carry scores in 0..1 and ordered 1-based ranks", () => withIndex((index) => {
  const o = index.search("slow database query and error logs", { mode: "discovery", limit: 10 });
  assert.equal(o.abstained, undefined);
  assert.ok(o.candidates.length >= 2, JSON.stringify(o.candidates));
  o.candidates.forEach((c, i) => {
    assert.equal(c.rank, i + 1);
    assert.ok(c.score > 0 && c.score <= 1, `score ${c.score}`);
    assert.ok(Array.isArray(c.matched) && c.matched.length > 0);
  });
  assert.equal(o.candidates[0].name, "database-query");
  assert.equal(typeof o.traceId, "string");
  assert.equal(typeof o.elapsedMs, "number");
}));

test("score reflects match strength: an unrelated query's top candidate scores well below a strong match", () => withIndex((index) => {
  const strong = index.search("inspect slow database query plans", { mode: "discovery", limit: 5 });
  assert.equal(strong.candidates[0]?.name, "database-query");
  assert.ok(strong.candidates[0].score > 0.8, `strong ${strong.candidates[0].score}`);

  const weak = index.search("paint a watercolor landscape of slow mountain rivers at dusk", { mode: "discovery", limit: 5 });
  assert.equal(weak.abstained, undefined, "the weak query still returns a top candidate");
  assert.equal(weak.candidates[0].rank, 1);
  assert.ok(weak.candidates[0].score < 0.6, `weak ${weak.candidates[0].score}`);
}));

test("fuse keeps RRF order while scaling the score by query-term coverage", () => {
  const lexical = [
    { uri: "a", score: 9, matched: ["slow"], anchor: 0 },
    { uri: "b", score: 5, matched: ["slow", "query", "plan"], anchor: 0 },
  ];
  const fts = [{ uri: "a", rank: 1, bm25: -2, matched: ["slow"] }, { uri: "b", rank: 2, bm25: -1, matched: ["query"] }];
  const fused = fuse(lexical, fts, ["slow", "query", "plan"]);
  assert.deepEqual(fused.map((f) => f.uri), ["a", "b"], "order is rank-derived");
  assert.ok(fused[0].score < fused[1].score, "a one-term match scores below the full match ranked under it");
  assert.equal(fused[0].coverage, 1 / 3);
  assert.equal(fused[1].coverage, 1);
  assert.equal(fuse(lexical, fts)[0].score, 1, "without query terms the score stays rank-only");
  assert.deepEqual(termCoverage(["slow", "query"], ["SLOW", "other"]), { hit: 1, total: 2 });
});

test("limit caps the candidate list", () => withIndex((index) => {
  assert.equal(index.search("slow database query and error logs", { mode: "discovery", limit: 1 }).candidates.length, 1);
}));

test("empty and whitespace queries abstain with empty_query", () => withIndex((index) => {
  for (const q of ["", "   \n\t"]) {
    const o = index.search(q, { mode: "discovery", limit: 5 });
    assert.equal(o.abstained?.reason, "empty_query");
    assert.equal(o.abstained?.hint, "Describe the task as an intent sentence");
    assert.equal(o.candidates.length, 0);
  }
}));

test("a query with no lexical or trigram overlap abstains with no_overlap", () => withIndex((index) => {
  const o = index.search("zzqx", { mode: "discovery", limit: 5 });
  assert.equal(o.abstained?.reason, "no_overlap");
  assert.equal(o.candidates.length, 0);
}));

test("a best score below meta.search_threshold abstains with below_threshold", () => withIndex((index, db) => {
  const query = "error patterns";
  const before = index.search(query, { mode: "discovery", limit: 5 });
  assert.ok(before.candidates.length > 0);
  setThreshold(db, before.candidates[0].score + 0.01);
  const o = index.search(query, { mode: "discovery", limit: 5 });
  assert.equal(o.abstained?.reason, "below_threshold");
  assert.equal(o.candidates.length, 0);
}));

test("automatic mode abstains with explicit_only when only explicit skills match", () => withIndex((index) => {
  const discovery = index.search("롤백 절차", { mode: "discovery", limit: 5 });
  assert.deepEqual(discovery.candidates.map((c) => c.name), ["release-plan"]);
  const o = index.search("롤백 절차", { mode: "automatic", limit: 5 });
  assert.equal(o.abstained?.reason, "explicit_only");
  assert.equal(o.candidates.length, 0);
}));

test("exact-name query ranks that skill first despite a stronger competing trigram hit", () => withIndex((index, db) => {
  const fts = db.prepare("SELECT uri FROM skills_fts WHERE skills_fts MATCH ? ORDER BY bm25(skills_fts, 0, 8, 2, 3, 5, 6, 1)").all('"commit"');
  assert.ok(fts[0].uri.includes("committer-guide"), "competing trigram hit outranks the exact name in FTS");
  const o = index.search("commit", { mode: "discovery", limit: 5 });
  assert.equal(o.candidates[0].name, "commit");
  assert.equal(o.candidates[0].score, 1);
  assert.ok(o.candidates.some((c) => c.name === "committer-guide"));
}));

test("Korean substring 메시지 matches the alias 커밋 메시지 through trigram recall", () => withIndex((index) => {
  const o = index.search("메시지", { mode: "discovery", limit: 5 });
  assert.equal(o.candidates[0]?.name, "commit");
  assert.ok(o.candidates[0].matched.includes("메시지"));
  const inflected = index.search("메시지를 다듬어줘", { mode: "discovery", limit: 5 });
  assert.equal(inflected.candidates[0]?.name, "commit");
}));

test("apply adds, changes, and removes skills in both channels", () => withIndex((index) => {
  index.apply({ added: [entry("interview-notes", { aliasesKo: ["인터뷰 정리"] })], changed: [], removed: [ENTRIES[0].uri] });
  assert.equal(index.search("인터뷰", { mode: "discovery", limit: 5 }).candidates[0]?.name, "interview-notes");
  const gone = index.search("커밋 메시지", { mode: "discovery", limit: 5 });
  assert.ok(!gone.candidates.some((c) => c.name === "commit"));
}));

test("calibrate sits just above the best negative score and DEFAULT_THRESHOLD is a number", () => {
  assert.equal(calibrate([0, 0]), 0);
  assert.equal(calibrate([0.3, 0.5]), 0.51);
  assert.equal(typeof DEFAULT_THRESHOLD, "number");
  assert.match(SEARCH_TOOL_GUIDANCE, /mode=discovery/);
});

// Weight pins: each case depends on one ranking constant, so changing it reorders or drops a hit.
const names = (hits, entries) => hits.map((h) => entries.find((e) => e.uri === h.uri).name);

test("lexical field weights order name > keyword > description for the same term", () => {
  const entries = [
    entry("deploy-checklist"),
    entry("release-notes", { aliasesKo: ["deploy service"] }),
    entry("ops-diary", { description: "Notes on how we deploy." }),
  ];
  assert.deepEqual(names(buildLexical(entries).search("deploy"), entries), ["deploy-checklist", "release-notes", "ops-diary"]);
});

test("lexical exact-name anchor outranks an equal-weight name match and keeps stopword-only names", () => {
  // "deploy-tool" sorts before "deploy" by uri, so without the anchor bonus the tie would put it first.
  const entries = [entry("deploy"), entry("deploy-tool")];
  const hits = buildLexical(entries).search("deploy");
  assert.deepEqual(names(hits, entries), ["deploy", "deploy-tool"]);
  assert.equal(hits[0].anchor, 2);
  // A name made only of stopwords has no scoring terms; the anchor alone must keep it.
  const stop = [entry("how-to")];
  assert.deepEqual(names(buildLexical(stop).search("how-to"), stop), ["how-to"]);
});

test("FTS ranks an aliases_ko match above the same phrase in body_head", () => {
  const db = openDb(":memory:");
  try {
    const fts = new FtsIndex(db);
    const entries = [
      entry("notes-a", { bodyHead: "배포 롤백 절차 메모" }),
      entry("notes-b", { aliasesKo: ["배포 롤백 절차"] }),
    ];
    fts.upsert(entries);
    assert.deepEqual(names(fts.search("롤백 절차"), entries), ["notes-b", "notes-a"]);
  } finally {
    db.close();
  }
});
