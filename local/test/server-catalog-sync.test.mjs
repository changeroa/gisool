import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { distImport, makeSandbox, writeFixtureSkill } from "./_helpers.mjs";

const { startServer } = await distImport("server.js");

test("restarting without a root marks that root's skills removed", async () => {
  const sb = makeSandbox();
  try {
    const gisoolHome = sb.env.GISOOL_HOME;
    const a = join(sb.home, "a"), b = join(sb.home, "b");
    writeFixtureSkill(a, "keep-me");
    writeFixtureSkill(b, "drop-me");
    const base = { port: 0, captureLevel: "full", retentionDays: null, runtimes: {} };
    const first = await startServer({ ...base, roots: [{ id: "a", path: a }, { id: "b", path: b }] }, { gisoolHome, handleSignals: false });
    await first.close();
    const second = await startServer({ ...base, roots: [{ id: "a", path: a }] }, { gisoolHome, handleSignals: false });
    await second.close();
    const db = new DatabaseSync(join(gisoolHome, "gisool.db"), { readOnly: true });
    const rows = db.prepare("SELECT uri, removed_at IS NOT NULL AS removed FROM skills ORDER BY uri").all().map((r) => [r.uri, r.removed]);
    db.close();
    assert.deepEqual(rows, [["skill://local/a/keep-me/SKILL.md", 0], ["skill://local/b/drop-me/SKILL.md", 1]]);
  } finally { sb.cleanup(); }
});
