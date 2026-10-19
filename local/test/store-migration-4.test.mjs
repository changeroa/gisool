import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { PACKAGE_ROOT, distImport, makeTempDir, removeDir } from "./_helpers.mjs";
import { event, openStore } from "./helpers/store.mjs";

const { openDb } = await distImport("store/db.js");
const { createStore } = await distImport("store/index.js");
const T = 1_800_000_000_000;
const URI = "skill://local/fixture/alpha/SKILL.md";

test("v1 out-of-order history reconstructs candidates after all imported events are available", (t) => {
  const dir = makeTempDir();
  t.after(() => removeDir(dir));
  mkdirSync(join(dir, "export"));
  const out = join(dir, "export");
  writeFileSync(join(out, "gisool-export.json"), JSON.stringify({ version: 1, config: {}, roots: [], evalCases: [], aliasesOverrides: {} }));
  const old = new DatabaseSync(join(out, "history.db"));
  old.exec(readFileSync(new URL("dist/store/schema.sql", PACKAGE_ROOT), "utf8"));
  old.exec(`INSERT INTO sessions (id,runtime,started_at) VALUES ('a','codex',${T - 1000000}), ('b','codex',${T - 1000000});
    INSERT INTO events (id,ts,kind,source,session_id,attribution_method,attribution_reason,runtime,skill_uri)
    VALUES ('load',${T},'load','mcp','unattributed','none','ambiguous','codex','${URI}');
    INSERT INTO events (id,ts,kind,source,session_id,attribution_method,runtime,text)
    VALUES ('tool',${T + 1},'tool_call','otel','a','runtime_id','codex','{"server":"gisool","uri":"${URI}"}'),
      ('prompt-a',${T - 20},'prompt','hook','a','runtime_id','codex','inventory'),
      ('prompt-b',${T - 20},'prompt','hook','b','runtime_id','codex','inventory');`);
  old.close();
  const { db, store } = openStore();
  t.after(() => store.close());
  // When legacy history is imported in receipt order rather than timestamp order.
  store.importFrom(out, { merge: true });
  store.reconcileLoads({ sessionIds: ["a"], from: T, to: T + 1 });
  assert.equal(db.prepare("SELECT session_id FROM events WHERE id='load'").get().session_id, "a");
  assert.deepEqual(db.prepare("SELECT session_id FROM load_candidates ORDER BY session_id").all().map((row) => row.session_id), ["a", "b"]);
});

test("v3 retained URI proof survives upgrade, reopen, export and import with rebuilt candidate indexes", (t) => {
  const dir = makeTempDir();
  t.after(() => removeDir(dir));
  const path = join(dir, "v3.db");
  const old = new DatabaseSync(path);
  for (const file of ["schema.sql", "migrations/002_tracing.sql", "migrations/003_tracing_indexes.sql"]) {
    old.exec(readFileSync(new URL(`dist/store/${file}`, PACKAGE_ROOT), "utf8"));
  }
  old.exec(`PRAGMA user_version = 3;
    INSERT INTO sessions (id, runtime, started_at) VALUES ('a', 'codex', ${T}), ('b', 'codex', ${T});
    INSERT INTO events (id,ts,kind,source,session_id,attribution_method,runtime,skill_uri,data_json)
    VALUES ('resolved',${T + 1},'load','mcp','a','trace_handle','codex','${URI}',
      '{"attributionCandidates":["a","b"],"attributionBasis":"tool_call_uri"}');
    INSERT INTO events (id,ts,kind,source,session_id,attribution_method,attribution_reason,runtime,skill_uri)
    VALUES ('pending',${T + 2},'load','mcp','unattributed','none','ambiguous','codex','${URI}');`);
  old.close();
  let db = openDb(path);
  db.close();
  db = openDb(path);
  const source = createStore(db);
  t.after(() => source.close());
  const out = join(dir, "export");
  source.exportTo(out, { withHistory: true });
  const target = openStore();
  t.after(() => target.store.close());
  // When retained v3 history is upgraded and round-tripped into a clean store.
  target.store.importFrom(out, { merge: true });
  target.store.reconcileLoads({ from: T, to: T + 3, sessionIds: ["a", "b"] });
  const resolved = target.db.prepare("SELECT session_id, data_json FROM events WHERE id = 'resolved'").get();
  assert.equal(resolved.session_id, "a");
  assert.deepEqual(JSON.parse(resolved.data_json).attributionMatches, ["a"]);
  assert.deepEqual(target.db.prepare("SELECT load_id, session_id FROM load_candidates ORDER BY load_id, session_id").all()
    .map((row) => [row.load_id, row.session_id]), [["pending", "a"], ["pending", "b"], ["resolved", "a"], ["resolved", "b"]]);
  // A contradictory proof arriving after upgrade still removes the historical unique attribution.
  const tool = event("tool_call", T + 3, { runtime: "codex" }, { source: "otel",
    text: JSON.stringify({ server: "gisool", uri: URI }), data: { success: true } });
  target.store.append(tool, { sessionId: "b", method: "runtime_id" });
  target.store.reconcileLoads({ eventId: tool.id });
  assert.equal(target.db.prepare("SELECT session_id FROM events WHERE id = 'resolved'").get().session_id, "unattributed");
});

test("retained multiple-candidate proof stays ambiguous through export and import", (t) => {
  const dir = makeTempDir();
  t.after(() => removeDir(dir));
  const { db, store } = openStore({ storeOpts: { now: () => T + 40 * 86400000 } });
  t.after(() => store.close());
  const refs = ["a", "b"].map((runtimeSessionId) => ({ runtime: "claude-code", runtimeSessionId }));
  const ids = refs.map((ref) => store.upsertSession(ref, T));
  store.append(event("load", T, refs[0], { skillUri: URI, data: { attributionCandidates: ids } }),
    { sessionId: "unattributed", method: "none", reason: "ambiguous" });
  for (const [i, ref] of refs.entries()) store.append(event("tool_call", T + 1, ref, {
    source: "otel", text: JSON.stringify({ server: "gisool", uri: URI }), data: { success: true },
  }), { sessionId: ids[i], method: "runtime_id" });
  store.reconcileLoads();
  store.retention(30);
  const out = join(dir, "export");
  store.exportTo(out, { withHistory: true });
  const target = openStore();
  t.after(() => target.store.close());
  // When an ambiguous load loses both raw texts and is imported elsewhere.
  target.store.importFrom(out, { merge: true });
  assert.deepEqual(target.store.reconcileLoads({ sessionIds: ids }), { count: 1, uris: [URI] });
  const row = target.db.prepare("SELECT session_id, data_json FROM events WHERE kind = 'load'").get();
  assert.equal(row.session_id, "unattributed");
  assert.deepEqual(JSON.parse(row.data_json).attributionMatches.sort(), [...ids].sort());
  assert.ok(db.prepare("SELECT text FROM events").all().every((row) => row.text === null));
});
