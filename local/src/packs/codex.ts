import { accessSync, constants, existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, delimiter, resolve } from "node:path";
import type { PackCtx, PackPlan, RuntimePack } from "../types.js";

type Env = NodeJS.ProcessEnv;
const BEGIN = "# >>> gisool managed";
const END = "# <<< gisool managed";
const tomlEsc = (v: string) => JSON.stringify(v).slice(1, -1);

function onPath(bin: string, env: Env): string | undefined {
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const p = join(dir, bin);
    try { if (statSync(p).isFile()) { accessSync(p, constants.X_OK); return p; } } catch { /* next */ }
  }
  return undefined;
}

const codexDir = (c: { home: string; env: Env }) => c.env.CODEX_HOME || join(c.home, ".codex");
const configPath = (c: { home: string; env: Env }) => join(codexDir(c), "config.toml");
function readText(p: string): string | null {
  try { return readFileSync(p, "utf8"); } catch { return null; }
}

function realOrResolved(p: string): string {
  try { return realpathSync(p); } catch { return resolve(p); }
}

/** Splits text into the managed block (if any) and the rest. */
function splitManaged(text: string): { outside: string; start: number; end: number } | null {
  const s = text.indexOf(BEGIN);
  if (s < 0) return null;
  const e = text.indexOf(END, s);
  if (e < 0) return null;
  let end = e + END.length;
  if (text[end] === "\n") end++;
  return { outside: text.slice(0, s) + text.slice(end), start: s, end };
}

const OTEL_RE = /^\s*(\[\[?\s*otel\s*(\]|\.)|otel\s*\.)/m;
const GISOOL_TABLE_RE = /^\s*\[\s*mcp_servers\.gisool\s*\]/m;

/** Returns the body of the [mcp_servers.gisul] table, or null. */
function gisulTable(text: string): { start: number; end: number; body: string } | null {
  const m = /^\[\s*mcp_servers\.gisul\s*\][^\n]*\n?/m.exec(text);
  if (!m) return null;
  const start = m.index + m[0].length;
  const next = /^\s*\[/m.exec(text.slice(start));
  const end = next ? start + next.index : text.length;
  return { start, end, body: text.slice(start, end) };
}

function remoteRegistered(text: string | null): boolean {
  if (text === null) return false;
  const t = gisulTable(text);
  if (!t) return false;
  const url = /^\s*url\s*=\s*"([^"]*)"/m.exec(t.body)?.[1];
  if (url) return !/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/.test(url);
  return /mcp-remote/.test(t.body);
}

function block(ctx: PackCtx): string {
  return readFileSync(join(ctx.packageRoot, "packs", "codex", "config.template.toml"), "utf8")
    .replaceAll("{{PORT}}", String(ctx.port)).replaceAll("{{TOKEN}}", tomlEsc(ctx.token));
}

export const codexPack: RuntimePack = {
  id: "codex",
  async detect(ctx) {
    const evidence: string[] = [];
    const dir = codexDir(ctx);
    if (existsSync(dir)) evidence.push(dir);
    const bin = onPath("codex", ctx.env);
    if (bin) evidence.push(bin);
    return { installed: evidence.length > 0, evidence, remoteGisulRegistered: remoteRegistered(readText(configPath(ctx))) };
  },
  async plan(ctx): Promise<PackPlan> {
    const plan: PackPlan = { files: [], commands: [], notes: [], conflicts: [] };
    const path = configPath(ctx);
    const before = readText(path);
    const text = before ?? "";
    const managed = splitManaged(text);
    const outside = managed ? managed.outside : text;
    if (OTEL_RE.test(outside)) {
      plan.conflicts.push({ path, code: "unmanaged_otel", detail: "config.toml already has an unmanaged [otel] table or otel.* keys; refusing to edit" });
    }
    if (GISOOL_TABLE_RE.test(outside)) {
      plan.conflicts.push({ path, code: "unmanaged_gisool_mcp", detail: "config.toml already has an unmanaged [mcp_servers.gisool] table" });
    }
    if (plan.conflicts.length) return plan;

    const wanted = block(ctx);
    let after: string;
    if (managed) {
      after = text.slice(0, managed.start) + wanted + text.slice(managed.end);
    } else {
      const sep = text === "" ? "" : text.endsWith("\n") ? "\n" : "\n\n";
      after = text + sep + wanted;
    }

    if (ctx.disableRemote) {
      const t = gisulTable(after);
      if (t && remoteRegistered(after)) {
        const body = /^\s*enabled\s*=.*$/m.test(t.body)
          ? t.body.replace(/^(\s*)enabled\s*=.*$/m, "$1enabled = false")
          : "enabled = false\n" + t.body;
        after = after.slice(0, t.start) + body + after.slice(t.end);
        plan.notes.push("remote gisul MCP entry disabled with enabled = false");
      }
    }
    if (after !== before) plan.files.push({ path, before, after, mode: 0o600 });
    plan.notes.push("codex exec exports OTel events only partially; no Codex hooks are installed (they require trust review)");
    return plan;
  },
  async doctorChecks(ctx) {
    const path = configPath(ctx);
    const text = readText(path);
    const managed = text === null ? null : splitManaged(text);
    const inner = managed && text ? text.slice(managed.start, managed.end) : "";
    const endpoint = `http://127.0.0.1:${ctx.port}/ingest/otlp/v1/logs`;
    // A project-local .codex/config.toml counts only when it is a different file from the user-level config (doctor run
    // from $HOME reads the same file), and gisool's own managed block there is not a conflict.
    const localPath = join(process.cwd(), ".codex", "config.toml");
    const local = realOrResolved(localPath) === realOrResolved(path) ? null : readText(localPath);
    const localOutside = local === null ? null : (splitManaged(local)?.outside ?? local);
    return [
      { name: "codex OTel block present", ok: inner.includes("[otel]") && inner.includes(endpoint), detail: managed ? path : `no managed block in ${path}` },
      { name: "codex MCP entry present", ok: inner.includes("[mcp_servers.gisool]") && inner.includes(`http://127.0.0.1:${ctx.port}/mcp`), detail: path },
      { name: "codex [otel] not in project-local config", ok: localOutside === null || !OTEL_RE.test(localOutside),
        detail: local === null ? "no project-local config" : "project-local .codex/config.toml defines otel" },
    ];
  },
};
