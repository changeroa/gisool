import { accessSync, constants, existsSync, readFileSync, statSync } from "node:fs";
import { join, delimiter } from "node:path";
import type { PackCtx, PackPlan, RuntimePack } from "../types.js";

type Env = NodeJS.ProcessEnv;
type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => v !== null && typeof v === "object" && !Array.isArray(v);
const jsonEsc = (v: string) => JSON.stringify(v).slice(1, -1);

function onPath(bin: string, env: Env): string | undefined {
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const p = join(dir, bin);
    try { if (statSync(p).isFile()) { accessSync(p, constants.X_OK); return p; } } catch { /* next */ }
  }
  return undefined;
}

const configDir = (c: { home: string; env: Env }) => c.env.CLAUDE_CONFIG_DIR || join(c.home, ".claude");
const settingsPath = (c: { home: string; env: Env }) => join(configDir(c), "settings.json");
const isLoopback = (u: string) => /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/.test(u);

function readText(p: string): string | null {
  try { return readFileSync(p, "utf8"); } catch { return null; }
}

function remoteRegistered(home: string): boolean {
  const text = readText(join(home, ".claude.json"));
  if (text === null) return false;
  try {
    const servers = (JSON.parse(text) as Obj).mcpServers;
    const g = isObj(servers) ? servers.gisul : undefined;
    if (!isObj(g)) return false;
    if (typeof g.url === "string") return !isLoopback(g.url);
    return JSON.stringify(g).includes("mcp-remote");
  } catch { return false; }
}

const hasGisoolHook = (groups: unknown): boolean =>
  Array.isArray(groups) && groups.some(g => isObj(g) && Array.isArray(g.hooks) &&
    g.hooks.some(h => isObj(h) && typeof h.command === "string" && h.command.includes("hook-post.mjs")));

function template(ctx: PackCtx): Obj {
  const raw = readFileSync(join(ctx.packageRoot, "packs", "claude-code", "settings.template.json"), "utf8")
    .replaceAll("{{PORT}}", String(ctx.port)).replaceAll("{{TOKEN}}", jsonEsc(ctx.token))
    .replaceAll("{{NODE}}", jsonEsc(ctx.nodePath)).replaceAll("{{HOOK}}", jsonEsc(join(ctx.packageRoot, "packs", "hook-post.mjs")));
  return JSON.parse(raw) as Obj;
}

export const claudeCodePack: RuntimePack = {
  id: "claude-code",
  async detect(ctx) {
    const evidence: string[] = [];
    const dir = configDir(ctx);
    if (existsSync(dir)) evidence.push(dir);
    const bin = onPath("claude", ctx.env);
    if (bin) evidence.push(bin);
    return { installed: evidence.length > 0, evidence, remoteGisulRegistered: remoteRegistered(ctx.home) };
  },
  async plan(ctx): Promise<PackPlan> {
    const plan: PackPlan = { files: [], commands: [], notes: [], conflicts: [] };
    const path = settingsPath(ctx);
    const before = readText(path);
    let cfg: Obj = {};
    if (before !== null) {
      try {
        const parsed: unknown = JSON.parse(before);
        if (!isObj(parsed)) throw new Error("not an object");
        cfg = parsed;
      } catch {
        plan.conflicts.push({ path, code: "unparseable_json", detail: "settings.json does not parse as a JSON object; refusing to edit" });
        return plan;
      }
    }
    const tpl = template(ctx);
    const wantEnv = tpl.env as Record<string, string>;
    const wantHooks = tpl.hooks as Record<string, unknown[]>;

    if (cfg.env !== undefined && !isObj(cfg.env)) plan.conflicts.push({ path, code: "env_not_object", detail: "settings.json `env` is not an object" });
    const env = isObj(cfg.env) ? cfg.env : {};
    for (const [k, v] of Object.entries(wantEnv)) {
      if (Object.hasOwn(env, k) && env[k] !== v) {
        plan.conflicts.push({ path, code: "env_conflict", detail: `${k} is already set to a different value` });
      }
    }
    if (cfg.hooks !== undefined && !isObj(cfg.hooks)) plan.conflicts.push({ path, code: "hooks_not_object", detail: "settings.json `hooks` is not an object" });
    const hooks = isObj(cfg.hooks) ? cfg.hooks : {};
    for (const ev of Object.keys(wantHooks)) {
      if (hooks[ev] !== undefined && !Array.isArray(hooks[ev])) plan.conflicts.push({ path, code: "hook_not_array", detail: `hooks.${ev} is not an array` });
    }

    if (plan.conflicts.length === 0) {
      const nextEnv = { ...env, ...wantEnv };
      const nextHooks: Obj = { ...hooks };
      for (const [ev, groups] of Object.entries(wantHooks)) {
        const existing = (hooks[ev] as unknown[] | undefined) ?? [];
        nextHooks[ev] = hasGisoolHook(existing) ? existing : [...existing, ...groups];
      }
      const next = { ...cfg, env: nextEnv, hooks: nextHooks };
      const after = JSON.stringify(next, null, 2) + "\n";
      const same = before !== null && JSON.stringify(JSON.parse(before)) === JSON.stringify(next);
      if (!same) plan.files.push({ path, before, after, mode: 0o600 });
    }

    const argv = ["claude", "mcp", "add", "--transport", "http", "--scope", "user", "gisool",
      `http://127.0.0.1:${ctx.port}/mcp`, "--header", `Authorization: Bearer ${ctx.token}`];
    const shown = `claude mcp add --transport http --scope user gisool http://127.0.0.1:${ctx.port}/mcp --header "Authorization: Bearer ${ctx.token}"`;
    if (onPath("claude", ctx.env) && !ctx.env.GISOOL_NO_CLI) {
      plan.commands.push({ argv, description: "Register the gisool MCP server with Claude Code (user scope)",
        undo: { argv: ["claude", "mcp", "remove", "--scope", "user", "gisool"], description: "Remove the gisool MCP server" } });
    } else {
      plan.notes.push(`manual step: run ${shown}`);
    }
    if (ctx.disableRemote && remoteRegistered(ctx.home)) {
      plan.notes.push("manual step: run claude mcp remove --scope user gisul");
    }
    return plan;
  },
  async doctorChecks(ctx) {
    const path = settingsPath(ctx);
    const text = readText(path);
    let cfg: Obj = {};
    let parsed = false;
    if (text !== null) { try { const p: unknown = JSON.parse(text); if (isObj(p)) { cfg = p; parsed = true; } } catch { /* reported below */ } }
    const env = isObj(cfg.env) ? cfg.env : {};
    const hooks = isObj(cfg.hooks) ? cfg.hooks : {};
    const endpoint = `http://127.0.0.1:${ctx.port}/ingest/otlp/v1/logs`;
    return [
      { name: "claude-code settings.json parses", ok: parsed, detail: text === null ? `missing: ${path}` : parsed ? path : "invalid JSON" },
      { name: "claude-code OTel env present", ok: env.CLAUDE_CODE_ENABLE_TELEMETRY === "1" && env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT === endpoint,
        detail: String(env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT ?? "not set") },
      { name: "claude-code hooks present", ok: hasGisoolHook(hooks.PostToolUse) && hasGisoolHook(hooks.UserPromptExpansion),
        detail: "PostToolUse and UserPromptExpansion run hook-post.mjs" },
    ];
  },
};
