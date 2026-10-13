import { readFile, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { openDb } from '../dist/store/db.js';
import { DEFAULT_THRESHOLD, calibrate, createSearchIndex } from '../dist/search/index.js';

const arg = name => { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1]; };
const check = process.argv.includes('--check');
const json = async name => JSON.parse(await readFile(new URL(name, import.meta.url), 'utf8'));
const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];

const catalog = await json('catalog.json');
const entries = catalog.map(d => ({
  uri: d.uri, rootId: 'fixture', dir: d.name, name: d.name, description: d.description, tags: [],
  examples: d.examples ?? [], aliasesKo: [...(d.keywords ?? []), ...(d.aliases_ko ?? [])],
  invocation: d.automatic ? 'automatic' : 'explicit', bodyHead: '', digest: d.digest, manifestDigest: d.digest, resources: [], mtimeMs: 0,
}));
const cases = await json('search-cases.json');
const paraphrases = await json('paraphrase-cases.json');
const realLog = await json('real-log-cases.json');
const mode = arg('--mode') ?? 'discovery';
const LIMIT = 10;

const db = openDb(':memory:');
const index = createSearchIndex(db);
index.rebuild(entries);
const setThreshold = value => value === undefined
  ? db.prepare("DELETE FROM meta WHERE key = 'search_threshold'").run()
  : db.prepare("INSERT INTO meta(key, value) VALUES ('search_threshold', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(value));
const search = (query, m = mode) => index.search(query, { mode: m, limit: LIMIT });

// Calibration: with no threshold, the best fused score of every negative sets T.
setThreshold(0);
const negatives = cases.filter(c => !c.expected.length);
const negativeBest = negatives.map(c => search(c.query).candidates[0]?.score ?? 0);
const calibrated = calibrate(negativeBest);
const thresholdCurrent = calibrated === DEFAULT_THRESHOLD;
if (!check && !thresholdCurrent) {
  const src = new URL('../src/search/fusion.ts', import.meta.url);
  const text = await readFile(src, 'utf8');
  await writeFile(src, text.replace(/export const DEFAULT_THRESHOLD = [^;]+;/, `export const DEFAULT_THRESHOLD = ${calibrated};`));
  console.error(`DEFAULT_THRESHOLD ${DEFAULT_THRESHOLD} -> ${calibrated} written to src/search/fusion.ts; rebuild before --check`);
}
// Gate with the shipped default when it is current, otherwise with the calibrated value via meta override.
setThreshold(thresholdCurrent ? undefined : calibrated);

const rankOf = (outcome, expected) => (outcome.candidates.findIndex(c => expected.includes(c.name)) + 1) || null;
const rows = cases.map(c => {
  const o = search(c.query);
  return { id: c.id, query: c.query, expected: c.expected, rank: rankOf(o, c.expected), found: o.candidates.slice(0, 5).map(x => `${x.name}:${x.score}`), total: o.candidates.length, abstained: o.abstained?.reason ?? null };
});
const positives = rows.filter(r => r.expected.length), negativeRows = rows.filter(r => !r.expected.length);
const paraRows = paraphrases.map(c => {
  const o = search(c.query);
  return { id: c.id, query: c.query, expected: c.expected, rank: rankOf(o, c.expected), found: o.candidates.slice(0, 5).map(x => `${x.name}:${x.score}`), abstained: o.abstained?.reason ?? null };
});
const realRows = realLog.map(c => {
  const o = search(c.query);
  return { id: c.id, query: c.query, found: o.candidates.slice(0, 5).map(x => `${x.name}:${x.score}`), abstained: o.abstained?.reason ?? null };
});
const exact = entries.map(e => ({ name: e.name, passed: search(e.name).candidates[0]?.uri === e.uri }));
const policy = entries.filter(e => e.invocation === 'explicit').map(e => {
  const o = search(e.name, 'automatic');
  return { name: e.name, passed: !o.candidates.some(c => c.uri === e.uri), abstained: o.abstained?.reason ?? null };
});

const queries = [...cases, ...paraphrases].map(c => c.query);
for (let i = 0; i < 10; i++) for (const q of queries) search(q);
const timings = [];
for (let i = 0; i < 20; i++) for (const q of queries) { const t = performance.now(); search(q); timings.push(performance.now() - t); }
timings.sort((a, b) => a - b);
const cold = [];
for (let i = 0; i < 30; i++) { const t = performance.now(); index.rebuild(entries); search(queries[i % queries.length]); cold.push(performance.now() - t); }
cold.sort((a, b) => a - b);

const metrics = {
  hit_at_1: positives.filter(r => r.rank === 1).length / positives.length,
  hit_at_5: positives.filter(r => r.rank && r.rank <= 5).length / positives.length,
  mrr: positives.reduce((s, r) => s + (r.rank ? 1 / r.rank : 0), 0) / positives.length,
  negative_abstention: negativeRows.filter(r => !r.total).length / negativeRows.length,
  exact_name_accuracy: exact.filter(r => r.passed).length / exact.length,
  invocation_policy: policy.every(r => r.passed),
  paraphrase_hit_at_3: paraRows.filter(r => r.rank && r.rank <= 3).length / paraRows.length,
  calibrated_threshold: calibrated, default_threshold: DEFAULT_THRESHOLD, threshold_current: thresholdCurrent,
  local_p50_ms: pct(timings, .5), local_p95_ms: pct(timings, .95), local_samples: timings.length,
  cold_index_p95_ms: pct(cold, .95), cold_samples: cold.length,
};
const gates = {
  hit_at_1: metrics.hit_at_1 >= .9, hit_at_5: metrics.hit_at_5 >= .98, negative_abstention: metrics.negative_abstention === 1,
  exact_name_accuracy: metrics.exact_name_accuracy === 1, invocation_policy: metrics.invocation_policy,
  paraphrase_hit_at_3: metrics.paraphrase_hit_at_3 >= .75, warm_p95_ms: metrics.local_p95_ms <= 20, threshold_current: thresholdCurrent,
};
const report = {
  catalog_size: entries.length, mode, cases: cases.length, paraphrase_cases: paraphrases.length, real_log_cases: realLog.length,
  metrics, gates, negative_best_scores: negativeBest, cases_results: rows, paraphrase_results: paraRows, real_log_smoke: realRows, exact, policy,
  limitations: 'Maintainer-authored regression cases over hand-authored aliases, not an independent holdout. The paraphrase gate measures alias coverage, not ranker quality; use `gisool eval` on captured prompts for real quality. Local latency excludes MCP and agent overhead.',
};
db.close();
if (arg('--output')) await writeFile(arg('--output'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({
  catalog_size: report.catalog_size, cases: report.cases, metrics, gates,
  misses: [...rows.filter(r => r.expected.length ? r.rank !== 1 : r.total), ...paraRows.filter(r => !r.rank || r.rank > 3)].map(r => ({ id: r.id, rank: r.rank, found: r.found })),
  real_log_smoke: realRows,
}, null, 2));
if (check && !Object.values(gates).every(Boolean)) process.exitCode = 1;
