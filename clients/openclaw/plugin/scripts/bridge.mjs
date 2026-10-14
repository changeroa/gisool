#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { chmod, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const self = fileURLToPath(import.meta.url);
export const remotePackage = "mcp-remote@0.14.3";
const metadata = JSON.stringify({ client_name: "Gisul for OpenClaw", scope: "skills:read" });

export function parseArgs(args) {
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--login") options.login = true;
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--help") options.help = true;
    else if (arg === "--endpoint" && args[i + 1] && !args[i + 1].startsWith("--")) options.endpoint = validateEndpoint(args[++i]);
    else if (arg === "--state-dir" && args[i + 1] && !args[i + 1].startsWith("--")) options.stateDir = resolve(args[++i]);
    else throw new Error(`Unknown or incomplete argument: ${arg}. Use --help.`);
  }
  return options;
}

export function resolveStateDir(options = {}, env = process.env, home = homedir(), script = self) {
  const expand = value => resolve(value.replace(/^~(?=$|\/)/, home));
  if (options.stateDir) return expand(options.stateDir);
  // A copied bundle owns credentials in its installation profile even when a
  // subprocess environment does not forward OpenClaw's profile variables.
  const extensions = dirname(dirname(dirname(script)));
  if (basename(extensions) === "extensions") return dirname(extensions);
  const effectiveHome = env.OPENCLAW_HOME?.trim() ? expand(env.OPENCLAW_HOME.trim()) : home;
  if (env.OPENCLAW_STATE_DIR?.trim()) return resolve(env.OPENCLAW_STATE_DIR.trim().replace(/^~(?=$|\/)/, effectiveHome));
  const profile = env.OPENCLAW_PROFILE?.trim();
  if (profile && !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(profile)) throw new Error("Invalid OPENCLAW_PROFILE; use --state-dir.");
  return join(effectiveHome, profile && profile !== "default" ? `.openclaw-${profile}` : ".openclaw");
}

export function bridgePlan(options = {}, env = process.env) {
  let configured;
  try { configured = JSON.parse(readFileSync(new URL("../gisul-client.json", import.meta.url), "utf8")).endpoint; }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  const target = validateEndpoint(options.endpoint ?? configured ?? env.GISUL_MCP_URL);
  const authDir = join(resolveStateDir(options, env), "gisul", "auth");
  const prefix = options.login
    ? ["--yes", `--package=${remotePackage}`, "mcp-remote-client"]
    : ["--yes", remotePackage];
  return {
    command: "npx",
    args: [...prefix, target, "--transport", "http-only", "--static-oauth-client-metadata", metadata],
    env: { MCP_REMOTE_CONFIG_DIR: authDir },
  };
}

export function validateEndpoint(value) {
  if (!value) throw new Error("Configure a Gisul endpoint with prepare-oauth.mjs or GISUL_MCP_URL");
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/mcp") throw new Error("Expected an HTTPS /mcp endpoint without credentials, query or fragment");
  return url.href;
}

export async function run(options = {}) {
  const plan = bridgePlan(options);
  if (options.dryRun) { console.log(JSON.stringify(plan, null, 2)); return 0; }
  await mkdir(plan.env.MCP_REMOTE_CONFIG_DIR, { recursive: true, mode: 0o700 });
  await chmod(plan.env.MCP_REMOTE_CONFIG_DIR, 0o700);
  // In bridge mode stdout belongs exclusively to the MCP child.
  const child = spawn(plan.command, plan.args, { env: { ...process.env, ...plan.env }, stdio: "inherit" });
  const signals = ["SIGINT", "SIGTERM"];
  const forward = signal => child.kill(signal);
  const handlers = signals.map(signal => { const handler = () => forward(signal); process.on(signal, handler); return [signal, handler]; });
  try {
    return await new Promise((resolveExit, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolveExit(code ?? (signal === "SIGINT" ? 130 : 143)));
    });
  } finally { for (const [signal, handler] of handlers) process.off(signal, handler); }
}

if (process.argv[1] && existsSync(process.argv[1]) && realpathSync(resolve(process.argv[1])) === self) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) console.log("Usage: node bridge.mjs [--login] [--endpoint HTTPS_MCP_URL] [--state-dir PATH] [--dry-run]\nNo flags: serve MCP over stdio. --login: sign in and list tools. Use the same OpenClaw profile and endpoint for login and runtime.");
    else process.exitCode = await run(options);
  } catch (error) { console.error(`Gisul OpenClaw: ${error.message}`); process.exitCode = 1; }
}
