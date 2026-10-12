// Run with Bun and explicitly supplied, installed runtime packages. No model
// calls or browser login: this checks the runtimes' real config/prompt loaders.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { install as installOmo } from "../clients/oh-my-openagent/install.mjs";
import { install as installGajae } from "../clients/gajae-code/install.mjs";

const args = process.argv.slice(2);
if (args.length !== 4 || args[0] !== "--gajae-source" || args[2] !== "--senpi-source") {
  throw new Error("Usage: bun scripts/check-runtime-clients.mjs --gajae-source /path/to/coding-agent --senpi-source /path/to/senpi");
}
const gjc = resolve(args[1]), senpi = resolve(args[3]);
const root = await mkdtemp(join(tmpdir(), "gisul-native-clients-"));
const priorAgentDir = process.env.GJC_CODING_AGENT_DIR;
process.env.GJC_CODING_AGENT_DIR = join(root, "gjc");
const from = (base, path) => import(pathToFileURL(join(base, path)).href);
try {
  const gajae = await installGajae({ agentDir: join(root, "gjc") });
  assert.equal((await installGajae({ agentDir: join(root, "gjc") })).plugin.action, "unchanged");
  const omo = await installOmo({ agentDir: join(root, "omo") });
  const { compileGjcPluginBundle } = await from(gjc, "src/extensibility/gjc-plugins/compiler.ts");
  const compiled = await compileGjcPluginBundle(join(root, "gjc/gjc-plugins/gisul"));
  assert.equal(compiled.surfaces.mcps.length, 0, "OAuth transport belongs to native loose config");
  assert.equal(compiled.surfaces.subskills[0].parent, "deep-interview");
  assert.equal(compiled.surfaces.subskills[0].phase, "interviewing");

  const { renderAlwaysOnSystemAppendices, renderAgentPromptAdditions, renderSkillAdvertisement } = await from(gjc, "src/extensibility/gjc-plugins/runtime-adapters.ts");
  assert.match(await renderAlwaysOnSystemAppendices({ cwd: root }), /search_skills/);
  const executor = await renderAgentPromptAdditions({ cwd: root, agentName: "executor" });
  assert.match(executor.appendix, /approved assignment/);
  assert.equal((await renderAgentPromptAdditions({ cwd: root, agentName: "architect" })).appendix, "");
  assert.match(await renderSkillAdvertisement({ cwd: root, skillName: "deep-interview", phase: "interviewing" }), /gisul-interview/);
  const { resolveSubskillActivationForSkillInvocation } = await from(gjc, "src/extensibility/gjc-plugins/activation.ts");
  const { buildSubskillInjection } = await from(gjc, "src/extensibility/gjc-plugins/injection.ts");
  const activation = await resolveSubskillActivationForSkillInvocation({ cwd: root, skillName: "deep-interview", args: "--gisul product scope" });
  assert.equal(activation.cleanedArgs, "product scope");
  const input = { cwd: root, sessionId: "gisul-client-smoke", skillName: "deep-interview", activation: activation.activation };
  assert.match((await buildSubskillInjection({ ...input, currentPhase: "interviewing" })).block, /Before Round 0 topology confirmation/);
  assert.equal(await buildSubskillInjection({ ...input, currentPhase: "handoff" }), null);
  const { loadAllMCPConfigs } = await from(gjc, "src/runtime-mcp/config.ts");
  const gjcConfig = await loadAllMCPConfigs(root, { agentDir: join(root, "gjc"), nativeOnly: true, autoloadOnly: true });
  assert.equal(gjcConfig.configurationWarning, false);
  assert.equal(gjcConfig.configs.gisul.type, "stdio");
  assert.equal(gjcConfig.configs.gisul.timeout, 120000);

  const { loadMcpConfig } = await from(senpi, "dist/core/extensions/builtin/mcp/config.js");
  const omoConfig = loadMcpConfig({ agentDir: join(root, "omo"), cwd: root, projectTrusted: false });
  assert.deepEqual(omoConfig.diagnostics, []);
  assert.equal(omoConfig.servers.gisul.state, "enabled");
  assert.equal(omoConfig.servers.gisul.config.type, "stdio");
  const bridgeArgs = omoConfig.servers.gisul.config.args;
  assert.equal(JSON.parse(bridgeArgs[bridgeArgs.indexOf("--static-oauth-client-metadata") + 1]).scope, "skills:read");
  assert.equal(omoConfig.servers.gisul.config.env.MCP_REMOTE_CONFIG_DIR, join(root, "omo/gisul/auth"));
  const handlers = [];
  (await from(join(root, "omo"), "extensions/gisul/index.js")).default({ on: (...values) => handlers.push(values) });
  assert.match(handlers[0][1]({ systemPrompt: "OmO base" }).systemPrompt, /^OmO base\n\n<gisul-discovery>/);
  const version = async path => JSON.parse(await readFile(join(path, "package.json"), "utf8")).version;
  console.log(JSON.stringify({ verified: true, gajae: await version(gjc), senpi: await version(senpi), checks: ["bundle compiler", "idempotent install", "interview advertisement and phase injection", "executor appendix", "native MCP config loaders", "OmO prompt composition"], profiles: [gajae.agentDir, omo.agentDir], cleanup: "removed in finally" }, null, 2));
} finally {
  if (priorAgentDir === undefined) delete process.env.GJC_CODING_AGENT_DIR;
  else process.env.GJC_CODING_AGENT_DIR = priorAgentDir;
  await rm(root, { recursive: true, force: true });
}
