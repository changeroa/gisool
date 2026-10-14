import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import hook from "../../clients/openclaw/plugin/hooks/gisul-discovery/handler.js";
import { bridgePlan, parseArgs, resolveStateDir } from "../../clients/openclaw/plugin/scripts/bridge.mjs";
import { prepareExisting } from "../../clients/openclaw/prepare-existing.mjs";
import { prepareOAuth } from "../../clients/openclaw/prepare-oauth.mjs";

const bundle = fileURLToPath(new URL("../../clients/openclaw/plugin/", import.meta.url));
const bridge = join(bundle, "scripts/bridge.mjs");
async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "gisul-openclaw-unit-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
function execute(args, env, input = "", script = bridge) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", x => stdout += x);
    child.stderr.on("data", x => stderr += x);
    child.on("error", reject);
    child.on("close", code => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

test("prepared OAuth bundle uses the selected endpoint for both login and runtime", async t => {
  const root = await fixture(t), output = join(root, "extensions/gisul-openclaw");
  await mkdir(join(root, "extensions"));
  await prepareOAuth(output, "https://gisul.iyendev.com/mcp");
  const script = join(output, "scripts/bridge.mjs");
  const runtimeResult = await execute(["--dry-run"], {}, "", script);
  const loginResult = await execute(["--login", "--dry-run"], {}, "", script);
  assert.equal(runtimeResult.code, 0, runtimeResult.stderr);
  assert.equal(loginResult.code, 0, loginResult.stderr);
  const runtime = JSON.parse(runtimeResult.stdout);
  const login = JSON.parse(loginResult.stdout);
  assert.equal(runtime.args[2], "https://gisul.iyendev.com/mcp");
  assert.equal(login.args[3], runtime.args[2]);
  assert.equal(runtime.env.MCP_REMOTE_CONFIG_DIR, join(root, "gisul/auth"));
  assert.deepEqual(runtime.env, login.env);
  await assert.rejects(prepareOAuth(output, "https://gisul.iyendev.com/mcp"), { code: "EEXIST" });
  for (const endpoint of ["http://host/mcp", "https://user:secret@host/mcp", "https://host/mcp?token=x", "https://host/other", "https://host/mcp#x"]) {
    await assert.rejects(prepareOAuth(join(root, "invalid"), endpoint));
  }
  await assert.rejects(access(join(root, "invalid")), { code: "ENOENT" });
});

test("existing-MCP bundle adds guidance without replacing transport or credentials", async t => {
  const root = await fixture(t), output = join(root, "existing");
  const config = join(root, "openclaw.json");
  const before = '{"mcp":{"servers":{"gisul":{"command":"existing-adapter","env":{"TOKEN":"fixture-only"}}}}}';
  await writeFile(config, before);
  assert.equal((await prepareExisting(output)).mcpRegistrationIncluded, false);
  assert.equal(await readFile(config, "utf8"), before);
  const manifest = JSON.parse(await readFile(join(output, ".codex-plugin/plugin.json"), "utf8"));
  assert.equal(manifest.mcpServers, undefined);
  assert.deepEqual((await readdir(output)).sort(), [".codex-plugin", "README.md", "gisul-client.json", "hooks", "package.json", "skills"]);
  assert.match(await readFile(join(output, "skills/gisul/SKILL.md"), "utf8"), /existing-MCP mode preserves/);
  assert.match(await readFile(join(output, "README.md"), "utf8"), /existing mcp.servers.gisul/);
  await assert.rejects(prepareExisting(output), { code: "EEXIST" });
  assert.equal(await readFile(config, "utf8"), before);
  assert.ok((await readdir(output)).includes("skills"));
});

test("bundle declares only its loader, bootstrap hook and read-only OAuth bridge", async () => {
  const manifest = JSON.parse(await readFile(join(bundle, ".codex-plugin/plugin.json"), "utf8"));
  const mcp = JSON.parse(await readFile(join(bundle, ".mcp.json"), "utf8"));
  assert.equal(manifest.name, "gisul-openclaw");
  assert.equal(manifest.hooks, "./hooks/");
  assert.deepEqual(Object.keys(mcp.mcpServers), ["gisul"]);
  assert.deepEqual(mcp.mcpServers.gisul.args, ["${CLAUDE_PLUGIN_ROOT}/scripts/bridge.mjs"]);
  assert.throws(() => bridgePlan({ stateDir: "/profile with spaces" }, {}), /Configure a Gisul endpoint/);
  const normal = bridgePlan({ stateDir: "/profile with spaces" }, { GISUL_MCP_URL: "https://fixture.example/mcp" });
  const login = bridgePlan({ stateDir: "/profile with spaces", login: true }, { GISUL_MCP_URL: "https://fixture.example/mcp" });
  assert.equal(normal.env.MCP_REMOTE_CONFIG_DIR, "/profile with spaces/gisul/auth");
  assert.deepEqual(normal.env, login.env);
  assert.deepEqual(normal.args.slice(2), login.args.slice(3));
  assert.equal(JSON.parse(normal.args.at(-1)).scope, "skills:read");
  assert.ok(normal.args.includes("mcp-remote@0.14.3"));
  assert.equal(parseArgs(["--login", "--dry-run"]).login, true);
  assert.throws(() => parseArgs(["--state-dir"]), /incomplete/);
});

test("credentials follow a copied install, explicit state override or source profile", () => {
  const installed = "/profiles/team/extensions/gisul-openclaw/scripts/bridge.mjs";
  assert.equal(resolveStateDir({}, { OPENCLAW_STATE_DIR: "/other" }, "/user", installed), "/profiles/team");
  assert.equal(resolveStateDir({ stateDir: "/explicit" }, {}, "/user", installed), "/explicit");
  assert.equal(resolveStateDir({}, { OPENCLAW_PROFILE: "qa" }, "/user", "/source/scripts/bridge.mjs"), "/user/.openclaw-qa");
  assert.equal(resolveStateDir({}, { OPENCLAW_STATE_DIR: "~/custom", OPENCLAW_HOME: "/effective" }, "/user", "/source/scripts/bridge.mjs"), "/effective/custom");
  assert.throws(() => resolveStateDir({}, { OPENCLAW_PROFILE: "../other" }, "/user", "/source/scripts/bridge.mjs"), /Invalid/);
});

test("bootstrap preserves existing instructions and cached objects without duplicate injection", () => {
  const original = { name: "AGENTS.md", path: "/work/AGENTS.md", content: "Existing rules", missing: false };
  const event = { type: "agent", action: "bootstrap", context: { workspaceDir: "/work", bootstrapFiles: [original] } };
  hook(event);
  assert.equal(original.content, "Existing rules");
  const first = event.context.bootstrapFiles[0].content;
  assert.ok(first.startsWith("Existing rules\n\n<gisul-discovery>"));
  hook(event);
  assert.equal(event.context.bootstrapFiles[0].content, first);
  const unrelated = { ...event, type: "message", context: { bootstrapFiles: [] } };
  hook(unrelated);
  assert.deepEqual(unrelated.context.bootstrapFiles, []);
  for (const files of [[], [{ name: "AGENTS.md", path: "/work/AGENTS.md", missing: true }]]) {
    const next = { ...event, context: { workspaceDir: "/work", bootstrapFiles: files } };
    hook(next);
    assert.equal(files[0].missing, false);
    assert.equal(files[0].path, "/work/AGENTS.md");
    assert.match(files[0].content, /search_skills/);
  }
});

test("dry run creates no auth state; subprocess keeps stdout protocol-clean and failure status", async t => {
  const root = await fixture(t);
  const state = join(root, "state");
  const dry = await execute(["--state-dir", state, "--dry-run"], { GISUL_MCP_URL: "https://fixture.example/mcp" });
  assert.equal(dry.code, 0);
  assert.equal(JSON.parse(dry.stdout).env.MCP_REMOTE_CONFIG_DIR, join(state, "gisul/auth"));
  await assert.rejects(access(state), { code: "ENOENT" });
  const bin = join(root, "bin");
  await mkdir(bin);
  const npx = join(bin, "npx");
  await writeFile(npx, `#!${process.execPath}\nprocess.stderr.write('fixture bridge diagnostic\\n');\nprocess.stdin.pipe(process.stdout);\nprocess.stdin.on('end', () => { process.exitCode = Number(process.env.GISUL_TEST_EXIT || 0); });\n`);
  await chmod(npx, 0o700);
  const input = '{"jsonrpc":"2.0","id":1,"method":"initialize"}\n';
  const result = await execute(["--state-dir", state], { PATH: bin + delimiter + process.env.PATH, GISUL_TEST_EXIT: "7", GISUL_MCP_URL: "https://fixture.example/mcp" }, input);
  assert.equal(result.code, 7);
  assert.equal(result.stdout, input);
  assert.match(result.stderr, /fixture bridge diagnostic/);
  assert.equal((await stat(join(state, "gisul/auth"))).mode & 0o777, 0o700);
});
