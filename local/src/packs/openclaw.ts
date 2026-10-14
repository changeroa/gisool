import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { PackCtx, PackPlan, PackPlanFile, RuntimePack } from "../types.js";

const CONFIG_NOTE = "Set plugins.entries.gisool.hooks.allowConversationAccess: true in the OpenClaw config (openclaw.json); without it before_agent_run is not delivered.";
const TEMPLATES = new Set([".mcp.json", "openclaw.plugin.json", "gisool.json"]);

function gisoolHome(env: NodeJS.ProcessEnv, home: string): string {
  return env.GISOOL_HOME || join(home, ".gisool");
}

function openclawConfigPath(env: NodeJS.ProcessEnv, home: string): string {
  return env.OPENCLAW_CONFIG_PATH || join(env.OPENCLAW_STATE_DIR || join(home, ".openclaw"), "openclaw.json");
}

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
}

function readOrNull(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function fill(node: unknown, vars: Record<string, unknown>): unknown {
  if (typeof node === "string") return node in vars ? vars[node] : node;
  if (Array.isArray(node)) return node.flatMap((n) => (typeof n === "string" && Array.isArray(vars[n]) ? (vars[n] as unknown[]) : [fill(n, vars)]));
  if (node && typeof node === "object") return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, fill(v, vars)]));
  return node;
}

/** Tolerant read of an openclaw.json (JSON5-ish): strips comments and trailing commas, falls back to null. */
function parseConfig(text: string): unknown {
  const stripped = text.replace(/("(?:[^"\\]|\\.)*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (_m, s) => s ?? "").replace(/,(\s*[}\]])/g, "$1");
  try {
    return JSON.parse(stripped);
  } catch {
    return null;
  }
}

type Rec = Record<string, any>;
const isRecord = (v: unknown): v is Rec => v !== null && typeof v === "object" && !Array.isArray(v);
const pluginEntries = (cfg: Rec): Rec | undefined => (isRecord(cfg.plugins) && isRecord(cfg.plugins.entries) ? cfg.plugins.entries : undefined);

function hasConversationAccess(text: string): boolean {
  const cfg = parseConfig(text);
  if (isRecord(cfg)) return pluginEntries(cfg)?.gisool?.hooks?.allowConversationAccess === true;
  return /allowConversationAccess["']?\s*:\s*true/.test(text);
}

export function bundleDir(env: NodeJS.ProcessEnv, home: string): string {
  return join(gisoolHome(env, home), "packs", "openclaw");
}

export const openclawPack: RuntimePack = {
  id: "openclaw",

  async detect({ home, env }) {
    const state = env.OPENCLAW_STATE_DIR || join(home, ".openclaw");
    const evidence: string[] = [];
    if (existsSync(state)) evidence.push(state);
    if (existsSync(openclawConfigPath(env, home))) evidence.push(openclawConfigPath(env, home));
    const remote = [join(state, "gisul"), join(state, "plugins", "gisul"), join(state, "extensions", "gisul")].find(existsSync);
    const cfgText = readOrNull(openclawConfigPath(env, home));
    const cfg = cfgText ? parseConfig(cfgText) : null;
    const entries = isRecord(cfg) ? pluginEntries(cfg) : undefined;
    const remoteGisulRegistered = Boolean(remote) || Boolean(entries?.gisul || entries?.["gisul-openclaw"]);
    if (remote) evidence.push(remote);
    return { installed: evidence.length > 0, evidence, remoteGisulRegistered };
  },

  async plan(ctx: PackCtx): Promise<PackPlan> {
    const src = join(ctx.packageRoot, "packs", "openclaw");
    const dest = bundleDir(ctx.env, ctx.home);
    const vars = {
      __COMMAND__: ctx.nodePath,
      __ARGS__: [join(ctx.packageRoot, "dist", "cli", "main.js"), "mcp-stdio"],
      __GISOOL_HOME__: gisoolHome(ctx.env, ctx.home),
      __PORT__: ctx.port,
    };
    const files: PackPlanFile[] = walk(src)
      .sort()
      .map((abs) => {
        const rel = relative(src, abs);
        const raw = readFileSync(abs, "utf8");
        const after = TEMPLATES.has(rel) ? JSON.stringify(fill(JSON.parse(raw), vars), null, 2) + "\n" : raw;
        const path = join(dest, rel);
        return { path, before: readOrNull(path), after, mode: statSync(abs).mode & 0o777 };
      });

    const notes = [
      `Bundle files: ${files.map((f) => relative(dest, f.path)).join(", ")}`,
      CONFIG_NOTE,
      "Restart the OpenClaw Gateway after installing so the plugin and its hooks load.",
    ];
    const commands: PackPlan["commands"] = [];
    // gisool writes this bundle itself, so the local-path trust prompt ("rerun with --force") is expected and answered here.
    const install = ["openclaw", "plugins", "install", "--force", dest];
    const uninstall = ["openclaw", "plugins", "uninstall", "gisool"];
    if (ctx.env.GISOOL_NO_CLI) notes.push(`GISOOL_NO_CLI set: run manually: ${install.join(" ")} (undo: ${uninstall.join(" ")})`);
    else commands.push({ argv: install, description: "Install the gisool capture plugin into OpenClaw (restart the OpenClaw Gateway afterwards)", undo: { argv: uninstall, description: "Uninstall the gisool OpenClaw plugin" } });

    if (ctx.disableRemote) notes.push("Remote gisul OpenClaw bundle is not removed automatically. To disable it run: openclaw plugins disable gisul-openclaw; to remove it run: openclaw plugins uninstall gisul-openclaw");
    return { files, commands, notes, conflicts: [] };
  },

  async doctorChecks({ home, env }) {
    const checks: { name: string; ok: boolean; detail: string }[] = [];
    const bundle = bundleDir(env, home);
    const bundled = existsSync(join(bundle, "openclaw.plugin.json"));
    checks.push({ name: "openclaw bundle", ok: bundled, detail: bundled ? bundle : `bundle missing at ${bundle}; run gisool init` });
    const cfgPath = openclawConfigPath(env, home);
    const text = readOrNull(cfgPath);
    if (text === null) checks.push({ name: "allowConversationAccess", ok: false, detail: `allowConversationAccess missing: no OpenClaw config at ${cfgPath}` });
    else if (hasConversationAccess(text)) checks.push({ name: "allowConversationAccess", ok: true, detail: cfgPath });
    else checks.push({ name: "allowConversationAccess", ok: false, detail: `allowConversationAccess missing: set plugins.entries.gisool.hooks.allowConversationAccess: true in ${cfgPath}` });
    return checks;
  },
};
