import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { parse } from 'yaml';
import { searchSkills } from '../dist/skill-search.js';

const arg = name => { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1]; };
let documents;
if (arg('--inventory')) documents = JSON.parse(await readFile(arg('--inventory'), 'utf8'));
else {
  const root = resolve(arg('--skills-root') ?? '../../arkpoint-gisul-skills/skills');
  documents = await Promise.all((await readdir(root, { withFileTypes: true })).filter(d => d.isDirectory()).map(async d => {
    const markdown = await readFile(join(root, d.name, 'SKILL.md'), 'utf8');
    const meta = parse(markdown.slice(4, markdown.indexOf('\n---', 4)));
    return { uri: `skill://gisul/gisul/${meta.name}/SKILL.md`, name: meta.name, description: meta.description, keywords: meta.keywords ?? [], automatic: meta['disable-model-invocation'] !== true, digest: 'benchmark-metadata-only' };
  }));
}
if (arg('--save-inventory')) await writeFile(arg('--save-inventory'), JSON.stringify(documents, null, 2) + '\n');
const search = arg('--implementation') ? (await import(pathToFileURL(resolve(arg('--implementation'))))).searchSkills : searchSkills;
const mode = arg('--mode') ?? 'discovery';
const cases = JSON.parse(await readFile(new URL('search-cases.json', import.meta.url), 'utf8'));
const rows = cases.map(c => {
  const found = search(documents, c.query, mode);
  const rank = found.findIndex(d => c.expected.includes(d.name)) + 1;
  return { ...c, found: found.slice(0, 5).map(d => d.name), rank: rank || null, total: found.length };
});
const positives = rows.filter(r => r.expected.length), negatives = rows.filter(r => !r.expected.length);
const exact = documents.map(d => ({ name: d.name, passed: search(documents, d.name, mode)[0]?.uri === d.uri }));
const policy = documents.filter(d => !d.automatic).map(d => ({ name: d.name, passed: !search(documents, d.name, 'automatic').some(r => r.uri === d.uri) }));
for (let i=0; i<10; i++) for (const c of cases) search(documents, c.query, mode);
const timings=[];
for (let i=0; i<20; i++) for (const c of cases) { const t=performance.now(); search(documents,c.query,mode); timings.push(performance.now()-t); }
timings.sort((a,b)=>a-b);
const cold=[];
for(let i=0;i<30;i++) {
  const uncached=documents.map(d=>({...d,digest:`${d.digest}-cold-${i}`}));
  const started=performance.now(); search(uncached,cases[i%cases.length].query,mode); cold.push(performance.now()-started);
}
cold.sort((a,b)=>a-b);
const report = {
  catalog_size: documents.length, mode, cases: cases.length,
  metrics: { hit_at_1: positives.filter(r=>r.rank===1).length/positives.length, hit_at_5: positives.filter(r=>r.rank && r.rank<=5).length/positives.length,
    mrr: positives.reduce((s,r)=>s+(r.rank ? 1/r.rank : 0),0)/positives.length, negative_abstention: negatives.filter(r=>!r.total).length/negatives.length,
    exact_name_accuracy: exact.filter(r=>r.passed).length/exact.length, invocation_policy: policy.every(r=>r.passed),
    local_p50_ms: timings[Math.floor(timings.length*.5)], local_p95_ms: timings[Math.floor(timings.length*.95)], local_samples:timings.length,
    cold_index_p95_ms:cold[Math.floor(cold.length*.95)],cold_samples:cold.length },
  cases_results: rows, exact, policy,
  limitations: 'Maintainer-authored regression cases, not an independent holdout. Local latency excludes network and agent overhead. Metadata is a benchmark fixture, never runtime routing.'
};
if(arg('--output')) await writeFile(arg('--output'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({catalog_size:report.catalog_size,cases:report.cases,metrics:report.metrics,misses:rows.filter(r=>r.expected.length ? r.rank!==1 : r.total).map(r=>({id:r.id,rank:r.rank,found:r.found}))},null,2));
if(process.argv.includes('--check') && (report.metrics.hit_at_1<.9 || report.metrics.hit_at_5<.98 || report.metrics.negative_abstention<1 || report.metrics.exact_name_accuracy<1 || !report.metrics.invocation_policy || report.metrics.local_p95_ms>20)) process.exitCode=1;
