import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { accessSync, chmodSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { distImport, makeSandbox, PACKAGE_ROOT } from "./_helpers.mjs";

const { claudeCodePack } = await distImport("packs/claude-code.js");
const { codexPack } = await distImport("packs/codex.js");
const packageRoot = realpathSync(fileURLToPath(PACKAGE_ROOT));
const mkCtx = (sb, extra = {}) => ({ home: sb.home, env: { ...sb.env, PATH: join(sb.home, "emptybin") }, port: 47123, token: "tok123",
  nodePath: realpathSync(process.execPath), packageRoot, disableRemote: false, ...extra });
const put = (p, t) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, t); };
const fakeBin = (sb, name) => { const d = join(sb.home, "bin"); put(join(d, name), "#!/bin/sh\n"); chmodSync(join(d, name), 0o755); return d; };

test("claude detect true/false", async () => {
  const sb = makeSandbox();
  try {
    assert.equal((await claudeCodePack.detect(mkCtx(sb))).installed, false);
    mkdirSync(join(sb.home, ".claude"));
    const d = await claudeCodePack.detect(mkCtx(sb));
    assert.equal(d.installed, true);
    assert.equal(d.remoteGisulRegistered, false);
  } finally { sb.cleanup(); }
});

test("claude plan keeps unrelated keys, exact blocks, idempotent, commands exist", async () => {
  const sb = makeSandbox();
  try {
    const p = join(sb.home, ".claude", "settings.json");
    const foreign = [{ matcher: "Bash", hooks: [{ type: "command", command: "echo hi" }] }];
    put(p, JSON.stringify({ model: "opus", env: { FOO: "1" }, hooks: { PostToolUse: foreign } }, null, 2));
    const ctx = mkCtx(sb);
    const plan = await claudeCodePack.plan(ctx);
    assert.deepEqual(plan.conflicts, []);
    assert.equal(plan.files.length, 1);
    const out = JSON.parse(plan.files[0].after);
    assert.equal(out.model, "opus");
    assert.deepEqual(out.env, { FOO: "1", CLAUDE_CODE_ENABLE_TELEMETRY: "1", OTEL_LOGS_EXPORTER: "otlp",
      OTEL_EXPORTER_OTLP_LOGS_PROTOCOL: "http/json", OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: "http://127.0.0.1:47123/ingest/otlp/v1/logs",
      OTEL_EXPORTER_OTLP_LOGS_HEADERS: "Authorization=Bearer tok123", OTEL_LOG_USER_PROMPTS: "1", OTEL_LOG_TOOL_DETAILS: "1" });
    assert.equal(JSON.stringify(out.hooks.PostToolUse[0]), JSON.stringify(foreign[0]));
    assert.equal(out.hooks.PostToolUse.length, 2);
    const g = out.hooks.PostToolUse[1];
    assert.equal(g.matcher, "Skill|mcp__gisool__.*");
    assert.equal(g.hooks[0].timeout, 5);
    assert.equal(out.hooks.UserPromptExpansion.length, 1);
    const hookPath = join(packageRoot, "packs", "hook-post.mjs");
    assert.equal(g.hooks[0].command, `"${ctx.nodePath}" "${hookPath}" claude-code`);
    accessSync(ctx.nodePath); accessSync(hookPath);
    put(p, plan.files[0].after);
    const again = await claudeCodePack.plan(ctx);
    assert.deepEqual(again.files, []);
    assert.deepEqual(again.conflicts, []);
    const checks = await claudeCodePack.doctorChecks({ home: sb.home, env: ctx.env, port: 47123 });
    assert.ok(checks.every(c => c.ok), JSON.stringify(checks));
  } finally { sb.cleanup(); }
});

test("claude conflicts: env value, unparseable json", async () => {
  const sb = makeSandbox();
  try {
    const p = join(sb.home, ".claude", "settings.json");
    put(p, JSON.stringify({ env: { OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: "http://elsewhere/v1/logs" } }));
    let plan = await claudeCodePack.plan(mkCtx(sb));
    assert.equal(plan.files.length, 0);
    assert.equal(plan.conflicts[0].code, "env_conflict");
    put(p, "{ not json");
    plan = await claudeCodePack.plan(mkCtx(sb));
    assert.equal(plan.files.length, 0);
    assert.equal(plan.conflicts[0].code, "unparseable_json");
    assert.equal(readFileSync(p, "utf8"), "{ not json");
  } finally { sb.cleanup(); }
});

test("claude mcp command only with claude on PATH and no GISOOL_NO_CLI", async () => {
  const sb = makeSandbox();
  try {
    const dir = fakeBin(sb, "claude");
    const env = { ...sb.env, PATH: dir };
    delete env.GISOOL_NO_CLI;
    const plan = await claudeCodePack.plan(mkCtx(sb, { env }));
    assert.equal(plan.commands.length, 1);
    assert.deepEqual(plan.commands[0].argv, ["claude", "mcp", "add", "--transport", "http", "--scope", "user", "gisool",
      "http://127.0.0.1:47123/mcp", "--header", "Authorization: Bearer tok123"]);
    assert.deepEqual(plan.commands[0].undo.argv, ["claude", "mcp", "remove", "--scope", "user", "gisool"]);
    const noCli = await claudeCodePack.plan(mkCtx(sb, { env: { ...env, GISOOL_NO_CLI: "1" } }));
    assert.equal(noCli.commands.length, 0);
    assert.ok(noCli.notes.some(n => n.includes("manual step") && n.includes("claude mcp add --transport http --scope user gisool http://127.0.0.1:47123/mcp --header")));
  } finally { sb.cleanup(); }
});

test("claude remote gisul detected; disableRemote adds manual note", async () => {
  const sb = makeSandbox();
  try {
    put(join(sb.home, ".claude.json"), JSON.stringify({ mcpServers: { gisul: { type: "http", url: "https://gisul.example/mcp" } } }));
    const d = await claudeCodePack.detect(mkCtx(sb));
    assert.equal(d.remoteGisulRegistered, true);
    const plan = await claudeCodePack.plan(mkCtx(sb, { disableRemote: true }));
    assert.ok(plan.notes.some(n => n.includes("claude mcp remove --scope user gisul")));
    assert.ok(plan.files.every(f => !f.path.endsWith(".claude.json")));
  } finally { sb.cleanup(); }
});

test("codex detect, plan block, idempotent, preserves content", async () => {
  const sb = makeSandbox();
  try {
    assert.equal((await codexPack.detect(mkCtx(sb))).installed, false);
    const p = join(sb.home, ".codex", "config.toml");
    const orig = 'model = "gpt"\n\n[mcp_servers.other]\ncommand = "x"\n';
    put(p, orig);
    assert.equal((await codexPack.detect(mkCtx(sb))).installed, true);
    const ctx = mkCtx(sb);
    const plan = await codexPack.plan(ctx);
    assert.deepEqual(plan.conflicts, []);
    const after = plan.files[0].after;
    assert.ok(after.startsWith(orig));
    assert.ok(after.includes('[mcp_servers.gisool]\nurl = "http://127.0.0.1:47123/mcp"\nhttp_headers = { Authorization = "Bearer tok123" }'));
    assert.ok(after.includes('[otel]\nlog_user_prompt = true\nexporter = { otlp-http = { endpoint = "http://127.0.0.1:47123/ingest/otlp/v1/logs", protocol = "json", headers = { Authorization = "Bearer tok123" } } }\nmetrics_exporter = "none"'));
    assert.ok(after.includes("# >>> gisool managed") && after.includes("# <<< gisool managed"));
    put(p, after);
    assert.deepEqual((await codexPack.plan(ctx)).files, []);
    const moved = await codexPack.plan({ ...ctx, port: 50000 });
    assert.ok(moved.files[0].after.startsWith(orig));
    assert.equal(moved.files[0].after.match(/>>> gisool managed/g).length, 1);
    const checks = await codexPack.doctorChecks({ home: sb.home, env: ctx.env, port: 47123 });
    assert.ok(checks.every(c => c.ok), JSON.stringify(checks));
  } finally { sb.cleanup(); }
});

test("codex respects CODEX_HOME; unmanaged otel forms are conflicts with no file change", async () => {
  const sb = makeSandbox();
  try {
    const ch = join(sb.home, "custom-codex");
    const ctx = mkCtx(sb); ctx.env.CODEX_HOME = ch;
    assert.equal((await codexPack.detect(ctx)).installed, false);
    mkdirSync(ch);
    assert.equal((await codexPack.detect(ctx)).installed, true);
    for (const body of ["[otel]\nlog_user_prompt = false\n", "[otel.exporter]\nx = 1\n", "otel.log_user_prompt = true\n"]) {
      put(join(ch, "config.toml"), body);
      const plan = await codexPack.plan(ctx);
      assert.equal(plan.files.length, 0, body);
      assert.equal(plan.conflicts[0].code, "unmanaged_otel");
      assert.equal(readFileSync(join(ch, "config.toml"), "utf8"), body);
    }
  } finally { sb.cleanup(); }
});

test("codex disableRemote sets enabled = false on remote gisul", async () => {
  const sb = makeSandbox();
  try {
    put(join(sb.home, ".codex", "config.toml"), '[mcp_servers.gisul]\nurl = "https://gisul.example/mcp"\n');
    const ctx = mkCtx(sb, { disableRemote: true });
    assert.equal((await codexPack.detect(ctx)).remoteGisulRegistered, true);
    const plan = await codexPack.plan(ctx);
    assert.ok(plan.files[0].after.includes('[mcp_servers.gisul]\nenabled = false\nurl = "https://gisul.example/mcp"'));
  } finally { sb.cleanup(); }
});

const hookRun = (sb) => new Promise(resolve => {
  const t0 = Date.now();
  const c = spawn(process.execPath, [join(packageRoot, "packs", "hook-post.mjs"), "claude-code"], { env: sb.env, stdio: ["pipe", "ignore", "ignore"] });
  c.stdin.end('{"hook_event_name":"PostToolUse"}');
  c.on("close", code => resolve({ code, ms: Date.now() - t0 }));
});
const seedDaemon = (sb, port) => {
  put(join(sb.home, ".gisool", "token"), "tok123\n");
  put(join(sb.home, ".gisool", "config.json"), JSON.stringify({ port }));
};

test("hook-post exits 0 fast when daemon is down or unconfigured", async () => {
  const sb = makeSandbox();
  const bare = makeSandbox();
  try {
    const srv = createServer(); await new Promise(r => srv.listen(0, "127.0.0.1", r));
    const port = srv.address().port; await new Promise(r => srv.close(r));
    seedDaemon(sb, port);
    const r = await hookRun(sb);
    assert.equal(r.code, 0); assert.ok(r.ms < 3000, String(r.ms));
    assert.equal((await hookRun(bare)).code, 0);
  } finally { sb.cleanup(); bare.cleanup(); }
});

test("hook-post exits 0 within 2.5s when listener never responds", async () => {
  const sb = makeSandbox();
  const sockets = [];
  const srv = createServer(s => { sockets.push(s); s.on("error", () => {}); });
  await new Promise(r => srv.listen(0, "127.0.0.1", r));
  try {
    seedDaemon(sb, srv.address().port);
    const r = await hookRun(sb);
    assert.equal(r.code, 0); assert.ok(r.ms < 2500, String(r.ms));
  } finally { sockets.forEach(s => s.destroy()); await new Promise(r => srv.close(r)); sb.cleanup(); }
});
