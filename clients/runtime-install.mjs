import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

export const endpoint = "https://gisul.arkpoint.dev/mcp";
export const remotePackage = "mcp-remote@0.14.3";
export const oauthMetadata = JSON.stringify({ client_name: "Gisul for Gajae Code", scope: "skills:read" });
export const omoOauthMetadata = JSON.stringify({ client_name: "Gisul for OmO", scope: "skills:read" });

export function parseArgs(args) {
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--help") options.help = true;
    else if (arg === "--agent-dir" && args[i + 1] && !args[i + 1].startsWith("--")) options.agentDir = resolve(args[++i]);
    else throw new Error(`Unknown or incomplete argument: ${arg}. Use --help.`);
  }
  return options;
}

export function resolveAgentDir(runtime, options = {}, env = process.env, home = homedir()) {
  if (options.agentDir) return resolve(options.agentDir);
  const names = runtime === "oh-my-openagent"
    ? ["OMO_CODING_AGENT_DIR", "SENPI_CODING_AGENT_DIR", "PI_CODING_AGENT_DIR"]
    : ["GJC_CODING_AGENT_DIR", "PI_CODING_AGENT_DIR"];
  for (const name of names) if (env[name]?.trim()) return resolve(env[name].trim());
  if (runtime === "oh-my-openagent") return join(home, ".omo", "agent");
  const configDir = env.GJC_CONFIG_DIR?.trim() || env.PI_CONFIG_DIR?.trim() || ".gjc";
  if (isAbsolute(configDir) || configDir.split(/[\\/]/).some(part => ["", ".", ".."].includes(part))) {
    throw new Error("Use --agent-dir for an explicit Gajae profile path");
  }
  return join(home, configDir, "agent");
}

export function gajaeTransport(agentDir) {
  return oauthBridgeTransport(agentDir, oauthMetadata);
}

export function omoTransport(agentDir) {
  const { timeout, ...transport } = oauthBridgeTransport(agentDir, omoOauthMetadata);
  return { ...transport, connectTimeoutMs: timeout, requestTimeoutMs: timeout };
}

function oauthBridgeTransport(agentDir, metadata) {
  return {
    type: "stdio",
    command: "npx",
    args: ["--yes", remotePackage, endpoint, "--transport", "http-only", "--static-oauth-client-metadata", metadata],
    env: { MCP_REMOTE_CONFIG_DIR: join(agentDir, "gisul", "auth") },
    // GJC's ordinary startup only keeps slow registrations connecting in the
    // background when they declare a positive timeout. Login is done beforehand.
    timeout: 120000,
  };
}

const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const canonical = value => Array.isArray(value) ? value.map(canonical) : object(value)
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const equal = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

async function readTarget(path) {
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Expected a regular file: ${path}`);
    return await readFile(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

export async function planMcp(path, desired) {
  const before = await readTarget(path);
  let config;
  try { config = before === null ? {} : JSON.parse(before); }
  catch { throw new Error(`Invalid JSON at ${path}; no configuration was changed`); }
  if (!object(config) || (config.mcpServers !== undefined && !object(config.mcpServers))) {
    throw new Error(`Expected an object and mcpServers map at ${path}`);
  }
  if (config.disabledServers?.includes("gisul")) throw new Error(`Gisul is disabled in ${path}; resolve that policy before installing`);
  const servers = config.mcpServers ?? {};
  if (Object.hasOwn(servers, "gisul")) {
    if (!equal(servers.gisul, desired)) throw new Error(`A different gisul registration exists at ${path}; refusing to overwrite it`);
    return { path, before, after: before };
  }
  return { path, before, after: JSON.stringify({ ...config, mcpServers: { ...servers, gisul: desired } }, null, 2) + "\n" };
}

export async function planFile(path, source) {
  const before = await readTarget(path);
  const after = await readFile(source, "utf8");
  if (before !== null && before !== after) throw new Error(`A different file exists at ${path}; preserve it before updating Gisul`);
  return { path, before, after };
}

async function atomicWrite(path, content) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.gisul-${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { flag: "wx", mode: 0o600 });
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}

export async function applyFiles(files) {
  const changed = files.filter(file => file.before !== file.after);
  // Validate the entire plan before writing. Never knowingly overwrite an edit
  // that arrived after the read-only plan was prepared.
  for (const file of files) if (await readTarget(file.path) !== file.before) throw new Error(`File changed during installation: ${file.path}`);
  const applied = [];
  const backups = [];
  try {
    for (const file of changed) {
      if (await readTarget(file.path) !== file.before) throw new Error(`File changed during installation: ${file.path}`);
      if (file.before !== null) {
        const backup = `${file.path}.gisul-backup-${randomUUID()}`;
        await writeFile(backup, file.before, { flag: "wx", mode: 0o600 });
        backups.push(backup);
      }
      await atomicWrite(file.path, file.after);
      applied.push(file);
    }
  } catch (error) {
    for (const file of applied.reverse()) {
      // Do not roll back over another writer's subsequent change.
      if (await readTarget(file.path) !== file.after) continue;
      if (file.before === null) await rm(file.path);
      else await atomicWrite(file.path, file.before);
    }
    throw error;
  }
  return backups;
}

export function planSummary(runtime, agentDir, files, extra = {}) {
  // Existing MCP configs may contain secrets. Summaries contain paths/status
  // only, never previous bytes or unrelated server definitions.
  return { runtime, agentDir, files: files.map(file => ({ path: file.path, action: file.before === file.after ? "unchanged" : file.before === null ? "create" : "merge" })), ...extra };
}
