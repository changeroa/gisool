import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { DEFAULT_PORT, defaultConfigFile, ensureGisoolHome, expandHome, loadConfig, resolveGisoolHome, resolveHome } from "../config.js";
import { PACKS, getPack } from "../packs/registry.js";
import type { GisoolConfig, PackCtx, PackPlan, PackPlanFile, RuntimeId, RuntimePack } from "../types.js";
import { assertPlatform } from "../version.js";
import { type AppliedFile, WriterError, applyFiles, changedFiles, maskSecrets, removeEmptyDirs, restoreFiles, unifiedDiff, unparseable } from "./config-writer.js";
import { type Io, type PlannedCommand, currentServicePlatform, daemonLogPath, nodePath, packageRoot, planService, servicePath } from "./serve.js";

export type InitOptions = { dryRun?: boolean; runtimes?: string[]; rollback?: boolean; all?: boolean; noService?: boolean; disableRemote?: boolean; serviceOnly?: boolean };
export type InitHooks = { afterPlan?: () => void | Promise<void> };

type RecordedCommand = { argv: string[]; description: string; undo?: { argv: string[]; description: string }; exitCode: number | null; allowFailure?: boolean };
export type BackupManifest = {
  version: 1; createdAt: string; status: "applied" | "failed"; home: string; runtimes: RuntimeId[]; service: string | null;
  files: AppliedFile[]; createdDirs: string[]; commands: RecordedCommand[];
  rolledBackAt?: string; rollback?: { files: { path: string; action: string }[]; commands: RecordedCommand[] };
};

// Planning never writes: a first run plans against default config and an in-memory token, and materialize() persists
// both only once the apply starts, so dry runs and aborted runs leave HOME byte-identical.
function readConfigForPlan(env: NodeJS.ProcessEnv): { config: GisoolConfig; token: string; materialize(): void } {
  const gisoolHome = resolveGisoolHome(env);
  const tokenPath = join(gisoolHome, "token");
  const configPath = join(gisoolHome, "config.json");
  if (existsSync(configPath) && existsSync(tokenPath)) {
    const config = loadConfig(env);
    return { config, token: readFileSync(tokenPath, "utf8").trim(), materialize: () => undefined };
  }
  const home = resolveHome(env);
  const d = defaultConfigFile();
  let port = DEFAULT_PORT;
  if (existsSync(configPath)) {
    const parsed = JSON.parse(readFileSync(configPath, "utf8")) as { port?: unknown };
    if (typeof parsed.port === "number") port = parsed.port;
  }
  const config: GisoolConfig = { port, captureLevel: d.captureLevel, retentionDays: d.retentionDays, roots: d.roots.map((r) => ({ id: r.id, path: expandHome(r.path, home) })), runtimes: {} };
  const token = existsSync(tokenPath) ? readFileSync(tokenPath, "utf8").trim() : randomBytes(32).toString("hex");
  return {
    config,
    token,
    materialize() {
      ensureGisoolHome(env);
      if (!existsSync(tokenPath)) {
        writeFileSync(tokenPath, token + "\n", { mode: 0o600, flag: "wx" });
        chmodSync(tokenPath, 0o600);
      }
      loadConfig(env);
    },
  };
}

export function backupsDir(gisoolHome: string): string {
  return join(gisoolHome, "backups");
}

function newBackupDir(gisoolHome: string): string {
  const root = backupsDir(gisoolHome);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replace(/[-:.]/g, "");
  let dir = join(root, stamp);
  for (let i = 1; existsSync(dir); i++) dir = join(root, `${stamp}-${String(i).padStart(3, "0")}`);
  mkdirSync(dir, { mode: 0o700 });
  return dir;
}

export function listBackupSets(gisoolHome: string): { dir: string; manifest: BackupManifest }[] {
  const root = backupsDir(gisoolHome);
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .sort()
    .reverse()
    .flatMap((name) => {
      const path = join(root, name, "manifest.json");
      if (!existsSync(path)) return [];
      return [{ dir: join(root, name), manifest: JSON.parse(readFileSync(path, "utf8")) as BackupManifest }];
    });
}

function writeManifest(dir: string, manifest: BackupManifest): void {
  const path = join(dir, "manifest.json");
  writeFileSync(path, JSON.stringify(manifest, null, 2) + "\n", { mode: 0o600 });
  chmodSync(path, 0o600);
}

function run(argv: string[], env: NodeJS.ProcessEnv, io: Io): number | null {
  const r = spawnSync(argv[0]!, argv.slice(1), { env, encoding: "utf8" });
  if (r.stdout) io.out(r.stdout);
  if (r.stderr) io.err(r.stderr);
  if (r.error) io.err(`failed to run ${argv[0]}: ${r.error.message}\n`);
  return r.status;
}

function parseRuntimeIds(ids: string[]): { ok: RuntimePack[]; unknown: string[] } {
  const ok: RuntimePack[] = [];
  const unknown: string[] = [];
  for (const id of ids) {
    const pack = getPack(id);
    if (pack) ok.push(pack);
    else unknown.push(id);
  }
  return { ok, unknown };
}

export async function runInit(opts: InitOptions, env: NodeJS.ProcessEnv, io: Io, hooks: InitHooks = {}): Promise<number> {
  assertPlatform();
  if (opts.rollback) return runRollback({ all: opts.all ?? false }, env, io);
  const home = resolveHome(env);
  const gisoolHome = resolveGisoolHome(env);
  const { config, token, materialize } = readConfigForPlan(env);
  const mask = (t: string) => maskSecrets(t, [token]);
  const ctx: PackCtx = { home, env, port: config.port, token, nodePath: nodePath(), packageRoot: packageRoot(), disableRemote: opts.disableRemote ?? false };

  const selected: RuntimePack[] = [];
  if (!opts.serviceOnly) {
    io.out("MCP connections require revision 2026-07-28 and a host resource reader; legacy initialize clients cannot connect.\n");
    const requested = parseRuntimeIds(opts.runtimes ?? []);
    if (requested.unknown.length) {
      io.err(`unknown_runtime: ${requested.unknown.join(", ")} (known: ${PACKS.map((p) => p.id).join(", ")})\n`);
      return 2;
    }
    for (const pack of PACKS) {
      const d = await pack.detect({ home, env });
      io.out(`runtime ${pack.id}: ${d.installed ? `detected (${d.evidence.join(", ")})` : "not detected"}; remoteGisulRegistered=${d.remoteGisulRegistered}\n`);
      const wanted = requested.ok.length ? requested.ok.includes(pack) : d.installed && config.runtimes[pack.id]?.enabled !== false;
      if (wanted) selected.push(pack);
    }
  }

  const plans: { id: string; plan: PackPlan }[] = [];
  for (const pack of selected) {
    try {
      plans.push({ id: pack.id, plan: await pack.plan(ctx) });
    } catch (error) {
      plans.push({ id: pack.id, plan: { files: [], commands: [], notes: [], conflicts: [{ path: pack.id, code: "plan_failed", detail: (error as Error).message }] } });
    }
  }
  let serviceFile: string | null = null;
  if (!opts.noService) {
    const svc = planService({ home, gisoolHome, env, nodePath: ctx.nodePath, packageRoot: ctx.packageRoot, platform: currentServicePlatform(), uid: process.getuid?.() ?? 0 });
    plans.push({ id: "service", plan: { files: [svc.file], commands: svc.commands, notes: svc.notes, conflicts: [] } });
    serviceFile = svc.file.path;
  }

  const files: PackPlanFile[] = plans.flatMap((p) => p.plan.files);
  const commands: PlannedCommand[] = plans.flatMap((p) => p.plan.commands);
  const conflicts = plans.flatMap((p) => p.plan.conflicts.map((c) => ({ ...c, runtime: p.id })));
  for (const f of changedFiles(files)) {
    const why = unparseable(f);
    if (why) conflicts.push({ path: f.path, code: "unparseable_config", detail: why, runtime: "writer" });
  }
  const seen = new Set<string>();
  for (const f of changedFiles(files)) {
    if (seen.has(f.path)) conflicts.push({ path: f.path, code: "duplicate_target", detail: "planned by more than one pack", runtime: "writer" });
    seen.add(f.path);
  }
  if (conflicts.length) {
    for (const c of conflicts) io.err(`conflict [${c.runtime}] ${c.path}: ${c.code}: ${c.detail}\n`);
    io.err(`aborting: ${conflicts.length} conflict(s) in ${[...new Set(conflicts.map((c) => c.path))].join(", ")}; no files were changed\n`);
    return 1;
  }

  for (const p of plans) {
    for (const f of changedFiles(p.plan.files)) io.out(mask(unifiedDiff(f.path, f.before, f.after)));
    for (const c of p.plan.commands) io.out(mask(`command [${p.id}]: ${c.argv.join(" ")}${c.undo ? `  (undo: ${c.undo.argv.join(" ")})` : ""}\n`));
    for (const n of p.plan.notes) io.out(mask(`note [${p.id}]: ${n}\n`));
  }
  const toWrite = changedFiles(files);
  if (opts.dryRun) {
    io.out(`dry run: ${toWrite.length} file(s) and ${commands.length} command(s) planned; nothing written\n`);
    return 0;
  }

  await hooks.afterPlan?.();
  materialize();
  const backupDir = newBackupDir(gisoolHome);
  if (serviceFile) mkdirSync(join(gisoolHome, "logs"), { recursive: true, mode: 0o700 });
  let applied;
  try {
    applied = applyFiles(files, { backupDir, home });
  } catch (error) {
    rmSync(backupDir, { recursive: true, force: true });
    if (error instanceof WriterError) {
      io.err(`${error.message}\naborting: no files were changed (${error.paths.join(", ")})\n`);
      return 1;
    }
    throw error;
  }

  const manifest: BackupManifest = { version: 1, createdAt: new Date().toISOString(), status: "applied", home, runtimes: selected.map((p) => p.id),
    service: serviceFile, files: applied.files, createdDirs: applied.createdDirs, commands: [] };
  for (const c of commands) {
    const exitCode = run(c.argv, { ...env, ...c.env }, io);
    manifest.commands.push({ argv: c.argv, description: c.description, ...(c.undo ? { undo: c.undo } : {}), exitCode, ...(c.allowFailure ? { allowFailure: true } : {}) });
    if (exitCode !== 0 && !c.allowFailure) {
      io.err(mask(`command failed (exit ${exitCode}): ${c.argv.join(" ")}; rolling back this run\n`));
      manifest.status = "failed";
      manifest.rolledBackAt = new Date().toISOString();
      manifest.rollback = undoRun(manifest, backupDir, env, io);
      writeManifest(backupDir, manifest);
      return 1;
    }
  }
  writeManifest(backupDir, manifest);
  if (applied.files.some((f) => f.path === serviceFile)) io.out(`service log: ${daemonLogPath(gisoolHome)}\n`);
  io.out(`applied ${applied.files.length} file(s) and ${manifest.commands.length} command(s); backup set ${backupDir}\n`);
  return 0;
}

function undoRun(manifest: BackupManifest, dir: string, env: NodeJS.ProcessEnv, io: Io): NonNullable<BackupManifest["rollback"]> {
  const commands: RecordedCommand[] = [];
  for (const c of [...manifest.commands].reverse()) {
    if (c.exitCode !== 0 || !c.undo) continue;
    if (env.GISOOL_NO_CLI) {
      io.err(`GISOOL_NO_CLI set: run manually: ${c.undo.argv.join(" ")}\n`);
      commands.push({ argv: c.undo.argv, description: c.undo.description, exitCode: null });
      continue;
    }
    commands.push({ argv: c.undo.argv, description: c.undo.description, exitCode: run(c.undo.argv, env, io) });
  }
  const files = restoreFiles(manifest.files, dir);
  removeEmptyDirs(manifest.createdDirs);
  return { files, commands };
}

export async function runRollback(opts: { all: boolean }, env: NodeJS.ProcessEnv, io: Io): Promise<number> {
  const gisoolHome = resolveGisoolHome(env);
  const sets = listBackupSets(gisoolHome).filter(
    (s) => s.manifest.status === "applied" && !s.manifest.rolledBackAt && (s.manifest.files.length > 0 || s.manifest.commands.length > 0),
  );
  if (sets.length === 0) {
    io.out("nothing to roll back\n");
    return 0;
  }
  let failed = false;
  for (const s of opts.all ? sets : sets.slice(0, 1)) {
    const result = undoRun(s.manifest, s.dir, env, io);
    for (const c of result.commands) {
      io.out(`undo: ${c.argv.join(" ")} -> ${c.exitCode === null ? "skipped" : `exit ${c.exitCode}`}\n`);
      if (c.exitCode !== 0) failed = true;
    }
    for (const f of result.files) {
      io.out(`${f.action}: ${f.path}\n`);
      if (f.action === "skipped_modified") failed = true;
    }
    s.manifest.rolledBackAt = new Date().toISOString();
    s.manifest.rollback = result;
    writeManifest(s.dir, s.manifest);
    io.out(`rolled back ${s.dir}\n`);
  }
  return failed ? 1 : 0;
}

export async function serviceInstall(opts: { dryRun?: boolean }, env: NodeJS.ProcessEnv, io: Io): Promise<number> {
  return runInit({ dryRun: opts.dryRun ?? false, serviceOnly: true }, env, io);
}

export async function serviceRemove(env: NodeJS.ProcessEnv, io: Io): Promise<number> {
  assertPlatform();
  const home = resolveHome(env);
  const platform = currentServicePlatform();
  const path = servicePath(home, platform);
  if (!existsSync(path)) {
    io.out("service not installed\n");
    return 0;
  }
  const argv = platform === "darwin"
    ? ["launchctl", "bootout", `gui/${process.getuid?.() ?? 0}/dev.gisool.daemon`]
    : ["systemctl", "--user", "disable", "--now", "gisool.service"];
  if (env.GISOOL_NO_CLI) io.out(`GISOOL_NO_CLI set: run manually: ${argv.join(" ")}\n`);
  else run(argv, env, io);
  rmSync(path, { force: true });
  io.out(`removed ${path}\n`);
  return 0;
}
