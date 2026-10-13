import assert from "node:assert/strict";
import { test } from "node:test";
import { CATALOG, DAY, EXPECTED_STATES, HOUR, NOW, RUNTIMES, event, openStore, seedForty, seedSession, skillEntry, uri } from "./helpers/store.mjs";

function seeded() {
  const { store } = openStore();
  const ids = seedForty(store);
  return { store, ids };
}

test("sessions: 40 sessions across 3 runtimes with the adoption-state precedence counts", () => {
  const { store } = seeded();
  const rows = store.sessions({});
  assert.equal(rows.length, 40);
  assert.deepEqual(new Set(rows.map((r) => r.runtime)), new Set(RUNTIMES));
  const counts = {};
  for (const r of rows) counts[r.state] = (counts[r.state] ?? 0) + 1;
  assert.deepEqual(counts, EXPECTED_STATES);
  assert.ok(rows.every((r, i) => i === 0 || rows[i - 1].startedAt >= r.startedAt), "newest first");
  assert.equal(store.sessions({ state: ["aborted"] }).length, 2);
  assert.equal(store.sessions({ runtime: ["codex"] }).length, 13);
  assert.equal(store.sessions({ skill: [uri("release-plan")] }).length, 4);
  assert.equal(store.sessions({ q: "database-query" }).length, 6);
  const loadedRow = rows.find((r) => r.state === "loaded");
  assert.equal(loadedRow.attribution, "runtime_id");
  assert.equal(loadedRow.skills.length, 1);
  assert.match(loadedRow.firstPrompt, /^please help with/);
});

test("flow first_load: top-7 skills plus Other, min-link rule, sessionCount, >= 3 task types", () => {
  const { store } = seeded();
  const flow = store.flow({}, "first_load");
  assert.equal(flow.sessionCount, 40);
  assert.deepEqual(flow.columns, ["task_type", "skill", "state"]);
  const skillNodes = flow.nodes.filter((n) => n.column === 1);
  const regular = skillNodes.filter((n) => !n.other);
  const other = skillNodes.find((n) => n.other);
  assert.ok(regular.length <= 7, `at most 7 regular skill nodes, got ${regular.length}`);
  assert.ok(other, "Other node in skill column");
  assert.match(other.label, /^Other \(\d+\)$/);
  for (const name of ["debug-trace", "frontend-polish", "research-deep"]) assert.ok(!regular.some((n) => n.label === name), `${name} collapsed`);
  // Each session contributes exactly one path, so every column's node counts sum to the session count.
  for (const col of [0, 1, 2]) assert.equal(flow.nodes.filter((n) => n.column === col).reduce((a, n) => a + n.count, 0), 40, `column ${col}`);
  const otherIds = new Set(flow.nodes.filter((n) => n.other).map((n) => n.id));
  for (const l of flow.links) if (l.count < 2) assert.ok(otherIds.has(l.source) || otherIds.has(l.target), `weak link ${l.source}->${l.target} must touch Other`);
  // The single exposed_only release-plan session is a 1-count link, so it moves to Other; the 3 loaded sessions stay.
  assert.equal(regular.find((n) => n.label === "release-plan")?.count, 3);
  assert.ok(!flow.links.some((l) => l.target === `s:${uri("release-plan")}` && l.state === "exposed_only"));
  const taskTypes = new Set(flow.nodes.filter((n) => n.column === 0 && !n.other).map((n) => n.label));
  for (const t of ["code-review", "database", "release-deploy", "browser-automation"]) assert.ok(taskTypes.has(t), `task type ${t} in ${[...taskTypes]}`);
  const stateLabels = flow.nodes.filter((n) => n.column === 2).map((n) => n.label).sort();
  assert.deepEqual(stateLabels, Object.keys(EXPECTED_STATES).sort());
});

test("flow all_loads and top clamp", () => {
  const { store } = seeded();
  const s = store.upsertSession({ runtime: "codex", runtimeSessionId: "multi" }, NOW);
  const ref = { runtime: "codex", runtimeSessionId: "multi" };
  for (const n of ["pr-review-ko", "database-query"]) store.append(event("load", NOW + 1, ref, { skillUri: uri(n) }), { sessionId: s, method: "runtime_id" });
  const all = store.flow({}, "all_loads", 3);
  assert.equal(all.unit, "all_loads");
  assert.equal(all.sessionCount, 41);
  assert.ok(all.nodes.filter((n) => n.column === 1 && !n.other).length <= 3);
  const big = store.flow({}, "first_load", 99);
  assert.ok(big.nodes.filter((n) => n.column === 1 && !n.other).length <= 15);
});

test("heatmap totals equal the session count in Asia/Seoul and UTC, and cells match the dow/hour filter", () => {
  const { store } = seeded();
  for (const tz of ["Asia/Seoul", "UTC"]) {
    for (const bucket of [1, 2, 4]) {
      const h = store.heatmap({}, tz, 1, bucket);
      assert.equal(h.cells.length, 7 * (24 / bucket));
      assert.equal(h.rowTotals.length, 7);
      assert.equal(h.colTotals.length, 24 / bucket);
      const sum = (xs) => xs.reduce((a, n) => a + n, 0);
      assert.equal(sum(h.rowTotals), 40, `${tz} rows`);
      assert.equal(sum(h.colTotals), 40, `${tz} cols`);
      assert.equal(sum(h.cells.map((c) => c.count)), 40, `${tz} cells`);
      assert.equal(h.cells[0].dow, 1, "weekStart 1 puts Monday first");
    }
    const h2 = store.heatmap({ dow: 0, hour: 0 }, tz, 0, 2);
    assert.equal(h2.rowTotals.reduce((a, n) => a + n, 0), 40, "heatmap ignores the cell filter");
    for (const cell of h2.cells.filter((c) => c.count > 0)) {
      assert.equal(store.sessions({ dow: cell.dow, hour: cell.hour, hourSpan: 2, tz }).length, cell.count, `${tz} ${cell.dow}/${cell.hour}`);
    }
  }
  const utc = store.heatmap({}, "UTC", 0, 1).cells.find((c) => c.dow === 2 && c.hour === 12);
  const seoul = store.heatmap({}, "Asia/Seoul", 0, 1).cells.find((c) => c.dow === 2 && c.hour === 21);
  assert.ok(utc.count >= 1 && seoul.count >= 1, "NOW (Tue 12:00 UTC) is Tue 21:00 in Seoul");
});

test("skillWeek returns 8 ISO weeks and per-skill load counts", () => {
  const { store } = seeded();
  const sw = store.skillWeek({});
  assert.equal(sw.weeks.length, 8);
  assert.equal(sw.weeks[7], "2026-W42");
  assert.match(sw.weeks[0], /^2026-W35$/);
  assert.ok(sw.rows.every((r) => r.counts.length === 8));
  assert.equal(sw.rows.reduce((a, r) => a + r.counts.reduce((x, y) => x + y, 0), 0), 24);
  assert.equal(sw.rows[0].name, "pr-review-ko");
  assert.equal(store.skillWeek({ runtime: ["omo"] }).rows.reduce((a, r) => a + r.counts.reduce((x, y) => x + y, 0), 0), 8);
});

test("stats: attribution per runtime, abstain rate, unused skills, last event", () => {
  const { store } = seeded();
  store.upsertSkills([skillEntry("never-used")]);
  store.countIngest("accepted");
  store.countIngest("rejected", "payload_too_large");
  const s = store.stats();
  assert.equal(s.attributionRate["claude-code"], 1);
  assert.ok(s.attributionRate.codex < 1 && s.attributionRate.codex > 0);
  assert.equal(s.attributionRate.gemini, null, "no MCP events is no data, not 0%");
  assert.deepEqual(s.unattributed, { searches: 0, loads: 0 }, "the seeded unattributed read_file is neither a search nor a load");
  assert.equal(s.abstainRate, 5 / 37);
  assert.ok(s.unusedSkills.includes(uri("never-used")));
  assert.ok(!s.unusedSkills.includes(uri("pr-review-ko")));
  assert.equal(s.lastEventTs, NOW + 3000);
  assert.ok(s.lastEventByRuntime.codex > 0);
  assert.deepEqual(s.ingest, { accepted: 1, rejected: 1, dropped: 0, lastError: { ts: NOW, code: "payload_too_large" } });
});

test("stats: unattributed MCP searches and loads honour the time range and runtime filter; 0% differs from no data", () => {
  const { store } = seeded();
  const none = { sessionId: "unattributed", method: "none", reason: "no_session" };
  store.append(event("search", NOW - 2 * HOUR, { runtime: "openclaw", clientName: "openclaw" }, { data: { candidates: [] } }), none);
  store.append(event("search", NOW - 30 * DAY, { runtime: "openclaw" }, { data: { candidates: [] } }), none);
  store.append(event("load", NOW - HOUR, { runtime: "openclaw" }, { skillUri: uri("pr-review-ko") }), none);
  store.append(event("load", NOW - HOUR, { runtime: "codex" }, { skillUri: uri("pr-review-ko") }), none);
  store.append(event("search", NOW - HOUR, { runtime: "gemini" }, { source: "hook", data: { candidates: [] } }), none);
  assert.deepEqual(store.stats().unattributed, { searches: 2, loads: 2 }, "hook-sourced events are not MCP activity");
  assert.deepEqual(store.stats({ from: NOW - DAY, to: NOW }).unattributed, { searches: 1, loads: 2 });
  assert.deepEqual(store.stats({ from: NOW - DAY, runtime: ["openclaw"] }).unattributed, { searches: 1, loads: 1 });
  assert.deepEqual(store.stats({ to: NOW - 40 * DAY }).unattributed, { searches: 0, loads: 0 });
  const rate = store.stats().attributionRate;
  assert.equal(rate.openclaw, 0, "MCP events with none attributed is 0%");
  assert.equal(rate.gemini, null, "hook-only runtime has no MCP data");
  assert.equal(rate.cursor, null);
});

test("trace: ordered steps with prompt, search candidates (chosen), load digest, error", () => {
  const { store } = openStore();
  store.upsertSkills(CATALOG);
  const sid = seedSession(store, { runtime: "codex", startedAt: NOW, kind: "loaded", skill: "pr-review-ko", key: "t1", prompt: "x".repeat(300) });
  const steps = store.trace(sid);
  assert.deepEqual(steps.map((s) => s.kind), ["session_start", "prompt", "search", "load"]);
  assert.equal(steps[1].summary.length, 200);
  const search = steps[2].detail;
  assert.deepEqual(search.chosen, [uri("pr-review-ko")]);
  assert.equal(search.candidates.find((c) => c.uri === uri("pr-review-ko")).chosen, true);
  assert.equal(search.candidates.find((c) => c.uri === uri("docs-writer")).chosen, false);
  assert.equal(steps[3].detail.manifestDigest, "sha256:manifest-pr-review-ko-0123456789");
  assert.match(steps[3].summary, /@manifest-pr-$/);
  const aborted = seedSession(store, { runtime: "codex", startedAt: NOW, kind: "aborted", key: "t2", prompt: "p" });
  const err = store.trace(aborted).at(-1);
  assert.deepEqual(err.detail, { kind: "error", code: "tool_failed", message: "boom" });
});

test("writes: session upsert key, openSessions, reattribute, tool_use_id lookup, loads, traceSession, eval cases", () => {
  const { store } = openStore();
  const a = store.upsertSession({ runtime: "codex", conversationId: "thread-1" }, NOW);
  assert.equal(store.upsertSession({ runtime: "codex", conversationId: "thread-1", cwd: "/w" }, NOW - 5), a);
  assert.notEqual(store.upsertSession({ runtime: "claude-code", conversationId: "thread-1" }, NOW), a);
  const ref = { runtime: "codex", conversationId: "thread-1" };
  store.append(event("search", NOW + 10, ref, { toolUseId: "tu-1", traceId: "tr-9", data: { candidates: [] } }), { sessionId: "unattributed", method: "none", reason: "ambiguous" });
  const evId = store.findEventByToolUseId("tu-1");
  assert.ok(evId);
  assert.equal(store.traceSession("tr-9"), undefined);
  store.reattribute(evId, a, "vendor_meta");
  assert.equal(store.traceSession("tr-9"), a);
  const open = store.openSessions("codex", NOW);
  assert.deepEqual(open.map((o) => [o.id, o.startedAt, o.lastActivityAt, o.ref.cwd]), [[a, NOW - 5, NOW + 10, "/w"]]);
  store.putLoad({ loadId: "L1", uri: uri("x"), manifestDigest: "m", resources: [{ uri: "r", digest: "d", size: 1 }] });
  assert.deepEqual(store.getLoad("L1"), { uri: uri("x"), manifestDigest: "m", resources: [{ uri: "r", digest: "d", size: 1 }] });
  assert.equal(store.latestLoad(uri("x")), "L1");
  store.addEvalCase({ query: "q1", expectedUri: uri("x") });
  store.addEvalCase({ query: "q2" });
  assert.deepEqual(store.evalCases(), [{ query: "q1", expectedUri: uri("x") }, { query: "q2" }]);
  store.upsertSkills([skillEntry("gone")]);
  store.markRemoved([uri("gone")]);
  assert.ok(!store.stats().unusedSkills.includes(uri("gone")));
});
