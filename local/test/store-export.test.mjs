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
    assert.equal(res.details.history.tables.sessions, 40);
    assert.equal(c.store.sessions({}).length, 40);
    assert.equal(c.db.prepare("SELECT COUNT(*) AS n FROM pragma_database_list WHERE name = 'hist'").get().n, 0, "history detached");
    const cfg = JSON.parse(readFileSync(join(c.gisoolHome, "config.json"), "utf8"));
    assert.ok(cfg.roots.some((r) => r.id === "work"), "fresh home starts from default roots plus imported ones");
    assert.ok(cfg.roots.some((r) => r.id === "claude"));
    const again = c.store.importFrom(out, { merge: true });
    assert.deepEqual([again.details.history.tables.sessions, again.details.history.tables.events, again.details.history.tables.loads], [0, 0, 0]);
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

test("history merge treats a record both stores ingested under different ids as already present", () => {
  const base = makeTempDir();
  try {
    // Given the same OTLP record stored by two installations, each under its own event id.
    const a = targetStore(base, "a-home");
    const b = targetStore(base, "b-home");
    const ref = { runtime: "codex", conversationId: "conversation" };
    for (const [side, id] of [[a, "a-event"], [b, "b-event"]]) {
      const sessionId = side.store.upsertSession(ref, 900);
      assert.equal(side.store.append({ id, ts: 1000, kind: "llm_call", source: "otel", ref, data: {}, sourceKey: "otlp:record" },
        { sessionId, method: "runtime_id" }), true);
    }
    const out = join(base, "out");
    a.store.exportTo(out, { withHistory: true });
    // When b previews and then merges a's history.
    const preview = b.store.importFrom(out, { merge: false });
    const merged = b.store.importFrom(out, { merge: true });
    // Then neither counts the replay as new, and b keeps exactly its own copy.
    assert.deepEqual([preview.details.history.tables.events, merged.details.history.tables.events], [0, 0]);
    assert.deepEqual(b.db.prepare("SELECT id FROM events WHERE source_key = 'otlp:record'").all().map((r) => r.id), ["b-event"]);
  } finally {
    removeDir(base);
  }
});

test("history merge reuses an identical workflow spec version and refuses a different one", () => {
  const base = makeTempDir();
  try {
    // Given a flow recorded against a spec that other installations registered independently, once identically and once not.
    const spec = { name: "ship", steps: [{ id: "build", skills: ["programming"], together: false, expectTools: [] }] };
    const a = targetStore(base, "a-home");
    const { flow } = a.store.createFlow({ workspaceId: "w", specId: a.store.putWorkflowSpec(spec).row.id });
    const out = join(base, "out");
    a.store.exportTo(out, { withHistory: true });
    const same = targetStore(base, "same-home");
    const local = same.store.putWorkflowSpec(spec).row;
    const other = targetStore(base, "other-home");
    other.store.putWorkflowSpec({ ...spec, steps: [{ id: "review", skills: ["review-work"], together: false, expectTools: [] }] });
    // When each merges that history.
    same.store.importFrom(out, { merge: true });
    // Then the identical version keeps its local id and the imported flow points at it ...
    assert.deepEqual(same.db.prepare("SELECT id FROM workflow_specs").all().map((r) => r.id), [local.id]);
    assert.equal(same.db.prepare("SELECT spec_id FROM flows WHERE id = ?").get(flow.id).spec_id, local.id);
    // ... while a different body under the same name and version stops the import before any change.
    assert.throws(() => other.store.importFrom(out, { merge: false }), (e) => e.code === "history_spec_conflict");
    assert.throws(() => other.store.importFrom(out, { merge: true }), (e) => e.code === "history_spec_conflict");
    assert.deepEqual([count(other.db, "flows"), count(other.db, "sessions"), count(other.db, "workflow_specs")], [0, 0, 1]);
  } finally {
    removeDir(base);
  }
});
