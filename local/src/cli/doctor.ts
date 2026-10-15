import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { createConnection } from "node:net";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createCatalog } from "../catalog/index.js";
import { loadConfig, resolveGisoolHome, resolveHome } from "../config.js";
import { PACKS } from "../packs/registry.js";
import { selfCheck } from "../store/db.js";
import type { GisoolConfig } from "../types.js";
import { listBackupSets } from "./init.js";
import { type Io, currentServicePlatform, dbPath, packageVersion, serviceLoaded, servicePath } from "./serve.js";

export type CheckStatus = "ok" | "warn" | "fail" | "skip";
export type DoctorCheck = { name: string; status: CheckStatus; code?: string; detail: string };
export type SkillFamily = { id: string; members: string[] };
export type DoctorReport = { ok: boolean; version: string; checks: DoctorCheck[]; families: SkillFamily[] };

const HOOK_LIMIT_S = 5;
const HERDR_TIMEOUT_MS = 2000;
type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => v !== null && typeof v === "object" && !Array.isArray(v);

function herdrCommand(args: string[]): { ok: boolean; output: string } {
  const result = spawnSync("herdr", args, { encoding: "utf8", timeout: HERDR_TIMEOUT_MS, maxBuffer: 1024 * 1024 });
  return { ok: result.status === 0, output: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim() };
}

function herdrPing(socketPath: string): Promise<{ protocol?: unknown }> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let response = "";
    const timer = setTimeout(() => socket.destroy(new Error("herdr socket timed out")), HERDR_TIMEOUT_MS);
    const fail = (error: Error) => {
      clearTimeout(timer);
      socket.destroy();
      reject(error);
    };
    socket.once("error", fail);
    socket.once("connect", () => socket.write('{"id":"1","method":"ping","params":{}}\n'));
    socket.on("data", (chunk: Buffer) => {
      response += chunk.toString("utf8");
      const newline = response.indexOf("\n");
      if (newline < 0) return;
      try {
        const line: unknown = JSON.parse(response.slice(0, newline));
        if (!isObj(line) || !isObj(line.result) || line.result.type !== "pong") throw new Error("invalid herdr ping response");
        clearTimeout(timer);
        socket.destroy();
        resolve({ protocol: line.result.protocol });
      } catch (error) {
        fail(error as Error);
      }
    });
  });
}

async function herdrCheck(env: NodeJS.ProcessEnv): Promise<DoctorCheck> {
  let socketPath = env.GISOOL_HERDR_SOCKET;
  let version = "";
  if (!socketPath) {
    const versionResult = herdrCommand(["--version"]);
    if (!versionResult.ok) {
      return { name: "herdr", status: "fail", code: "herdr_unavailable", detail: `install herdr and start it: herdr (${versionResult.output || "herdr --version failed"})` };
    }
    version = versionResult.output;
    const status = herdrCommand(["status", "server"]);
    const match = status.ok ? status.output.match(/^\s*socket:\s*(.+?)\s*$/mi) : null;
    if (!match) {
      return { name: "herdr", status: "fail", code: "herdr_unavailable", detail: `install herdr and start it: herdr (${status.output || "could not resolve herdr socket"})` };
    }
    socketPath = match[1];
  }
  try {
    const pong = await herdrPing(socketPath);
    const info = [version && `version ${version}`, pong.protocol !== undefined && `protocol ${String(pong.protocol)}`].filter(Boolean).join(", ");
    return { name: "herdr", status: "ok", detail: `herdr ping succeeded${info ? ` (${info})` : ""}` };
  } catch (error) {
    return { name: "herdr", status: "fail", code: "herdr_unavailable", detail: `install herdr and start it: herdr (${(error as Error).message})` };
  }
}

function readJson(path: string): Obj | undefined {
  try {
    const v: unknown = JSON.parse(readFileSync(path, "utf8"));
    return isObj(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

function gisoolHookTimeouts(cfg: Obj | undefined, unitSeconds: number): { event: string; seconds: number }[] {
  const out: { event: string; seconds: number }[] = [];
  const hooks = cfg && isObj(cfg.hooks) ? cfg.hooks : {};
  const visit = (event: string, h: unknown) => {
    if (!isObj(h) || typeof h.command !== "string" || !h.command.includes("hook-post.mjs")) return;
    if (typeof h.timeout === "number") out.push({ event, seconds: h.timeout * unitSeconds });
    if (Array.isArray(h.hooks)) for (const inner of h.hooks) visit(event, inner);
  };
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue;
    for (const g of groups) {
      if (isObj(g) && Array.isArray(g.hooks)) for (const h of g.hooks) visit(event, h);
      else visit(event, g);
    }
  }
  return out;
}

function hookTimeoutCheck(home: string, env: NodeJS.ProcessEnv): DoctorCheck {
  const sources: [path: string, unitSeconds: number][] = [
    [join(env.CLAUDE_CONFIG_DIR || join(home, ".claude"), "settings.json"), 1],
    [join(home, ".gemini", "settings.json"), 0.001],
    [join(home, ".cursor", "hooks.json"), 1],
  ];
  const tooLong: string[] = [];
  for (const [path, unit] of sources) {
    for (const t of gisoolHookTimeouts(readJson(path), unit)) if (t.seconds > HOOK_LIMIT_S) tooLong.push(`${path} ${t.event} ${t.seconds}s`);
  }
  return tooLong.length
    ? { name: "hook_timeouts", status: "fail", code: "hook_timeout_too_long", detail: `gisool hooks must time out within ${HOOK_LIMIT_S}s: ${tooLong.join("; ")}` }
    : { name: "hook_timeouts", status: "ok", detail: `all gisool hook timeouts <= ${HOOK_LIMIT_S}s` };
}

async function healthCheck(port: number, gisoolHome: string): Promise<DoctorCheck> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(1500) });
    const body = (await res.json().catch(() => undefined)) as { ok?: unknown; version?: unknown } | undefined;
    if (res.status !== 200 || body?.ok !== true || typeof body.version !== "string") {
      return { name: "daemon", status: "fail", code: "not_gisool", detail: `port ${port} answered /healthz with ${res.status} but it is not gisool` };
    }
    const mine = packageVersion();
    if (body.version !== mine) return { name: "daemon", status: "warn", code: "version_mismatch", detail: `daemon ${body.version}, CLI ${mine}` };
    const tokenPath = join(gisoolHome, "token");
    if (existsSync(tokenPath)) {
      const stats = await fetch(`http://127.0.0.1:${port}/api/stats`, {
        headers: { authorization: `Bearer ${readFileSync(tokenPath, "utf8").trim()}` },
        signal: AbortSignal.timeout(1500),
      });
      if (stats.status === 401) {
        return { name: "daemon", status: "fail", code: "token_mismatch", detail: `gisool ${body.version} on 127.0.0.1:${port} rejected this install's token: the port is held by another gisool instance, or the token was rotated; restart the daemon` };
      }
    }
    return { name: "daemon", status: "ok", detail: `gisool ${body.version} on 127.0.0.1:${port}` };
  } catch (error) {
    return { name: "daemon", status: "fail", code: "daemon_unreachable", detail: `no response from http://127.0.0.1:${port}/healthz (${(error as Error).message})` };
  }
}

function serviceCheck(home: string, env: NodeJS.ProcessEnv): DoctorCheck {
  if (env.GISOOL_NO_CLI) return { name: "service", status: "skip", detail: "GISOOL_NO_CLI set" };
  const platform = currentServicePlatform();
  const path = servicePath(home, platform);
  if (!existsSync(path)) return { name: "service", status: "warn", code: "service_not_installed", detail: `${path} missing; run gisool service install` };
  return serviceLoaded(platform, process.getuid?.() ?? 0, env)
    ? { name: "service", status: "ok", detail: `${path} loaded` }
    : { name: "service", status: "fail", code: "service_not_loaded", detail: `${path} exists but the service is not loaded` };
}

function tokenCheck(gisoolHome: string): DoctorCheck {
  const path = join(gisoolHome, "token");
  if (!existsSync(path)) return { name: "token_mode", status: "fail", code: "token_missing", detail: path };
  const mode = statSync(path).mode & 0o777;
  return mode === 0o600
    ? { name: "token_mode", status: "ok", detail: `${path} 0600` }
    : { name: "token_mode", status: "fail", code: "token_mode_insecure", detail: `${path} is 0${mode.toString(8)}; expected 0600` };
}

function ftsCheck(): DoctorCheck {
  try {
    selfCheck();
    return { name: "fts5", status: "ok", detail: "FTS5 trigram tokenizer works" };
  } catch (error) {
    return { name: "fts5", status: "fail", code: "fts5_trigram_unavailable", detail: (error as Error).message };
  }
}

async function catalogChecks(config: GisoolConfig, gisoolHome: string): Promise<{ checks: DoctorCheck[]; families: SkillFamily[] }> {
  const catalog = createCatalog({ roots: config.roots, log: () => undefined });
  try {
    await catalog.refresh();
    const report = catalog.report();
    const unreadable = report.roots.filter((r) => !r.readable);
    const nameByUri = new Map(catalog.list().map((e) => [e.uri, e.name]));
    const families: SkillFamily[] = report.families.map((f) => ({ id: f.id, members: [...new Set(f.uris.map((u) => nameByUri.get(u) ?? u))].sort() }));
    const checks: DoctorCheck[] = [
      unreadable.length
        ? { name: "roots", status: "warn", code: "root_unreadable", detail: `unreadable or missing: ${unreadable.map((r) => r.path).join(", ")}` }
        : { name: "roots", status: "ok", detail: `${report.roots.length} root(s) readable` },
      { name: "duplicates", status: report.duplicates.length ? "warn" : "ok", detail: `${report.duplicates.length} duplicate skill name(s)${report.duplicates.length ? `: ${report.duplicates.map((d) => d.name).join(", ")}` : ""}` },
      { name: "skill_families", status: "ok", detail: families.length ? families.map((f) => `${f.id}: ${f.members.join(", ")}`).join("; ") : "none" },
    ];
    const path = dbPath(gisoolHome);
    if (!existsSync(path)) {
      checks.push({ name: "index_freshness", status: "warn", code: "index_missing", detail: `${path} not created yet; start the daemon` });
      return { checks, families };
    }
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      const rows = db.prepare("SELECT uri, manifest_digest FROM skills WHERE removed_at IS NULL").all() as { uri: string; manifest_digest: string }[];
      const indexed = new Map(rows.map((r) => [r.uri, r.manifest_digest]));
      const live = catalog.list();
      const stale = live.filter((e) => indexed.get(e.uri) !== e.manifestDigest).length + rows.filter((r) => !live.some((e) => e.uri === r.uri)).length;
      checks.push(stale === 0
        ? { name: "index_freshness", status: "ok", detail: `${live.length} skill(s) indexed and current` }
        : { name: "index_freshness", status: "fail", code: "index_stale", detail: `${stale} skill(s) differ between the catalog and ${path}; restart the daemon` });
    } finally {
      db.close();
    }
    return { checks, families };
  } finally {
    catalog.close();
  }
}

function lastBackupCheck(gisoolHome: string, now: number): DoctorCheck {
  const latest = listBackupSets(gisoolHome)[0];
  if (!latest) return { name: "last_backup", status: "ok", detail: "none" };
  const ageH = Math.round((now - Date.parse(latest.manifest.createdAt)) / 3_600_000);
  return { name: "last_backup", status: "ok", detail: `${latest.dir} (${ageH} h ago)` };
}

export async function collectDoctor(env: NodeJS.ProcessEnv): Promise<DoctorReport> {
  const home = resolveHome(env);
  const gisoolHome = resolveGisoolHome(env);
  const config = loadConfig(env);
  const checks: DoctorCheck[] = [serviceCheck(home, env), await healthCheck(config.port, gisoolHome)];
  checks.push(await herdrCheck(env));

  const remote: string[] = [];
  const packChecks: DoctorCheck[] = [];
  for (const pack of PACKS) {
    const d = await pack.detect({ home, env });
    if (d.remoteGisulRegistered) remote.push(pack.id);
    if (!d.installed || config.runtimes[pack.id]?.enabled === false) continue;
    for (const c of await pack.doctorChecks({ home, env, port: config.port })) {
      packChecks.push({ name: `${pack.id}: ${c.name}`, status: c.ok ? "ok" : "fail", detail: c.detail });
    }
  }
  checks.push(remote.length
    ? { name: "remote_gisul", status: "warn", code: "remote_gisul_registered", detail: `remote gisul is also registered in: ${remote.join(", ")} (gisool init --disable-remote turns it off)` }
    : { name: "remote_gisul", status: "ok", detail: "no remote gisul registration found" });
  const catalogResult = await catalogChecks(config, gisoolHome);
  checks.push(tokenCheck(gisoolHome), ftsCheck(), ...catalogResult.checks, ...packChecks, hookTimeoutCheck(home, env), lastBackupCheck(gisoolHome, Date.now()));
  return { ok: checks.every((c) => c.status !== "fail"), version: packageVersion(), checks, families: catalogResult.families };
}

export async function runDoctor(opts: { json?: boolean }, env: NodeJS.ProcessEnv, io: Io): Promise<number> {
  const report = await collectDoctor(env);
  if (opts.json) io.out(JSON.stringify(report, null, 2) + "\n");
  else {
    for (const c of report.checks) io.out(`[${c.status}] ${c.name}: ${c.detail}${c.code ? ` (${c.code})` : ""}\n`);
    io.out(report.ok ? "doctor: all checks passed\n" : "doctor: some checks failed\n");
  }
  return report.ok ? 0 : 1;
}
