import assert from "node:assert/strict";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { distImport, makeSandbox, makeTempDir, removeDir } from "./_helpers.mjs";
import { capture, makeDeps } from "./helpers/cli-export-import.mjs";
import { seedForty, uri } from "./helpers/store.mjs";

const { runExport, runImport } = await distImport("cli/export-import.js");

function seedHome(sb, config) {
  mkdirSync(join(sb.home, ".gisool"), { recursive: true });
  writeFileSync(join(sb.home, ".gisool", "config.json"), JSON.stringify(config));
  return makeDeps(sb.home, sb.env);
}

test("export from A, import into B: dry-run changes nothing, apply adds eval cases and keeps existing config", async () => {
  const a = makeSandbox(), b = makeSandbox(), out = makeTempDir();
  try {
    const depsA = seedHome(a, { port: 8800, captureLevel: "redacted", retentionDays: 90, token: "tok",
      roots: [{ id: "work", path: join(a.home, "work/skills") }] });
    let s = depsA.openStore();
    s.addEvalCase({ query: "PR 리뷰", expectedUri: uri("pr-review-ko") });
    s.addEvalCase({ query: "디비", expectedUri: uri("database-query") });
    s.close();
    assert.equal((await capture(() => runExport(out, { withHistory: false }, depsA))).code, 0);
    const raw = readFileSync(join(out, "gisool-export.json"), "utf8");
    assert.ok(!raw.includes(a.home), "export must not contain the absolute HOME");
    for (const m of raw.matchAll(/"([^"]*)"/g)) assert.ok(!m[1].startsWith(a.home));

    const bConfig = { port: 9000, captureLevel: "full", retentionDays: null, roots: [{ id: "agents", path: "~/.agents/skills" }] };
    const depsB = seedHome(b, bConfig);
    const before = readFileSync(join(b.home, ".gisool", "config.json"), "utf8");
    const dry = await capture(() => runImport(out, { dryRun: true }, depsB));
    assert.equal(dry.code, 0);
    assert.match(dry.out, /eval cases to add: 2/);
    assert.match(dry.out, /roots to add: work/);
    assert.ok(!dry.out.includes("gisool init"));
    s = depsB.openStore();
    assert.equal(s.evalCases().length, 0);
    s.close();
    assert.equal(readFileSync(join(b.home, ".gisool", "config.json"), "utf8"), before);

    const applied = await capture(() => runImport(out, { dryRun: false }, depsB));
    assert.equal(applied.code, 0);
    assert.match(applied.out, /gisool init/);
    s = depsB.openStore();
    assert.equal(s.evalCases().length, 2);
    s.close();
    const cfg = JSON.parse(readFileSync(join(b.home, ".gisool", "config.json"), "utf8"));
    assert.equal(cfg.port, 9000);
    assert.equal(cfg.captureLevel, "full");
    assert.equal(cfg.retentionDays, null);
    assert.deepEqual(cfg.roots.map((r) => r.id), ["agents", "work"]);
  } finally {
    a.cleanup(); b.cleanup(); removeDir(out);
  }
});

test("import detects seeded .claude and .codex runtimes", async () => {
  const a = makeSandbox(), b = makeSandbox(), out = makeTempDir();
  try {
    const depsA = makeDeps(a.home, a.env);
    assert.equal((await capture(() => runExport(out, { withHistory: false }, depsA))).code, 0);
    mkdirSync(join(b.home, ".claude"), { recursive: true });
    mkdirSync(join(b.home, ".codex"), { recursive: true });
    const r = await capture(() => runImport(out, { dryRun: false }, makeDeps(b.home, b.env)));
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /claude-code: detected/);
    assert.match(r.out, /codex: detected/);
    assert.match(r.out, /gemini: not detected/);
  } finally {
    a.cleanup(); b.cleanup(); removeDir(out);
  }
});

test("export --with-history then import keeps the session count; empty dir fails with no_export_found", async () => {
  const a = makeSandbox(), b = makeSandbox(), out = makeTempDir(), empty = makeTempDir();
  try {
    const depsA = makeDeps(a.home, a.env);
    mkdirSync(depsA.gisoolHome, { recursive: true });
    let s = depsA.openStore();
    seedForty(s);
    const expected = s.sessions({}).length;
    s.close();
    assert.ok(expected > 0);
    assert.equal((await capture(() => runExport(out, { withHistory: true }, depsA))).code, 0);
    assert.ok(readdirSync(out).includes("history.db"));
    const depsB = makeDeps(b.home, b.env);
    mkdirSync(depsB.gisoolHome, { recursive: true });
    assert.equal((await capture(() => runImport(out, { dryRun: false }, depsB))).code, 0);
    s = depsB.openStore();
    assert.equal(s.sessions({}).length, expected);
    s.close();

    const bad = await capture(() => runImport(empty, { dryRun: false }, depsB));
    assert.equal(bad.code, 1);
    assert.match(bad.out, /no_export_found/);
  } finally {
    a.cleanup(); b.cleanup(); removeDir(out); removeDir(empty);
  }
});
