// Optional compatibility smoke against an installed OpenClaw package. No model
// calls, remote login, gateway restart, or changes to an existing user profile.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== "--openclaw-root") throw new Error("Usage: node scripts/check-openclaw-client.mjs --openclaw-root /path/to/installed/openclaw");
const runtime = resolve(args[1]);
const bundle = fileURLToPath(new URL("../clients/openclaw/plugin/", import.meta.url));
const root = await realpath(await mkdtemp(join(tmpdir(), "gisul-openclaw-native-")));
const keys = ["OPENCLAW_HOME", "OPENCLAW_STATE_DIR", "OPENCLAW_CONFIG_PATH", "GISUL_MCP_URL"];
const prior = Object.fromEntries(keys.map(key => [key, process.env[key]]));
// STATE_DIR alone can trigger legacy approval migration from the real home.
Object.assign(process.env, { OPENCLAW_HOME: join(root, "home"), OPENCLAW_STATE_DIR: root, OPENCLAW_CONFIG_PATH: join(root, "openclaw.json") });
const cli = values => execFileSync(process.execPath, [join(runtime, "openclaw.mjs"), ...values], { env: process.env, encoding: "utf8", timeout: 60000, maxBuffer: 4 * 1024 * 1024 });
const json = values => JSON.parse(cli([...values, "--json"]));

// Test adapter only: the distributed plugin itself imports no private SDK APIs.
async function runtimeFunction(prefix, name) {
  for (const file of await readdir(join(runtime, "dist"))) {
    if (!file.startsWith(prefix) || !file.endsWith(".js")) continue;
    if (!(await readFile(join(runtime, "dist", file), "utf8")).includes(`function ${name}(`)) continue;
    const exports = await import(pathToFileURL(join(runtime, "dist", file)).href);
    const fn = Object.values(exports).find(value => typeof value === "function" && value.name === name);
    if (fn) return fn;
  }
  throw new Error(`Compatibility adapter could not find ${name}; update this smoke for this OpenClaw build.`);
}

try {
  const workspace = join(root, "workspace");
  await mkdir(workspace, { recursive: true });
  await writeFile(join(workspace, "AGENTS.md"), "Existing workspace instructions\n");
  await writeFile(process.env.OPENCLAW_CONFIG_PATH, JSON.stringify({
    agents: { defaults: { workspace } }, hooks: { internal: { enabled: true } },
  }));
  process.env.GISUL_MCP_URL = "https://fixture.example/mcp";
  cli(["plugins", "install", bundle]);
  const inspected = json(["plugins", "inspect", "gisul-openclaw"]);
  assert.equal(inspected.plugin.bundleFormat, "codex");
  assert.equal(inspected.plugin.enabled, true);
  assert.ok(inspected.mcpServers.some(server => server.name === "gisul" && server.hasStdioTransport));
  const skill = json(["skills", "list"]).skills.find(skill => skill.name === "gisul");
  assert.ok(skill?.eligible);
  assert.equal(skill.modelVisible, true);
  const hook = json(["hooks", "list"]).hooks.find(hook => hook.name === "gisul-discovery");
  assert.ok(hook?.eligible && hook.managedByPlugin);

  const cfg = JSON.parse(await readFile(process.env.OPENCLAW_CONFIG_PATH, "utf8"));
  const loadMcp = await runtimeFunction("bundle-mcp-", "loadEnabledBundleMcpConfig");
  const mcp = loadMcp({ cfg, workspaceDir: workspace });
  assert.deepEqual(mcp.diagnostics, []);
  const bridge = mcp.config.mcpServers.gisul;
  const installed = join(root, "extensions/gisul-openclaw");
  assert.equal(await realpath(bridge.args[0]), join(installed, "scripts/bridge.mjs"));
  const plan = JSON.parse(execFileSync(process.execPath, [...bridge.args, "--dry-run"], { env: process.env, encoding: "utf8" }));
  assert.equal(plan.env.MCP_REMOTE_CONFIG_DIR, join(root, "gisul/auth"));
  assert.equal(JSON.parse(plan.args.at(-1)).scope, "skills:read");

  const loadHooks = await runtimeFunction("loader-", "loadInternalHooks");
  const createEvent = await runtimeFunction("internal-hooks-", "createInternalHookEvent");
  const trigger = await runtimeFunction("internal-hooks-", "triggerInternalHook");
  assert.ok(await loadHooks(cfg, workspace) > 0);
  const event = createEvent("agent", "bootstrap", "agent:main:gisul-smoke", {
    cfg, workspaceDir: workspace, bootstrapFiles: [{ name: "AGENTS.md", path: join(workspace, "AGENTS.md"), content: "Existing workspace instructions\n", missing: false }],
  });
  await trigger(event);
  assert.match(event.context.bootstrapFiles[0].content, /<gisul-discovery>/);
  assert.ok(event.context.bootstrapFiles[0].content.startsWith("Existing workspace instructions"));
  assert.equal(await readFile(join(workspace, "AGENTS.md"), "utf8"), "Existing workspace instructions\n");
  const clearHooks = await runtimeFunction("internal-hooks-", "clearInternalHooks");
  clearHooks();
  console.log(JSON.stringify({
    verified: true, runtime: cli(["--version"]).trim(), plugin: inspected.plugin.version,
    checks: ["native copied bundle install", "model-visible loader", "eligible plugin hook", "native MCP path expansion", "profile-scoped read-only bridge", "native hook dispatch preserves workspace file"],
    limits: ["No OAuth sign-in or live remote MCP calls", "No model turn or gateway restart"], cleanup: "temporary profile removed in finally",
  }, null, 2));
} finally {
  for (const key of keys) { if (prior[key] === undefined) delete process.env[key]; else process.env[key] = prior[key]; }
  await rm(root, { recursive: true, force: true });
}
