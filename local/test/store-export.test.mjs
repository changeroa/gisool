import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { makeTempDir, removeDir } from "./_helpers.mjs";
import { openStore, seedForty, uri } from "./helpers/store.mjs";

const FAKE_HOME = "/Users/gisool-tester";

function sourceStore(base) {
  const gisoolHome = join(base, "a-home");
  mkdirSync(join(gisoolHome, "backups"), { recursive: true });
  writeFileSync(join(gisoolHome, "backups", "config.json.bak"), "{\"secret\":true}");
  writeFileSync(join(gisoolHome, "config.json"), JSON.stringify({
    port: 8800, captureLevel: "redacted", retentionDays: 90, token: "should-never-leave",
    roots: [{ id: "agents", path: `${FAKE_HOME}/.agents/skills` }, { id: "work", path: `${FAKE_HOME}/work/skills` }], runtimes: { codex: { enabled: true } },
  }));
  const { db, store } = openStore({ path: join(gisoolHome, "gisool.db"), storeOpts: { home: FAKE_HOME, gisoolHome } });
  seedForty(store);
  store.addEvalCase({ query: "PR 리뷰해줘", expectedUri: uri("pr-review-ko"), fromTraceId: "trace-s0" });
  store.addEvalCase({ query: "디비 쿼리", expectedUri: uri("database-query") });
  store.addEvalCase({ query: "no expectation" });
  db.prepare("INSERT INTO meta(key, value) VALUES ('aliases_overrides', ?)").run(JSON.stringify({ [uri("pr-review-ko")]: ["코드 리뷰"] }));
  return { db, store, gisoolHome };
}

function targetStore(base, name, configJson) {
  const gisoolHome = join(base, name);
  if (configJson) {
    mkdirSync(gisoolHome, { recursive: true });
    writeFileSync(join(gisoolHome, "config.json"), JSON.stringify(configJson));
  }
  const { db, store } = openStore({ storeOpts: { home: FAKE_HOME, gisoolHome } });
  return { db, store, gisoolHome };
}

const count = (db, table) => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;

test("export without history writes only the portable JSON: no token, no backups, no absolute /Users/ paths", () => {
  const base = makeTempDir();
  try {
    const a = sourceStore(base);
    const out = join(base, "out");
    a.store.exportTo(out, { withHistory: false });
    assert.deepEqual(readdirSync(out), ["gisool-export.json"]);
    const raw = readFileSync(join(out, "gisool-export.json"), "utf8");
    assert.ok(!raw.includes("/Users/"), raw);
    assert.ok(!raw.includes("should-never-leave"));
    assert.ok(!raw.includes("backups") && !raw.includes("secret"));
    const doc = JSON.parse(raw);
    assert.equal(doc.version, 1);
    assert.deepEqual(doc.roots, [{ id: "agents", path: "~/.agents/skills" }, { id: "work", path: "~/work/skills" }]);
    assert.deepEqual(doc.config, { port: 8800, captureLevel: "redacted", retentionDays: 90, runtimes: { codex: { enabled: true } } });
    assert.equal(doc.evalCases.length, 3);
    assert.deepEqual(doc.aliasesOverrides, { [uri("pr-review-ko")]: ["코드 리뷰"] });
  } finally {
    removeDir(base);
  }
});

test("round trip without history into a fresh DB: eval cases, roots and new config keys added, existing keys kept, no sessions", () => {
  const base = makeTempDir();
  try {
    const a = sourceStore(base);
    const out = join(base, "out");
    a.store.exportTo(out, { withHistory: false });
    const b = targetStore(base, "b-home", { port: 9999, roots: [{ id: "agents", path: "~/.agents/skills" }] });
    const before = readFileSync(join(b.gisoolHome, "config.json"), "utf8");
    const dry = b.store.importFrom(out, { merge: false });
    assert.equal(dry.details.evalCases.added, 3);
    assert.equal(count(b.db, "eval_cases"), 0, "dry run writes nothing");
    assert.equal(readFileSync(join(b.gisoolHome, "config.json"), "utf8"), before);
    const res = b.store.importFrom(out, { merge: true });
    assert.equal(b.store.evalCases().length, 3);
    assert.deepEqual(res.details.roots, { added: ["work"], skipped: ["agents"] });
    assert.deepEqual(res.details.configKeys, { added: ["captureLevel", "retentionDays", "runtimes"], kept: ["port"] });
    assert.equal(res.details.history, null);
    assert.equal(res.added, 3 + 1 + 3 + 1);
    const cfg = JSON.parse(readFileSync(join(b.gisoolHome, "config.json"), "utf8"));
    assert.equal(cfg.port, 9999, "existing key never overwritten");
    assert.equal(cfg.captureLevel, "redacted");
    assert.deepEqual(cfg.roots.map((r) => r.id), ["agents", "work"]);
    assert.equal(cfg.roots[1].path, "~/work/skills");
    assert.equal(count(b.db, "sessions"), 0);
    const again = b.store.importFrom(out, { merge: true });
    assert.equal(again.details.evalCases.added, 0);
    assert.equal(b.store.evalCases().length, 3, "re-import adds no duplicates");
  } finally {
    removeDir(base);
  }
});

test("export with history uses VACUUM INTO and import ATTACHes history.db, inserting only missing ids", () => {
  const base = makeTempDir();
  try {
    const a = sourceStore(base);
    const out = join(base, "out");
    a.store.exportTo(out, { withHistory: true });
    assert.deepEqual(readdirSync(out).sort(), ["gisool-export.json", "history.db"]);
    assert.ok(!readFileSync(join(out, "gisool-export.json"), "utf8").includes("/Users/"));
    const c = targetStore(base, "c-home");
    const res = c.store.importFrom(out, { merge: true });
    assert.equal(count(c.db, "sessions"), count(a.db, "sessions"));
    assert.equal(count(c.db, "events"), count(a.db, "events"));
    assert.equal(count(c.db, "loads"), count(a.db, "loads"));
    assert.equal(res.details.history.sessions, 40);
    assert.equal(c.store.sessions({}).length, 40);
    assert.equal(c.db.prepare("SELECT COUNT(*) AS n FROM pragma_database_list WHERE name = 'hist'").get().n, 0, "history detached");
    const cfg = JSON.parse(readFileSync(join(c.gisoolHome, "config.json"), "utf8"));
    assert.ok(cfg.roots.some((r) => r.id === "work"), "fresh home starts from default roots plus imported ones");
    assert.ok(cfg.roots.some((r) => r.id === "claude"));
    const again = c.store.importFrom(out, { merge: true });
    assert.deepEqual([again.details.history.sessions, again.details.history.events, again.details.history.loads], [0, 0, 0]);
    assert.ok(again.skipped >= count(a.db, "events"));
    assert.equal(count(c.db, "events"), count(a.db, "events"));
    a.store.exportTo(out, { withHistory: false });
    assert.ok(!existsSync(join(out, "history.db")), "a later export without history removes the stale history.db");
  } finally {
    removeDir(base);
  }
});

test("import rejects version 2 with unsupported_export_version and changes nothing", () => {
  const base = makeTempDir();
  try {
    const out = join(base, "out");
    mkdirSync(out);
    writeFileSync(join(out, "gisool-export.json"), JSON.stringify({ version: 2, config: { port: 1 }, roots: [{ id: "x", path: "~/x" }], evalCases: [{ query: "q" }], aliasesOverrides: {} }));
    const t = targetStore(base, "t-home", { port: 9999 });
    const before = readFileSync(join(t.gisoolHome, "config.json"), "utf8");
    assert.throws(() => t.store.importFrom(out, { merge: true }), (e) => e.code === "unsupported_export_version");
    assert.equal(count(t.db, "eval_cases"), 0);
    assert.equal(readFileSync(join(t.gisoolHome, "config.json"), "utf8"), before);
    assert.throws(() => t.store.importFrom(join(base, "missing"), { merge: true }), (e) => e.code === "no_export_found");
  } finally {
    removeDir(base);
  }
});
