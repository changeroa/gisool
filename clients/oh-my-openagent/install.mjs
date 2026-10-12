#!/usr/bin/env node
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { applyFiles, omoTransport, parseArgs, planFile, planMcp, planSummary, resolveAgentDir } from "../runtime-install.mjs";

const here = dirname(fileURLToPath(import.meta.url));

export async function install(options = {}) {
  const agentDir = resolveAgentDir("oh-my-openagent", options);
  const files = [await planMcp(join(agentDir, "mcp.json"), omoTransport(agentDir))];
  for (const [target, source] of [
    ["skills/gisul/SKILL.md", "gisul/SKILL.md"],
    ["extensions/gisul/index.js", "extension/index.js"],
    ["extensions/gisul/discovery.md", "extension/discovery.md"],
  ]) files.push(await planFile(join(agentDir, target), join(here, source)));
  const summary = planSummary("oh-my-openagent", agentDir, files, {
    authentication: "Run node clients/oh-my-openagent/login.mjs with this agent directory before starting OmO. Sign in with your Ark-Point GitHub account.",
    dryRun: !!options.dryRun,
  });
  if (!options.dryRun) summary.backups = await applyFiles(files);
  return summary;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) console.log("Usage: node clients/oh-my-openagent/install.mjs [--agent-dir PATH] [--dry-run]\nInstalls the native OmO 5 MCP connection, discovery extension, and Gisul loader. Existing conflicting files are preserved.");
    else console.log(JSON.stringify(await install(options), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
