import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { test } from "node:test";
import { distImport } from "./_helpers.mjs";
import { cliSandbox, runCli } from "./helpers/cli.mjs";

const { openDb } = await distImport("store/db.js");
const VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

async function listen(handler) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { port: server.address().port, close: () => new Promise((resolve) => server.close(resolve)) };
}

const fakeGisool = () => listen((req, res) => {
  res.writeHead(req.url === "/healthz" || req.url === "/api/stats" ? 200 : 404, { "content-type": "application/json" });
  res.end(JSON.stringify({ ok: true, version: VERSION }));
});

async function freePort() {
  const s = await listen(() => undefined);
  await s.close();
  return s.port;
}

function prepareHome(sb, port) {
  mkdirSync(sb.env.GISOOL_HOME, { recursive: true, mode: 0o700 });
  writeFileSync(join(sb.env.GISOOL_HOME, "config.json"), JSON.stringify({ port }) + "\n");
  openDb(join(sb.env.GISOOL_HOME, "gisool.db")).close();
}

const check = (report, name) => report.checks.find((c) => c.name === name);

function assertSchema(report) {
  assert.equal(typeof report.ok, "boolean");
  assert.equal(report.version, VERSION);
  assert.ok(Array.isArray(report.checks) && report.checks.length > 0);
  for (const c of report.checks) {
    assert.equal(typeof c.name, "string");
    assert.ok(["ok", "warn", "fail", "skip"].includes(c.status), c.status);
    assert.equal(typeof c.detail, "string");
    if ("code" in c) assert.equal(typeof c.code, "string");
  }
  for (const name of ["service", "daemon", "remote_gisul", "token_mode", "fts5", "roots", "duplicates", "index_freshness", "hook_timeouts", "last_backup"]) {
    assert.ok(check(report, name), `missing check ${name}`);
  }
}

test("doctor --json with the daemon down exits 1 and reports daemon_unreachable", async (t) => {
  const sb = cliSandbox({ runtimes: [] });
  t.after(sb.cleanup);
  prepareHome(sb, await freePort());
  const r = await runCli(["doctor", "--json"], sb.env);
  assert.equal(r.code, 1, r.output);
  const report = JSON.parse(r.stdout);
  assertSchema(report);
  assert.equal(report.ok, false);
  assert.equal(check(report, "daemon").code, "daemon_unreachable");
  assert.equal(check(report, "service").status, "skip");
});

test("doctor --json with the daemon up exits 0; no backups reports last_backup: none without failing", async (t) => {
  const sb = cliSandbox({ runtimes: [] });
  const daemon = await fakeGisool();
  t.after(async () => { await daemon.close(); sb.cleanup(); });
  prepareHome(sb, daemon.port);
  const r = await runCli(["doctor", "--json"], sb.env);
  assert.equal(r.code, 0, r.output);
  const report = JSON.parse(r.stdout);
  assertSchema(report);
  assert.equal(report.ok, true);
  assert.equal(check(report, "daemon").status, "ok");
  assert.equal(check(report, "token_mode").status, "ok");
  assert.equal(check(report, "fts5").status, "ok");
  assert.equal(check(report, "index_freshness").status, "ok");
  assert.deepEqual(check(report, "last_backup"), { name: "last_backup", status: "ok", detail: "none" });
  const text = await runCli(["doctor"], sb.env);
  assert.equal(text.code, 0, text.output);
  assert.match(text.stdout, /last_backup: none/);
});

test("doctor lists sibling skill families in text and --json", async (t) => {
  const sb = cliSandbox({ runtimes: [] });
  const daemon = await fakeGisool();
  t.after(async () => { await daemon.close(); sb.cleanup(); });
  prepareHome(sb, daemon.port);
  const skills = join(sb.home, "skills");
  for (const name of ["re0", "re0-loop", "re0-work", "solo"]) {
    mkdirSync(join(skills, name), { recursive: true });
    writeFileSync(join(skills, name, "SKILL.md"), `---\nname: ${name}\ndescription: test skill ${name}\n---\nbody\n`);
  }
  writeFileSync(join(sb.env.GISOOL_HOME, "config.json"), JSON.stringify({ port: daemon.port, roots: [{ id: "t", path: skills }] }) + "\n");
  const r = await runCli(["doctor", "--json"], sb.env);
  const report = JSON.parse(r.stdout);
  assert.deepEqual(report.families, [{ id: "re0", members: ["re0", "re0-loop", "re0-work"] }]);
  assert.equal(check(report, "skill_families").detail, "re0: re0, re0-loop, re0-work");
  const text = await runCli(["doctor"], sb.env);
  assert.match(text.stdout, /skill_families: re0: re0, re0-loop, re0-work/);
});

test("doctor reports a listener that is not gisool", async (t) => {
  const sb = cliSandbox({ runtimes: [] });
  const other = await listen((req, res) => { res.writeHead(200); res.end("hello"); });
  t.after(async () => { await other.close(); sb.cleanup(); });
  prepareHome(sb, other.port);
  const r = await runCli(["doctor", "--json"], sb.env);
  assert.equal(r.code, 1);
  assert.equal(check(JSON.parse(r.stdout), "daemon").code, "not_gisool");
});

test("doctor flags a gisool hook timeout above 5 s as hook_timeout_too_long", async (t) => {
  const sb = cliSandbox({ runtimes: [".claude"] });
  const daemon = await fakeGisool();
  t.after(async () => { await daemon.close(); sb.cleanup(); });
  prepareHome(sb, daemon.port);
  const hook = { type: "command", command: '"/usr/bin/node" "/x/packs/hook-post.mjs" claude-code', timeout: 600 };
  writeFileSync(join(sb.home, ".claude", "settings.json"), JSON.stringify({ hooks: { PostToolUse: [{ matcher: "Skill", hooks: [hook] }] } }));
  const r = await runCli(["doctor", "--json"], sb.env);
  assert.equal(r.code, 1);
  const c = check(JSON.parse(r.stdout), "hook_timeouts");
  assert.equal(c.status, "fail");
  assert.equal(c.code, "hook_timeout_too_long");
  assert.match(c.detail, /600s/);
});

test("a remote gisul registration is a warning, not a failure", async (t) => {
  const sb = cliSandbox({ runtimes: [".gemini"] });
  const daemon = await fakeGisool();
  t.after(async () => { await daemon.close(); sb.cleanup(); });
  prepareHome(sb, daemon.port);
  const init = await runCli(["init", "--no-service", "--runtime", "gemini"], sb.env);
  assert.equal(init.code, 0, init.output);
  const settingsPath = join(sb.home, ".gemini", "settings.json");
  const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
  settings.mcpServers.gisul = { httpUrl: "https://gisul.arkpoint.dev/mcp" };
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");

  const r = await runCli(["doctor", "--json"], sb.env);
  const report = JSON.parse(r.stdout);
  assert.equal(r.code, 0, JSON.stringify(report.checks.filter((c) => c.status === "fail")));
  const remote = check(report, "remote_gisul");
  assert.equal(remote.status, "warn");
  assert.equal(remote.code, "remote_gisul_registered");
  assert.match(remote.detail, /gemini/);
  assert.notEqual(check(report, "last_backup").detail, "none");
});

test("doctor fails with token_mismatch when /api/stats rejects this install's token", async (t) => {
  const sb = cliSandbox({ runtimes: [] });
  const seen = [];
  const foreign = await listen((req, res) => {
    seen.push(req.url);
    const healthy = req.url === "/healthz";
    res.writeHead(healthy ? 200 : 401, { "content-type": "application/json" });
    res.end(JSON.stringify(healthy ? { ok: true, version: VERSION } : { error: "unauthorized" }));
  });
  t.after(async () => { await foreign.close(); sb.cleanup(); });
  prepareHome(sb, foreign.port);
  const r = await runCli(["doctor", "--json"], sb.env);
  assert.equal(r.code, 1, r.output);
  const c = check(JSON.parse(r.stdout), "daemon");
  assert.equal(c.status, "fail");
  assert.equal(c.code, "token_mismatch");
  assert.match(c.detail, /another gisool instance|rotated/);
  assert.deepEqual(seen, ["/healthz", "/api/stats"]);
});

test("doctor sends this install's bearer token to /api/stats and reports ok on 200", async (t) => {
  const sb = cliSandbox({ runtimes: [] });
  let auth;
  const daemon = await listen((req, res) => {
    if (req.url === "/api/stats") auth = req.headers.authorization;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, version: VERSION }));
  });
  t.after(async () => { await daemon.close(); sb.cleanup(); });
  prepareHome(sb, daemon.port);
  const r = await runCli(["doctor", "--json"], sb.env);
  assert.equal(r.code, 0, r.output);
  assert.equal(check(JSON.parse(r.stdout), "daemon").status, "ok");
  const token = readFileSync(join(sb.env.GISOOL_HOME, "token"), "utf8").trim();
  assert.ok(token.length > 0);
  assert.equal(auth, "Bearer " + token);
});
