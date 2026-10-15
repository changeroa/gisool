import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { PACKAGE_ROOT, distImport, makeTempDir, removeDir } from "./_helpers.mjs";

const { openDb } = await distImport("store/db.js");
const { createStore } = await distImport("store/index.js");

for (const version of [3, 4, 5]) test(`v${version} execution boundaries migrate as unknown and remain unknown on reopen`, (t) => {
  // Given an actual legacy database, not a new database with fabricated historical cuts.
  const dir = makeTempDir();
  t.after(() => removeDir(dir));
  const path = join(dir, "legacy.db");
  const old = new DatabaseSync(path);
  for (const file of ["schema.sql", "migrations/002_tracing.sql", "migrations/003_tracing_indexes.sql"]) {
    old.exec(readFileSync(new URL(`dist/store/${file}`, PACKAGE_ROOT), "utf8"));
  }
  if (version >= 4) old.exec(readFileSync(new URL("dist/store/migrations/004_load_reconciliation.sql", PACKAGE_ROOT), "utf8"));
  if (version === 5) old.exec(readFileSync(new URL("dist/store/migrations/005_execution_boundaries.sql", PACKAGE_ROOT), "utf8"));
  old.exec(`PRAGMA user_version = ${version};
    INSERT INTO flows (id, workspace_id, registered_ms, ended_ms) VALUES ('old', 'w', 100, 200);`);
  old.close();
  // When the registry upgrades and later reopens the file.
  for (let i = 0; i < 2; i++) {
    const db = openDb(path);
    const store = createStore(db);
    try {
      // Then schema 6 preserves history without inventing an order or an end observation.
      assert.equal(db.prepare("PRAGMA user_version").get().user_version, 6);
      const scope = store.flowEventScope("old");
      assert.equal(scope.boundary, "order_unavailable");
      assert.equal(scope.sessionEnds, null);
      assert.equal(scope.spanKeys, null);
      assert.deepEqual([scope.from, scope.to], [100, 200]);
    } finally { store.close(); }
  }
});
