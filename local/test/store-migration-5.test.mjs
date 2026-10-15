import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { PACKAGE_ROOT, distImport, makeTempDir, removeDir } from "./_helpers.mjs";

const { openDb } = await distImport("store/db.js");
const { createStore } = await distImport("store/index.js");
const URI = "skill://local/fixture/retained/SKILL.md";
const migrations = ["schema.sql", "migrations/002_tracing.sql", "migrations/003_tracing_indexes.sql",
  "migrations/004_load_reconciliation.sql"];

for (const version of [1, 2, 3, 4]) test(`v${version} history imports into v5 with retained proof and legacy candidate warnings`, (t) => {
  // Given portable retained evidence and legacy candidates in each supported pre-boundary history format.
  const dir = makeTempDir();
  t.after(() => removeDir(dir));
  const out = join(dir, "export");
  mkdirSync(out);
  writeFileSync(join(out, "gisool-export.json"), JSON.stringify({
    version: 1, config: {}, roots: [], evalCases: [], aliasesOverrides: {},
  }));
  const old = new DatabaseSync(join(out, "history.db"));
  for (const file of migrations.slice(0, version)) old.exec(readFileSync(new URL(`dist/store/${file}`, PACKAGE_ROOT), "utf8"));
  old.exec(`PRAGMA user_version = ${version};
    INSERT INTO sessions (id,runtime,started_at) VALUES ('a','codex',100), ('b','codex',100);
    INSERT INTO events (id,ts,kind,source,session_id,attribution_method,runtime,skill_uri,data_json)
    VALUES ('resolved',150,'load','mcp','a','trace_handle','codex','${URI}',
      '{"attributionCandidates":["a","b"],"attributionMatches":["a"],"attributionBasis":"tool_call_uri"}');
    INSERT INTO events (id,ts,kind,source,session_id,attribution_method,attribution_reason,runtime,skill_uri)
    VALUES ('pending',160,'load','mcp','unattributed','none','ambiguous','codex','${URI}');`);
  if (version >= 2) old.exec("INSERT INTO flows (id, workspace_id, registered_ms, ended_ms) VALUES ('legacy','w',100,200)");
  old.close();
  const db = openDb(join(dir, "target.db"));
  const store = createStore(db);
  t.after(() => store.close());
  // When old history is imported into the combined schema, then exported and imported again.
  store.importFrom(out, { merge: true });
  store.exportTo(join(dir, "v5"), { withHistory: true });
  const roundDb = openDb(join(dir, "round.db"));
  const round = createStore(roundDb);
  t.after(() => round.close());
  round.importFrom(join(dir, "v5"), { merge: true });
  // Then both migration contracts remain usable, with no invented historical boundary evidence.
  assert.equal(roundDb.prepare("PRAGMA user_version").get().user_version, 5);
  assert.deepEqual(round.reconcileLoads({ sessionIds: ["a"], readOnly: true }), { count: 1, uris: [URI] });
  round.reconcileLoads({ eventId: "resolved" });
  const resolved = roundDb.prepare("SELECT session_id, data_json, text FROM events WHERE id='resolved'").get();
  assert.equal(resolved.session_id, "a");
  assert.equal(resolved.text, null);
  assert.deepEqual(JSON.parse(resolved.data_json).attributionMatches, ["a"]);
  assert.deepEqual(roundDb.prepare("SELECT session_id FROM load_candidates WHERE load_id='pending' ORDER BY session_id")
    .all().map((row) => row.session_id), ["a", "b"]);
  if (version >= 2) {
    assert.equal(round.flowEventScope("legacy").boundary, "order_unavailable");
    assert.deepEqual(round.flowUnattributedLoads("legacy", ["a"]), { count: 1, uris: [URI] });
    assert.deepEqual(round.flowUnattributedLoads("legacy", []), { count: 0, uris: [] });
  }
});
