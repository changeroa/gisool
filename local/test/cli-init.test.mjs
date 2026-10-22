import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { test } from "node:test";
import { distImport } from "./_helpers.mjs";
import { cliSandbox, runCli, snapshotTree, writeStub } from "./helpers/cli.mjs";

const { runInit } = await distImport("cli/init.js");
const { planService, nodePath, packageRoot } = await distImport("cli/serve.js");
const { runMain } = await distImport("cli/main.js");
const { unifiedDiff } = await distImport("cli/config-writer.js");

const quietIo = () => {
  const io = { text: "", out: (t) => (io.text += t), err: (t) => (io.text += t) };
  return io;
};
const seedClaude = (home, obj = { theme: "dark" }) => writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify(obj) + "\n");

test("init --dry-run writes nothing and prints diffs for seeded runtimes", async (t) => {
  const sb = cliSandbox();
  t.after(sb.cleanup);
  seedClaude(sb.home);
  const before = snapshotTree(sb.home);
  const r = await runCli(["init", "--dry-run"], sb.env);
  assert.equal(r.code, 0, r.output);
  assert.match(r.stdout, /^\+\+\+ b.*\.claude\/settings\.json$/m);
  assert.match(r.stdout, /^\+\+\+ b.*\.codex\/config\.toml$/m);
  assert.match(r.stdout, process.platform === "darwin" ? /dev\.gisool\.daemon\.plist/ : /\.config\/systemd\/user\/gisool\.service/);
  assert.doesNotMatch(r.stdout, /[0-9a-f]{64}/, "token must be masked in printed diffs");
  assert.deepEqual(snapshotTree(sb.home), before);
  assert.equal(existsSync(sb.env.GISOOL_HOME), false);
});

test("apply writes planned files with 0600 backups, re-apply is a no-op, rollback restores byte-equal originals", async (t) => {
  const sb = cliSandbox();
  t.after(sb.cleanup);
  seedClaude(sb.home);
  writeFileSync(join(sb.home, ".codex", "config.toml"), 'model = "o3"\n\n[mcp_servers.other]\nurl = "https://example.com/mcp"\n');
  const original = snapshotTree(sb.home);

  const first = await runCli(["init"], sb.env);
  assert.equal(first.code, 0, first.output);
  const claude = JSON.parse(readFileSync(join(sb.home, ".claude", "settings.json"), "utf8"));
  assert.equal(claude.theme, "dark");
  assert.ok(claude.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT);
  const codex = readFileSync(join(sb.home, ".codex", "config.toml"), "utf8");
  assert.match(codex, /\[mcp_servers\.other\]/, "unrelated servers are kept");
  assert.match(codex, /\[mcp_servers\.gisool\]/);
  for (const p of [".gemini/settings.json", ".cursor/mcp.json", ".cursor/hooks.json", ".omo/agent/mcp.json", ".gjc/agent/mcp.json", ".gisool/packs/openclaw/openclaw.plugin.json"]) {
    assert.ok(existsSync(join(sb.home, p)), p);
  }
  const sets = readdirSync(join(sb.env.GISOOL_HOME, "backups"));
  assert.equal(sets.length, 1);
  const setDir = join(sb.env.GISOOL_HOME, "backups", sets[0]);
  const manifest = JSON.parse(readFileSync(join(setDir, "manifest.json"), "utf8"));
  assert.equal(statSync(join(setDir, "manifest.json")).mode & 0o777, 0o600);
  const backedUp = manifest.files.filter((f) => f.backup);
  assert.equal(backedUp.length, 2, "the two pre-existing files are backed up");
  for (const f of backedUp) assert.equal(statSync(join(setDir, f.backup)).mode & 0o777, 0o600);
  assert.equal(statSync(join(sb.env.GISOOL_HOME, "token")).mode & 0o777, 0o600);

  const applied = snapshotTree(sb.home, { exclude: [".gisool"] });
  const second = await runCli(["init"], sb.env);
  assert.equal(second.code, 0, second.output);
  assert.match(second.stdout, /applied 0 file\(s\) and 0 command\(s\)/);
  assert.deepEqual(snapshotTree(sb.home, { exclude: [".gisool"] }), applied);

  const rb = await runCli(["init", "--rollback"], sb.env);
  assert.equal(rb.code, 0, rb.output);
  const strip = (tree) => Object.fromEntries(Object.entries(tree).filter(([k]) => !k.startsWith(".gisool")));
  assert.deepEqual(strip(snapshotTree(sb.home)), strip(original));
  const again = await runCli(["init", "--rollback"], sb.env);
  assert.match(again.stdout, /nothing to roll back/);
});

test("a file modified between plan and apply aborts all writes", async (t) => {
  const sb = cliSandbox();
  t.after(sb.cleanup);
  seedClaude(sb.home);
  const settings = join(sb.home, ".claude", "settings.json");
  const io = quietIo();
  const code = await runInit({ noService: true }, sb.env, io, {
    afterPlan: () => writeFileSync(settings, JSON.stringify({ theme: "light" }) + "\n"),
  });
  assert.equal(code, 1, io.text);
  assert.match(io.text, /modified_since_plan/);
  assert.match(io.text, /\.claude\/settings\.json/);
  assert.equal(readFileSync(settings, "utf8"), '{"theme":"light"}\n');
  for (const p of [".gemini/settings.json", ".cursor/mcp.json", ".omo/agent/mcp.json", ".codex/config.toml"]) assert.equal(existsSync(join(sb.home, p)), false, p);
  assert.deepEqual(readdirSync(join(sb.env.GISOOL_HOME, "backups")), []);
});

test("with CLI enabled, init runs and rollback undoes the claude mcp registration through stubs only", async (t) => {
  const sb = cliSandbox({ runtimes: [] });
  t.after(sb.cleanup);
  const log = join(sb.home, "argv.log");
  for (const name of ["claude", "launchctl", "systemctl", "openclaw"]) writeStub(sb.bin, name, log);
  delete sb.env.GISOOL_NO_CLI;

  const init = await runCli(["init", "--no-service", "--runtime", "claude-code"], sb.env);
  assert.equal(init.code, 0, init.output);
  const afterInit = readFileSync(log, "utf8");
  assert.match(afterInit, /^claude mcp add --transport http --scope user gisool http:\/\/127\.0\.0\.1:8799\/mcp --header Authorization: Bearer [0-9a-f]{64}$/m);
  assert.doesNotMatch(afterInit, /launchctl|systemctl|openclaw/);
  const set = readdirSync(join(sb.env.GISOOL_HOME, "backups"))[0];
  const manifest = JSON.parse(readFileSync(join(sb.env.GISOOL_HOME, "backups", set, "manifest.json"), "utf8"));
  assert.deepEqual(manifest.commands.map((c) => [c.argv.slice(0, 3), c.undo.argv, c.exitCode]), [[["claude", "mcp", "add"], ["claude", "mcp", "remove", "--scope", "user", "gisool"], 0]]);

  const rb = await runCli(["init", "--rollback"], sb.env);
  assert.equal(rb.code, 0, rb.output);
  assert.match(readFileSync(log, "utf8"), /^claude mcp remove --scope user gisool$/m);
});

test("pre-existing unmanaged OTel settings abort dry run and apply, naming both files and changing nothing", async (t) => {
  const sb = cliSandbox();
  t.after(sb.cleanup);
  writeFileSync(join(sb.home, ".codex", "config.toml"), '[otel]\nexporter = "none"\n');
  seedClaude(sb.home, { env: { OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: "http://collector:4318/v1/logs" } });
  const before = snapshotTree(sb.home);
  for (const args of [["init", "--dry-run"], ["init"]]) {
    const r = await runCli(args, sb.env);
    assert.equal(r.code, 1, r.output);
    assert.match(r.stderr, /\.codex\/config\.toml/);
    assert.match(r.stderr, /\.claude\/settings\.json/);
    assert.deepEqual(snapshotTree(sb.home), before, args.join(" "));
  }
});

test("invalid JSON in ~/.claude/settings.json makes init exit non-zero, name the file, and write nothing", async (t) => {
  const sb = cliSandbox();
  t.after(sb.cleanup);
  writeFileSync(join(sb.home, ".claude", "settings.json"), "{ not json");
  const before = snapshotTree(sb.home);
  const r = await runCli(["init"], sb.env);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /\.claude\/settings\.json: unparseable_json/);
  assert.deepEqual(snapshotTree(sb.home), before);
});

test("init --disable-remote --dry-run shows the planned Codex disable edit", async (t) => {
  const sb = cliSandbox({ runtimes: [".codex"] });
  t.after(sb.cleanup);
  writeFileSync(join(sb.home, ".codex", "config.toml"), '[mcp_servers.gisul]\nurl = "https://gisul.arkpoint.dev/mcp"\n');
  const r = await runCli(["init", "--dry-run", "--disable-remote", "--no-service"], sb.env);
  assert.equal(r.code, 0, r.output);
  assert.match(r.stdout, /runtime codex: detected .*remoteGisulRegistered=true/);
  assert.match(r.stdout, /^ \[mcp_servers\.gisul\]\n\+enabled = false$/m);
});

test("init on win32 exits unsupported_platform", async (t) => {
  const sb = cliSandbox();
  t.after(sb.cleanup);
  const stub = `data:text/javascript,${encodeURIComponent('Object.defineProperty(process, "platform", { value: "win32" });')}`;
  const r = await runCli(["init", "--dry-run"], sb.env, { nodeArgs: ["--import", stub] });
  assert.equal(r.code, 1, r.output);
  assert.match(r.stderr, /unsupported_platform/);
});

test("the planned LaunchAgent plist runs absolute paths that exist", () => {
  const plan = planService({ home: "/tmp/h", gisoolHome: "/tmp/h/.gisool", env: { GISOOL_NO_CLI: "1" }, nodePath: nodePath(), packageRoot: packageRoot(), platform: "darwin", uid: 501 });
  assert.equal(plan.file.path, "/tmp/h/Library/LaunchAgents/dev.gisool.daemon.plist");
  const args = [...plan.file.after.match(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/)[1].matchAll(/<string>([^<]*)<\/string>/g)].map((m) => m[1]);
  assert.equal(args.length, 3);
  assert.equal(args[2], "serve");
  for (const p of args.slice(0, 2)) {
    assert.ok(isAbsolute(p), p);
    assert.ok(existsSync(p), p);
  }
  assert.match(args[1], /dist\/cli\/main\.js$/);
  assert.match(plan.file.after, /<key>KeepAlive<\/key>\s*<true\/>/);
  assert.match(plan.file.after, /<string>\/tmp\/h\/\.gisool\/logs\/daemon\.log<\/string>/);
  assert.deepEqual(plan.commands, [], "GISOOL_NO_CLI plans no launchctl call");
  const live = planService({ home: "/tmp/h", gisoolHome: "/tmp/h/.gisool", env: {}, nodePath: nodePath(), packageRoot: packageRoot(), platform: "darwin", uid: 501 });
  assert.deepEqual(live.commands.map((c) => c.argv), [["launchctl", "bootstrap", "gui/501", plan.file.path]]);
});

test("export, import, and eval dispatch to the todo-14 modules", async () => {
  const calls = [];
  const loaders = {
    exportImport: async () => ({
      runExport: async (dir, opts) => (calls.push(["export", dir, opts]), 0),
      runImport: async (dir, opts) => (calls.push(["import", dir, opts]), 0),
    }),
    evalApi: async () => ({ runEval: async (opts) => (calls.push(["eval", opts]), 0) }),
  };
  const sb = cliSandbox({ runtimes: [] });
  try {
    const io = quietIo();
    assert.equal(await runMain(["export", "/tmp/x", "--with-history"], { env: sb.env, io, loaders }), 0);
    assert.equal(await runMain(["import", "/tmp/y", "--dry-run"], { env: sb.env, io, loaders }), 0);
    assert.equal(await runMain(["eval", "--cases", "c.json", "--json"], { env: sb.env, io, loaders }), 0);
    assert.equal(await runMain(["export"], { env: sb.env, io, loaders }), 2);
    assert.deepEqual(calls, [["export", "/tmp/x", { withHistory: true }], ["import", "/tmp/y", { dryRun: true }], ["eval", { cases: "c.json", json: true }]]);
  } finally {
    sb.cleanup();
  }
});

test("unifiedDiff emits hunks with context", () => {
  const d = unifiedDiff("/f", "a\nb\nc\n", "a\nB\nc\n");
  assert.equal(d, "--- a/f\n+++ b/f\n@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n");
  assert.equal(unifiedDiff("/f", "x\n", "x\n"), "");
  assert.match(unifiedDiff("/n", null, "y\n"), /^--- \/dev\/null\n\+\+\+ b\/n\n@@ -0,0 \+1,1 @@\n\+y\n$/);
});
