import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { Headers as MiniflareHeaders, Miniflare } from 'miniflare';
import { packRead } from '../src/pack-tools.ts';
import { packWrite } from '../src/pack-writer.ts';
import { validatePack, packUri } from '../src/pack-schema.ts';
import { manifestDigest, parseInventory } from '../src/release-reader.ts';
import { publishRelease } from '../src/release-publisher.ts';
import { readCurrent } from '../src/r2-objects.ts';
import { serveMcp } from '../src/direct.ts';
const hash = v => `sha256:${createHash('sha256').update(v).digest('hex')}`;
const uri = name => `skill://gisul/gisul/${name}/SKILL.md`;
const member = (name, phase, selection = 'required', when = name) => ({ uri: uri(name), phase, selection, when });
const definition = (name = 'backend-pack', investigator = 'backend') => ({ schema_version: 1, kind: 'skill-pack', name, display_name: name, description: `${name} review pack`, scope: 'bounded review', members: [member('scope','scope'), member(investigator,'investigate'), member('tests','investigate','when_applicable',name+' scenarios'), member('verify','verify'), member('explain','explain','when_requested')] });
async function fixture(t) {
  const runtime = new Miniflare({ telemetry:{enabled:false}, workers:[{config:{type:'worker',name:'pack-test',compatibilityDate:'2026-09-03',manifest:{mainModule:'fixture.mjs',modules:{'fixture.mjs':{type:'esm',contents:"export default {fetch(){return new Response('test')}}"}}},env:{SKILLS_BUCKET:{type:'r2',name:'SKILLS_BUCKET'}},exports:{}}}] });
  t.after(() => runtime.dispose());
  const raw = await runtime.getR2Bucket('SKILLS_BUCKET');
  const reads=[];
  const bucket = { get: (...args) => { reads.push(args[0]);return raw.get(...args); }, head:(...a)=>raw.head(...a), list:(...a)=>raw.list(...a), delete:(...a)=>raw.delete(...a), put:(k,v,o)=>raw.put(k,v,o?.onlyIf instanceof Headers ? {...o,onlyIf:new MiniflareHeaders(o.onlyIf)}:o) };
  return {bucket,reads};
}
async function stage(bucket, letter, defs = [definition(),definition('frontend-pack','client')]) {
  const commit=letter.repeat(40), release=`20261001.${letter.charCodeAt(0)}`;
  const files=[],skills=[],packs=[];
  const put=async(path,body,extra={})=>{const file={path,digest:hash(body),size:Buffer.byteLength(body),...extra};files.push(file);await bucket.put(`releases/${commit}/${path}`,body);return file;};
  for (const name of ['scope','backend','client','tests','verify','explain']) {
    const fm={name,description:`${name} ${letter}`,...(name==='explain'?{'disable-model-invocation':true}:{})};
    const md=`---\n${JSON.stringify(fm)}\n---\nBody ${letter}`;
    const f=await put(`skills/${name}/SKILL.md`,md,{uri:uri(name)});
    skills.push({uri:uri(name),frontmatter:fm,resources:[{uri:uri(name),digest:f.digest,size:f.size}]});
  }
  for (const d of defs) {const f=await put(`packs/${d.name}.json`,JSON.stringify(d));packs.push({uri:packUri(d.name),definition:d,digest:f.digest,size:f.size});}
  await put('release.json',JSON.stringify({commit,release,skills:await Promise.all(skills.map(async s=>({uri:s.uri,manifest_digest:await manifestDigest(s)})))}));
  const inventory={schema_version:1,commit,release,skills,files,packs,aliases:{}};
  const body=JSON.stringify(inventory),identity={commit,release,inventory_digest:hash(body)};
  await bucket.put(`releases/${commit}/inventory.json`,body);
  return {identity,inventory};
}
async function promote(bucket, staged, sequence) {return publishRelease(bucket,{...staged.identity,sequence,expected_etag:(await readCurrent(bucket))?.etag??null},'promote');}
const read=(bucket,name,args)=>packRead(bucket,name,args,'https://fixture','fixture-server');

test('native discovery and combined resolution are body-lazy, deduplicated, condition-preserving and pinned', async t=>{
 const f=await fixture(t), a=await stage(f.bucket,'a');await promote(f.bucket,a,1);f.reads.length=0;
 const search=await read(f.bucket,'search_packs',{query:'backend-pack',mode:'discovery'});
 assert.equal(search.packs[0].name,'backend-pack');assert.equal(search.publication_status,'published');
 assert.ok(!f.reads.some(p=>p.includes('/skills/')));
 const args={uris:['backend-pack','frontend-pack'].map(packUri),commit:a.identity.commit};
 const loaded=await read(f.bucket,'load_pack',args);
 assert.equal(loaded.composition.declared_members,10);assert.equal(loaded.composition.unique_members,6);
 assert.equal(loaded.members.filter(m=>m.phase==='scope').length,1);assert.equal(loaded.members.filter(m=>m.phase==='verify').length,1);
 assert.deepEqual(loaded.members.find(m=>m.uri===uri('tests')).requirements.map(r=>r.when),['backend-pack scenarios','frontend-pack scenarios']);
 assert.equal(loaded.members.find(m=>m.uri===uri('explain')).invocation,'explicit');assert.equal(loaded.permissions.grants_execution,false);
 assert.ok(!f.reads.some(p=>p.includes('/skills/')),'pack load must not read member bodies');
 const b=await stage(f.bucket,'b');await promote(f.bucket,b,2);
 const retained=await read(f.bucket,'load_pack',args);assert.deepEqual(retained.packs,loaded.packs);assert.deepEqual(retained.members,loaded.members);assert.equal(retained.publication_status,'verified_snapshot');
 assert.notEqual((await read(f.bucket,'load_pack',{uris:args.uris})).members[0].digest,loaded.members[0].digest);
 const page=await read(f.bucket,'search_packs',{query:'pack',limit:1,mode:'explicit'});assert.equal(page.nextOffset,1);
 assert.equal((await read(f.bucket,'search_packs',{query:'pack',limit:1,offset:1,commit:page.commit,mode:'explicit'})).packs.length,1);
});

test('invalid closure, missing required roles and corrupt pack bytes cannot replace the active release',async t=>{
 const {bucket}=await fixture(t),a=await stage(bucket,'a');await promote(bucket,a,1);
 for(const edit of [d=>d.members.push(d.members[0]),d=>d.members[0].selection='when_applicable',d=>d.members[1].uri=uri('missing'),d=>d.members[1].uri='skill://evil/gisul/backend/SKILL.md',d=>d.members[1].uri='pack://gisul/gisul/other']){
   const d=definition();edit(d);assert.throws(()=>validatePack(d,new Set(['scope','backend','tests','verify','explain'].map(uri))));
 }
 const bad=definition();bad.members[1].uri=uri('missing');const b=await stage(bucket,'b',[bad]);
 await assert.rejects(promote(bucket,b,2),/Unavailable/);
 assert.equal((await readCurrent(bucket)).value.commit,a.identity.commit);
 await assert.rejects(read(bucket,'load_pack',{uris:[packUri('backend-pack')],commit:b.identity.commit}),/incomplete/);
 const c=await stage(bucket,'c');await bucket.put(`releases/${c.identity.commit}/packs/backend-pack.json`,'corrupt');
 await assert.rejects(promote(bucket,c,3),/digest|differs|wrong-sized/);assert.equal((await readCurrent(bucket)).value.commit,a.identity.commit);
 const broken=structuredClone(a.inventory);broken.packs[0].digest=hash('bad');assert.throws(()=>parseInventory(JSON.stringify(broken),a.identity),/differs/);
});

test('combined incompatible entry roles fail and old skill-only catalogs remain readable',async t=>{
 const {bucket}=await fixture(t),d=definition('frontend-pack','client');d.members[0]=member('tests','scope');d.members=d.members.filter(m=>m.phase!=='investigate'||m.uri!==uri('tests'));
 const a=await stage(bucket,'a',[definition(),d]);await promote(bucket,a,1);
 await assert.rejects(read(bucket,'load_pack',{uris:[packUri('backend-pack'),packUri('frontend-pack')]}),/Conflicting|shared scope/);
 const b=await stage(bucket,'b',[]);delete b.inventory.packs;const body=JSON.stringify(b.inventory);b.identity.inventory_digest=hash(body);await bucket.put(`releases/${b.identity.commit}/inventory.json`,body);await promote(bucket,b,2);
 assert.equal((await read(bucket,'search_packs',{query:'review'})).totalMatches,0);
 await assert.rejects(read(bucket,'load_pack',{uris:[packUri('backend-pack')]}),/Unknown pack/);
});

function gitFixture({existing=false,missing=false,conflict=false,lost=false}={}) {
 let head='a'.repeat(40);const calls=[];const d=definition();const content=JSON.stringify(d,null,2)+'\n';
 const env={GISUL_GITHUB_TOKEN:'fixture',SKILLS_BUCKET:{get:async()=>null}};
 const git=async(path,method='GET',body)=>{calls.push({path,method,body});
 if(path==='/git/ref/heads/main')return{object:{sha:head}};
 if(path===`/git/commits/${'a'.repeat(40)}`)return{tree:{sha:'old'}};
 if(path==='/git/trees/old?recursive=1')return{tree:[...(existing?[{path:'packs/backend-pack.json',type:'blob',mode:'100644',sha:'pack'}]:[]),...d.members.filter(m=>!missing||m.phase!=='investigate').map(m=>({path:`skills/${m.uri.slice('skill://gisul/gisul/'.length)}`,type:'blob',mode:'100644',sha:m.uri.split('/').at(-2)}))]};
 if(path==='/git/blobs/pack')return{encoding:'base64',content:Buffer.from(content).toString('base64')};
 if(path.startsWith('/git/blobs/')){const name=path.split('/').at(-1);return{encoding:'base64',content:Buffer.from(`---\nname: ${name}\ndescription: Fixture\n---\nBody`).toString('base64')};}
 if(path==='/git/trees')return{sha:'new'};if(path==='/git/commits')return{sha:'b'.repeat(40)};
 if(path==='/git/refs/heads/main'){assert.equal(body.force,false);if(conflict){head='c'.repeat(40);throw Error('conflict');}head=body.sha;if(lost)throw Error('lost');return{};}
 if(path.startsWith('/actions/'))return{workflow_runs:[]};throw Error(path);};
 return{env,git,calls,d,content};
}
test('pack writes create/update exact Git bytes with stale-digest, reference and race protection',async()=>{
 const f=gitFixture();const created=await packWrite(f.env,'create_pack',{definition:f.d},f.git);assert.equal(created.status,'accepted');assert.equal(created.digest,hash(f.content));assert.equal(f.calls.find(c=>c.path==='/git/trees').body.tree[0].path,'packs/backend-pack.json');
 assert.equal((await packWrite(f.env,'get_pack_write_status',{commit:created.commit},f.git)).status,'pending');
 const update=gitFixture({existing:true});const changed={...update.d,description:'Updated description'};
 await assert.rejects(packWrite(update.env,'update_pack',{uri:packUri(update.d.name),definition:changed,expected_digest:hash('stale')},update.git),/changed since load/);assert.ok(update.calls.every(c=>c.method==='GET'));
 assert.equal((await packWrite(update.env,'update_pack',{uri:packUri(update.d.name),definition:changed,expected_digest:hash(update.content)},update.git)).status,'accepted');
 for(const options of [{existing:true},{missing:true}]){const f=gitFixture(options);await assert.rejects(packWrite(f.env,'create_pack',{definition:f.d},f.git));assert.ok(f.calls.every(c=>c.method==='GET'));}
 const conflict=gitFixture({conflict:true});await assert.rejects(packWrite(conflict.env,'create_pack',{definition:conflict.d},conflict.git),/not confirmed/);assert.equal(conflict.calls.filter(c=>c.method==='PATCH').length,1);
 const lost=gitFixture({lost:true});assert.equal((await packWrite(lost.env,'create_pack',{definition:lost.d},lost.git)).status,'accepted');
});

test('Codex MCP exposes native pack tools with reader/writer authorization and active readback',async t=>{
 const {bucket}=await fixture(t),a=await stage(bucket,'a');await promote(bucket,a,1);
 const env={SKILLS_BUCKET:bucket,GISUL_BEARER_TOKEN:'read',GISUL_WRITE_TOKEN:'write',GISUL_GITHUB_TOKEN:'fixture',GISUL_NATIVE_TOOLS:'true'};
 const rpc=async(method,params={},token='read')=>serveMcp(new Request('https://fixture/mcp',{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${token}`},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})}),env);
 const names=(await (await rpc('tools/list')).json()).result.tools.map(t=>t.name);assert.ok(names.includes('search_packs')&&names.includes('load_pack'));assert.ok(!names.includes('create_pack'));
 const writes=(await (await rpc('tools/list',{},'write')).json()).result.tools.map(t=>t.name);for(const n of ['create_pack','update_pack','get_pack_write_status'])assert.ok(writes.includes(n));
 assert.equal((await rpc('tools/call',{name:'create_pack',arguments:{definition:definition()}})).status,403);
 const response=await (await rpc('tools/call',{name:'load_pack',arguments:{uris:[packUri('backend-pack')]}})).json();assert.equal(response.result.isError,false);assert.equal(JSON.parse(response.result.content[0].text).commit,a.identity.commit);
 const published=await packWrite({...env,SKILLS_BUCKET:bucket},'get_pack_write_status',{commit:a.identity.commit},async()=>assert.fail('must use live pointer'));assert.equal(published.status,'published');
});

test('verified staged snapshots never claim active publication',async t=>{
 const {bucket}=await fixture(t),a=await stage(bucket,'a');await promote(bucket,a,1);
 const b=await stage(bucket,'b');await publishRelease(bucket,{...b.identity,sequence:2,expected_etag:(await readCurrent(bucket)).etag},'verify');
 const staged=await read(bucket,'search_packs',{query:'backend-pack',commit:b.identity.commit});
 assert.equal(staged.publication_status,'verified_snapshot');assert.equal(staged.packs[0].publication_status,'verified_snapshot');assert.equal(staged.active_commit,a.identity.commit);
 assert.equal((await read(bucket,'load_pack',{uris:[packUri('backend-pack')],commit:b.identity.commit})).publication_status,'verified_snapshot');
 await promote(bucket,b,2);assert.equal((await read(bucket,'search_packs',{query:'backend-pack',commit:b.identity.commit})).publication_status,'published');
});
