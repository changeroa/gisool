import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';

const arg = name => { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1]; };
const origin = arg('--origin') ?? 'https://gisul.arkpoint.dev';
assert.equal(new URL(origin).protocol, 'https:');
const token = process.env.GISUL_CI_TOKEN ?? (arg('--token-file') ? JSON.parse(await readFile(arg('--token-file'), 'utf8')).GISUL_CI_TOKEN : undefined);
assert.ok(token, 'Provide the existing read-only CI connection');
const cases = JSON.parse(await readFile(new URL('../server/bench/search-cases.json', import.meta.url), 'utf8'));
const inventory = JSON.parse(await readFile(new URL('../docs/evidence/search-20260928/catalog-after.json', import.meta.url), 'utf8'));
const health = await (await fetch(`${origin}/healthz`)).json();
if (arg('--expected-runtime')) assert.equal(health.server_version, arg('--expected-runtime'));
let commit;
const timings = [];
async function call(name, args) {
  const started = performance.now();
  const response = await fetch(`${origin}/mcp`, { method: 'POST', redirect: 'error', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }), signal: AbortSignal.timeout(30000) });
  assert.equal(response.status, 200, `HTTP status for ${name}`);
  const rpc = await response.json();
  assert.ok(!rpc.error, JSON.stringify(rpc.error));
  assert.ok(!rpc.result.isError, JSON.stringify(rpc.result));
  const data = JSON.parse(rpc.result.content[0].text);
  assert.equal(data.origin, origin);
  if (commit) assert.equal(data.commit, commit);
  if (name === 'search_skills') timings.push(performance.now() - started);
  return data;
}
const first = await call('search_skills', { query: cases[0].query, mode: 'discovery' });
commit = first.commit;
if (arg('--expected-content')) assert.equal(commit, arg('--expected-content'));
const rows=[];
for (let i=0;i<cases.length;i+=4) {
  const batch=await Promise.allSettled(cases.slice(i,i+4).map(async c=>{
    const result=await call('search_skills',{query:c.query,mode:'discovery',commit});
    const rank=result.skills.findIndex(s=>c.expected.includes(s.name))+1;
    return {...c,rank:rank||null,found:result.skills.map(s=>s.name),total:result.totalMatches};
  }));
  for (const item of batch) { if(item.status==='rejected') throw item.reason; rows.push(item.value); }
}
let exact=0, policy=0;
for (let i=0;i<inventory.length;i+=4) {
  const batch=await Promise.allSettled(inventory.slice(i,i+4).map(async doc=>{
    const result=await call('search_skills',{query:doc.name,mode:'discovery',commit});
    assert.equal(result.skills[0].uri,doc.uri); exact++;
    assert.equal(result.skills[0].invocation,doc.automatic?'automatic':'explicit');
    if (!doc.automatic) {
      const auto=await call('search_skills',{query:doc.name,mode:'automatic',commit});
      assert.ok(!auto.skills.some(s=>s.uri===doc.uri)); policy++;
    }
  }));
  for(const item of batch) if(item.status==='rejected') throw item.reason;
}
const loaded = await call('load_skill', { uri:first.skills[0].uri, commit });
assert.ok(loaded.markdown && loaded.load_id);
const positive=rows.filter(c=>c.expected.length),negative=rows.filter(c=>!c.expected.length);
timings.sort((a,b)=>a-b);
const result={runtime:health.server_version,commit,release:first.release,executed:rows.length,exact,explicit_policy_checks:policy,
  hit_at_1:positive.filter(c=>c.rank===1).length/positive.length,hit_at_5:positive.filter(c=>c.rank).length/positive.length,
  mrr:positive.reduce((s,c)=>s+(c.rank?1/c.rank:0),0)/positive.length,
  negative_abstention:negative.filter(c=>!c.total).length/negative.length,
  http_p50_ms:timings[Math.floor(timings.length*.5)],http_p95_ms:timings[Math.floor(timings.length*.95)],http_samples:timings.length,
  latency_note:'Direct HTTP with at most four independent requests in flight; not comparable to Codex MCP tool timing.',cases:rows};
if(arg('--output')) await writeFile(arg('--output'),JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify({...result,cases:undefined},null,2));
assert.ok(result.hit_at_1>=.9 && result.hit_at_5>=.98 && result.negative_abstention===1);
assert.equal(exact,39);
