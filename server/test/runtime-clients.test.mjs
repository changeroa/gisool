import assert from "node:assert/strict";
import test from "node:test";
import { access, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { install as installOmo } from "../../clients/oh-my-openagent/install.mjs";
import { install as installGajae } from "../../clients/gajae-code/install.mjs";
import { applyFiles, gajaeTransport, omoTransport, planMcp, resolveAgentDir } from "../../clients/runtime-install.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "gisul-runtime-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("dry runs neither create profiles nor require a GJC executable", async t => {
  const root = await fixture(t);
  for (const install of [installOmo, installGajae]) {
    const agentDir = join(root, install === installOmo ? "omo" : "gjc");
    const result = await install({ agentDir, dryRun: true });
    assert.ok(result.files.every(file => file.action === "create"));
    await assert.rejects(access(agentDir), { code: "ENOENT" });
  }
});

test("OmO preserves other servers and discovers guidance; reruns do not rewrite files", async t => {
  const agentDir = await fixture(t);
  const configPath = join(agentDir, "mcp.json");
  const previous = '{ "settings": { "searchThreshold": 7 }, "mcpServers": { "mine": { "command": "private-command", "env": { "TOKEN": "fixture-secret" } } } }\n';
  await writeFile(configPath, previous);
  const installed = await installOmo({ agentDir });
  const config = JSON.parse(await readFile(configPath, "utf8"));
  assert.deepEqual(config.mcpServers.mine, JSON.parse(previous).mcpServers.mine);
  assert.equal(config.settings.searchThreshold, 7);
  assert.deepEqual(config.mcpServers.gisul, omoTransport(agentDir));
  assert.equal(await readFile(installed.backups[0], "utf8"), previous);
  assert.equal((await stat(installed.backups[0])).mode & 0o777, 0o600);
  assert.ok(!JSON.stringify(installed).includes("fixture-secret"));
  const timestamp = (await stat(configPath)).mtimeMs;
  const again = await installOmo({ agentDir });
  assert.ok(again.files.every(file => file.action === "unchanged"));
  assert.deepEqual(again.backups, []);
  assert.equal((await stat(configPath)).mtimeMs, timestamp);

  const handlers = [];
  const extension = await import(pathToFileURL(join(agentDir, "extensions/gisul/index.js")));
  extension.default({ on: (...args) => handlers.push(args) });
  assert.equal(handlers.length, 1);
  const [event, handler, options] = handlers[0];
  assert.equal(event, "before_agent_start");
  assert.equal(options.previewSafe, true);
  const result = handler({ systemPrompt: "Existing OmO instructions", preview: true });
  assert.ok(result.systemPrompt.startsWith("Existing OmO instructions\n\n"));
  assert.match(result.systemPrompt, /search_skills/);
  assert.equal(handler({ systemPrompt: result.systemPrompt }), undefined);
  assert.equal(handler({ systemPrompt: "Fresh turn" }).systemPrompt.split("<gisul-discovery>").length, 2);
});

test("a conflicting loader or registration prevents all installation writes", async t => {
  const agentDir = await fixture(t);
  const skill = join(agentDir, "skills/gisul");
  await mkdir(skill, { recursive: true });
  await writeFile(join(skill, "SKILL.md"), "user-owned skill");
  await assert.rejects(installOmo({ agentDir }), /different file/);
  await assert.rejects(access(join(agentDir, "mcp.json")), { code: "ENOENT" });
  await rm(join(agentDir, "skills"), { recursive: true });
  const previous = JSON.stringify({ mcpServers: { gisul: { command: "my-existing-adapter" } } });
  await writeFile(join(agentDir, "mcp.json"), previous);
  for (const install of [installOmo, installGajae]) await assert.rejects(install({ agentDir }), /different gisul registration/);
  assert.equal(await readFile(join(agentDir, "mcp.json"), "utf8"), previous);
  assert.deepEqual(await readdir(agentDir), ["mcp.json"]);
});

test("malformed, disabled, and symlinked MCP configs are preserved", async t => {
  const root = await fixture(t);
  const file = join(root, "mcp.json");
  for (const value of ["{bad", "null", '{"mcpServers":[]}', '{"disabledServers":["gisul"]}']) {
    await writeFile(file, value);
    await assert.rejects(planMcp(file, gajaeTransport(root)));
    assert.equal(await readFile(file, "utf8"), value);
  }
  await rm(file);
  const other = join(root, "owned.json");
  await writeFile(other, "{}");
  await symlink(other, file);
  await assert.rejects(planMcp(file, gajaeTransport(root)), /regular file/);
  assert.equal(await readFile(other, "utf8"), "{}");
});

test("a config edited after planning is not overwritten", async t => {
  const root = await fixture(t);
  const path = join(root, "mcp.json");
  await writeFile(path, "{}");
  const plan = await planMcp(path, gajaeTransport(root));
  await writeFile(path, '{"mcpServers":{"new-server":{"command":"keep"}}}');
  await assert.rejects(applyFiles([plan]), /changed during installation/);
  assert.ok(JSON.parse(await readFile(path, "utf8")).mcpServers["new-server"]);
});

test("profile selection and OAuth caches follow runtime-owned directories", () => {
  assert.equal(resolveAgentDir("oh-my-openagent", {}, {}, "/example"), "/example/.omo/agent");
  assert.equal(resolveAgentDir("gajae-code", {}, {}, "/example"), "/example/.gjc/agent");
  assert.equal(resolveAgentDir("gajae-code", {}, { GJC_CONFIG_DIR: ".team" }, "/example"), "/example/.team/agent");
  for (const [runtime, name] of [["oh-my-openagent", "OMO_CODING_AGENT_DIR"], ["gajae-code", "GJC_CODING_AGENT_DIR"]]) {
    assert.equal(resolveAgentDir(runtime, {}, { [name]: "/primary", PI_CODING_AGENT_DIR: "/legacy" }), "/primary");
    assert.equal(resolveAgentDir(runtime, { agentDir: "/explicit" }, { [name]: "/primary" }), "/explicit");
  }
  for (const transport of [gajaeTransport, omoTransport]) {
    const config = transport("/profile with spaces");
    assert.equal(config.env.MCP_REMOTE_CONFIG_DIR, "/profile with spaces/gisul/auth");
    assert.equal(config.timeout ?? config.connectTimeoutMs, 120000);
    assert.equal(JSON.parse(config.args[config.args.indexOf("--static-oauth-client-metadata") + 1]).scope, "skills:read");
    assert.ok(!JSON.stringify(config).includes("Bearer"));
  }
});
