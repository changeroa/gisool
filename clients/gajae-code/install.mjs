#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { applyFiles, gajaeTransport, parseArgs, planMcp, planSummary, resolveAgentDir } from "../runtime-install.mjs";

const here = dirname(fileURLToPath(import.meta.url));

export async function install(options = {}) {
  const agentDir = resolveAgentDir("gajae-code", options);
  const files = [await planMcp(join(agentDir, "mcp.json"), gajaeTransport(agentDir))];
  const command = ["plugin", "install", join(here, "plugin"), "--user"];
  const summary = planSummary("gajae-code", agentDir, files, {
    plugin: { command: ["gjc", ...command], env: { GJC_CODING_AGENT_DIR: agentDir } },
    authentication: `Run node clients/gajae-code/login.mjs --agent-dir ${JSON.stringify(agentDir)} before starting a new GJC session.`,
    dryRun: !!options.dryRun,
  });
  if (options.dryRun) return summary;
  const env = { ...process.env, GJC_CODING_AGENT_DIR: agentDir };
  const listed = spawnSync("gjc", ["plugin", "list", "--json", "--user"], { env, encoding: "utf8", timeout: 30000 });
  if (listed.error || listed.status !== 0) throw new Error("Could not inspect GJC plugins. Install a GJC version with native plugin bundle support, then retry.");
  const installed = JSON.parse(listed.stdout).gjc?.find(item => item.identity?.name === "gisul" && item.identity.scope === "user");
  if (installed) {
    if (!installed.enabled || installed.quarantined || installed.surfaces.some(surface => !surface.enabled || surface.quarantined)) {
      throw new Error("The installed Gisul bundle has disabled or quarantined surfaces; resolve its GJC plugin status before installing");
    }
    for (const file of ["gajae-plugin.json", "prompts/discovery.md", "prompts/executor.md", "subskills/interview/SKILL.md"]) {
      const source = await readFile(join(here, "plugin", file));
      const target = await readFile(join(agentDir, "gjc-plugins/gisul", file));
      if (!source.equals(target)) throw new Error("A different Gisul bundle is installed. Review gjc plugin upgrade gisul --user for this profile, then rerun the installer.");
    }
  }
  // GJC owns bundle validation, registry writes, hashes, and collision handling.
  // Its stdio bundle policy does not support an OAuth npx bridge on macOS, so
  // the MCP uses the native loose config; the bundle owns only prompt surfaces.
  if (!installed) {
    const result = spawnSync("gjc", command, { env, stdio: "inherit", timeout: 120000 });
    if (result.error || result.status !== 0) throw new Error("GJC plugin installation failed; the MCP config was not changed. Inspect the GJC diagnostic above.");
  }
  summary.plugin.action = installed ? "unchanged" : "installed";
  try { summary.backups = await applyFiles(files); }
  catch (error) { throw new Error(`The Gisul prompt plugin is installed, but MCP setup failed: ${error.message}. Correct the config and rerun this installer.`); }
  return summary;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) console.log("Usage: node clients/gajae-code/install.mjs [--agent-dir PATH] [--dry-run]\nInstalls the GJC prompt bundle and OAuth MCP bridge registration. Requires gjc and Node/npm. Existing conflicting registrations are preserved.");
    else console.log(JSON.stringify(await install(options), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
