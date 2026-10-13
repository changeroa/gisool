import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, rmdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import type { PackPlanFile } from "../types.js";

export class WriterError extends Error {
  readonly code: string;
  readonly paths: string[];
  constructor(code: string, message: string, paths: string[] = []) {
    super(`${code}: ${message}`);
    this.name = "WriterError";
    this.code = code;
    this.paths = paths;
  }
}

export const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

export function readTarget(path: string): string | null {
  let st;
  try {
    st = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (!st.isFile()) throw new WriterError("not_a_regular_file", `expected a regular file: ${path}`, [path]);
  return readFileSync(path, "utf8");
}

export const changedFiles = (files: PackPlanFile[]): PackPlanFile[] => files.filter((f) => f.before !== f.after);

export function maskSecrets(text: string, secrets: string[]): string {
  let out = text;
  for (const s of secrets) if (s.length >= 8) out = out.replaceAll(s, "<gisool-token>");
  return out;
}

function splitLines(text: string | null): string[] {
  if (text === null || text === "") return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

type Op = { tag: " " | "-" | "+"; line: string };

function diffOps(a: string[], b: string[]): Op[] {
  const n = a.length;
  const m = b.length;
  if (n * m > 25_000_000) return [...a.map((line) => ({ tag: "-" as const, line })), ...b.map((line) => ({ tag: "+" as const, line }))];
  // LCS table over suffixes; lcs[i][j] = LCS length of a[i..] and b[j..].
  const w = m + 1;
  const lcs = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i * w + j] = a[i] === b[j] ? lcs[(i + 1) * w + j + 1]! + 1 : Math.max(lcs[(i + 1) * w + j]!, lcs[i * w + j + 1]!);
    }
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ tag: " ", line: a[i]! });
      i++;
      j++;
    } else if (lcs[(i + 1) * w + j]! >= lcs[i * w + j + 1]!) ops.push({ tag: "-", line: a[i++]! });
    else ops.push({ tag: "+", line: b[j++]! });
  }
  while (i < n) ops.push({ tag: "-", line: a[i++]! });
  while (j < m) ops.push({ tag: "+", line: b[j++]! });
  return ops;
}

export function unifiedDiff(path: string, before: string | null, after: string | null, context = 3): string {
  if (before === after) return "";
  const ops = diffOps(splitLines(before), splitLines(after));
  const header = [`--- ${before === null ? "/dev/null" : `a${path}`}`, `+++ ${after === null ? "/dev/null" : `b${path}`}`];
  const changes = ops.map((op, idx) => (op.tag === " " ? -1 : idx)).filter((idx) => idx >= 0);
  if (changes.length === 0) return [...header, "@@ whitespace or trailing newline only @@"].join("\n") + "\n";
  const hunks: [number, number][] = [];
  for (const idx of changes) {
    const start = Math.max(0, idx - context);
    const end = Math.min(ops.length, idx + context + 1);
    const last = hunks[hunks.length - 1];
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else hunks.push([start, end]);
  }
  const out = [...header];
  for (const [start, end] of hunks) {
    let aLine = 1;
    let bLine = 1;
    for (let k = 0; k < start; k++) {
      if (ops[k]!.tag !== "+") aLine++;
      if (ops[k]!.tag !== "-") bLine++;
    }
    const slice = ops.slice(start, end);
    const aLen = slice.filter((o) => o.tag !== "+").length;
    const bLen = slice.filter((o) => o.tag !== "-").length;
    out.push(`@@ -${aLen === 0 ? aLine - 1 : aLine},${aLen} +${bLen === 0 ? bLine - 1 : bLine},${bLen} @@`);
    for (const o of slice) out.push(`${o.tag}${o.line}`);
  }
  return out.join("\n") + "\n";
}

/** Unparseable targets are refused: only JSON is checked structurally (TOML and other formats are validated by their pack). */
export function unparseable(file: PackPlanFile): string | undefined {
  if (!file.path.endsWith(".json") || file.before === null || file.before.trim() === "") return undefined;
  try {
    JSON.parse(file.before);
    return undefined;
  } catch (error) {
    return (error as Error).message;
  }
}

export function backupPathFor(backupDir: string, home: string, path: string): string {
  const rel = relative(home, path);
  return rel && !rel.startsWith("..") && !isAbsolute(rel) ? join(backupDir, "files", rel) : join(backupDir, "files", "_root", path);
}

function snapshot(path: string): { exists: boolean; mtimeMs: number; digest: string | null } {
  const text = readTarget(path);
  return { exists: text !== null, mtimeMs: text === null ? 0 : statSync(path).mtimeMs, digest: text === null ? null : sha256(text) };
}

function mkdirTracked(dir: string, created: string[]): void {
  const missing: string[] = [];
  let cur = dir;
  while (!existsSync(cur)) {
    missing.unshift(cur);
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  for (const d of missing) {
    mkdirSync(d, { mode: 0o700 });
    created.push(d);
  }
}

function atomicWrite(path: string, content: string, mode: number, expected: ReturnType<typeof snapshot> | null): void {
  const tmp = `${path}.gisool-${randomUUID()}.tmp`;
  try {
    writeFileSync(tmp, content, { flag: "wx", mode });
    chmodSync(tmp, mode);
    if (expected) {
      // Re-read mtime + digest immediately before the rename so a concurrent editor's change is never clobbered.
      const now = snapshot(path);
      if (now.exists !== expected.exists || now.digest !== expected.digest || now.mtimeMs !== expected.mtimeMs) {
        throw new WriterError("concurrent_modification", `file changed during apply: ${path}`, [path]);
      }
    }
    renameSync(tmp, path);
  } finally {
    rmSync(tmp, { force: true });
  }
}

export type AppliedFile = { path: string; backup: string | null; existed: boolean; beforeDigest: string | null; afterDigest: string; mode: number };
export type ApplyResult = { files: AppliedFile[]; createdDirs: string[] };

/**
 * Applies planned files atomically. Validates the whole plan first (unparseable or changed-since-plan files abort before
 * any write), backs up originals under backupDir mirroring their path relative to home (0600), writes via temp + rename
 * preserving an existing file's mode, and on any failure restores every file already written.
 */
export function applyFiles(files: PackPlanFile[], opts: { backupDir: string; home: string }): ApplyResult {
  const todo = changedFiles(files);
  const bad = todo.filter((f) => unparseable(f) !== undefined);
  if (bad.length) throw new WriterError("unparseable_config", `refusing to edit unparseable file(s): ${bad.map((f) => f.path).join(", ")}`, bad.map((f) => f.path));
  const moved = todo.filter((f) => readTarget(f.path) !== f.before);
  if (moved.length) throw new WriterError("modified_since_plan", `file(s) changed after the plan was made: ${moved.map((f) => f.path).join(", ")}`, moved.map((f) => f.path));

  const applied: AppliedFile[] = [];
  const createdDirs: string[] = [];
  const written: PackPlanFile[] = [];
  try {
    for (const f of todo) {
      const expected = snapshot(f.path);
      if (expected.digest !== (f.before === null ? null : sha256(f.before))) {
        throw new WriterError("modified_since_plan", `file changed after the plan was made: ${f.path}`, [f.path]);
      }
      let backup: string | null = null;
      if (f.before !== null) {
        backup = backupPathFor(opts.backupDir, opts.home, f.path);
        mkdirSync(dirname(backup), { recursive: true, mode: 0o700 });
        writeFileSync(backup, f.before, { flag: "wx", mode: 0o600 });
        chmodSync(backup, 0o600);
      }
      const mode = f.before !== null ? statSync(f.path).mode & 0o777 : f.mode;
      mkdirTracked(dirname(f.path), createdDirs);
      atomicWrite(f.path, f.after, mode, expected);
      written.push(f);
      applied.push({ path: f.path, backup: backup === null ? null : relative(opts.backupDir, backup), existed: f.before !== null,
        beforeDigest: f.before === null ? null : sha256(f.before), afterDigest: sha256(f.after), mode });
    }
  } catch (error) {
    restoreWritten(written);
    removeEmptyDirs(createdDirs);
    throw error;
  }
  return { files: applied, createdDirs };
}

function restoreWritten(written: PackPlanFile[]): void {
  for (const f of [...written].reverse()) {
    if (readTarget(f.path) !== f.after) continue;
    if (f.before === null) rmSync(f.path, { force: true });
    else atomicWrite(f.path, f.before, statSync(f.path).mode & 0o777, null);
  }
}

export function removeEmptyDirs(dirs: string[]): void {
  for (const d of [...dirs].reverse()) {
    try {
      rmdirSync(d);
    } catch {
      // Non-empty (someone else wrote there) or already gone: keep it.
    }
  }
}

export type RestoreOutcome = { path: string; action: "restored" | "removed" | "skipped_modified" | "unchanged" };

/** Restores files recorded by applyFiles from backupDir; files edited since gisool wrote them are left alone. */
export function restoreFiles(files: AppliedFile[], backupDir: string): RestoreOutcome[] {
  const out: RestoreOutcome[] = [];
  for (const f of [...files].reverse()) {
    const current = readTarget(f.path);
    if (current === null && !f.existed) {
      out.push({ path: f.path, action: "unchanged" });
      continue;
    }
    if (current === null || sha256(current) !== f.afterDigest) {
      out.push({ path: f.path, action: "skipped_modified" });
      continue;
    }
    if (!f.existed || f.backup === null) {
      rmSync(f.path, { force: true });
      out.push({ path: f.path, action: "removed" });
      continue;
    }
    const original = readFileSync(join(backupDir, f.backup), "utf8");
    atomicWrite(f.path, original, f.mode, null);
    out.push({ path: f.path, action: "restored" });
  }
  return out;
}
