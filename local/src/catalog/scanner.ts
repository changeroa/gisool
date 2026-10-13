// Ported from server/src/index.ts @48e7955
import { createHash } from "node:crypto";
import { lstat, readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { SkillEntry } from "../types.js";
import { extractFields, splitSkillMarkdown } from "./fields.js";
import { skillUri } from "./uri.js";

/** SEP-2640 limits per skill. */
export const MAX_SKILL_RESOURCE_COUNT = 512;
export const MAX_SKILL_TOTAL_BYTES = 16 * 1024 * 1024;

export class CatalogError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "CatalogError";
    this.code = code;
  }
}

export function sha256(bytes: Uint8Array | string): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export function manifestDigest(resources: SkillEntry["resources"]): string {
  const sorted = resources.map(({ uri, digest, size }) => ({ uri, digest, size })).sort((a, b) => (a.uri < b.uri ? -1 : a.uri > b.uri ? 1 : 0));
  return sha256(JSON.stringify(sorted));
}

/** Regular files under baseDir (relative posix paths), skipping dotfiles, node_modules and symlinks. */
export async function collectSkillRelativeFiles(baseDir: string): Promise<{ relative: string; size: number }[]> {
  const output: { relative: string; size: number }[] = [];
  async function walk(dir: string, prefix: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(path.join(dir, entry.name), relative);
      } else if (entry.isFile()) {
        const info = await lstat(path.join(dir, entry.name));
        if (info.isFile()) output.push({ relative, size: info.size });
      }
    }
  }
  await walk(baseDir, "");
  return output.sort((a, b) => (a.relative < b.relative ? -1 : a.relative > b.relative ? 1 : 0));
}

/** Directories (relative to rootDir, never through symlinked dirs) that contain a SKILL.md. */
export async function listSkillEntryDirs(rootDir: string): Promise<string[]> {
  const output: string[] = [];
  async function walk(dir: string, prefix: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      try {
        const info = await stat(path.join(dir, entry.name, "SKILL.md"));
        if (info.isFile()) output.push(relative);
      } catch {
        // not a skill directory; descendants may still contain one
      }
      await walk(path.join(dir, entry.name), relative);
    }
  }
  await walk(rootDir, "");
  return output.sort();
}

export type ScannedSkill = { entry: SkillEntry; explicitGroup?: { id: string; stage?: string } };

/** Builds one entry; returns null (with a stderr note) for anything that must not be served. Reads but never writes. */
export async function buildSkillEntry(rootId: string, rootDir: string, dir: string, log: (msg: string) => void = console.error): Promise<ScannedSkill | null> {
  const skillDir = path.join(rootDir, dir);
  const skillPath = path.join(skillDir, "SKILL.md");
  let mtimeMs: number;
  try {
    const info = await lstat(skillPath);
    if (!info.isFile() || info.isSymbolicLink()) {
      log(`Skipping skill ${rootId}/${dir}: SKILL.md must be a regular file`);
      return null;
    }
    mtimeMs = info.mtimeMs;
  } catch {
    return null;
  }

  const files = await collectSkillRelativeFiles(skillDir);
  const declaredBytes = files.reduce((sum, f) => sum + f.size, 0);
  if (files.length > MAX_SKILL_RESOURCE_COUNT || declaredBytes > MAX_SKILL_TOTAL_BYTES) {
    log(`Skipping skill ${rootId}/${dir}: exceeds SEP-2640 limits (${files.length} resources, ${declaredBytes} bytes)`);
    return null;
  }

  let fields: ReturnType<typeof extractFields> = null;
  let skillDigest: string | undefined;
  const resources: SkillEntry["resources"] = [];
  let totalBytes = 0;
  for (const { relative } of files) {
    const bytes = await readFile(path.join(skillDir, relative));
    totalBytes += bytes.byteLength;
    const digest = sha256(bytes);
    resources.push({ uri: skillUri(rootId, dir, relative), digest, size: bytes.byteLength });
    if (relative === "SKILL.md") {
      skillDigest = digest;
      const { frontmatter, body } = splitSkillMarkdown(bytes.toString("utf8"));
      fields = frontmatter ? extractFields(frontmatter, body) : null;
    }
  }
  if (resources.length > MAX_SKILL_RESOURCE_COUNT || totalBytes > MAX_SKILL_TOTAL_BYTES) {
    log(`Skipping skill ${rootId}/${dir}: exceeds SEP-2640 limits (${resources.length} resources, ${totalBytes} bytes)`);
    return null;
  }
  if (!skillDigest) return null;
  if (!fields) {
    log(`Skipping skill ${rootId}/${dir}: SKILL.md frontmatter requires name and description`);
    return null;
  }
  if (fields.name !== dir.split("/").pop()) {
    log(`Skipping skill ${rootId}/${dir}: frontmatter name "${fields.name}" does not match directory name`);
    return null;
  }

  const { group, ...rest } = fields;
  const entry: SkillEntry = {
    uri: skillUri(rootId, dir, "SKILL.md"),
    rootId,
    dir,
    ...rest,
    digest: skillDigest,
    manifestDigest: manifestDigest(resources),
    resources,
    mtimeMs,
  };
  return group ? { entry, explicitGroup: group } : { entry };
}

/** Scans one root; a missing or unreadable root is reported as readable: false, not thrown. */
export async function scanRoot(root: { id: string; path: string }, log: (msg: string) => void = console.error): Promise<{ readable: boolean; skills: ScannedSkill[] }> {
  let dirs: string[];
  try {
    const info = await stat(root.path);
    if (!info.isDirectory()) return { readable: false, skills: [] };
    dirs = await listSkillEntryDirs(root.path);
  } catch {
    return { readable: false, skills: [] };
  }
  const skills: ScannedSkill[] = [];
  for (const dir of dirs) {
    try {
      const skill = await buildSkillEntry(root.id, root.path, dir, log);
      if (skill) skills.push(skill);
    } catch (error) {
      log(`Failed to build skill entry for ${root.id}/${dir}: ${(error as Error).message}`);
    }
  }
  return { readable: true, skills };
}

/** Resolves segments under rootDir, refusing traversal outside the root and any symlink along the way. */
export async function assertRegularSkillPath(rootDir: string, segments: string[]): Promise<string> {
  const relativePath = path.posix.normalize(segments.join("/"));
  const filePath = path.resolve(rootDir, relativePath);
  const relativeToRoot = path.relative(rootDir, filePath);
  if (!relativeToRoot || relativeToRoot.startsWith("..") || path.isAbsolute(relativeToRoot)) {
    throw new CatalogError("path_outside_root", "resource path escapes its skill root");
  }
  let current = rootDir;
  const parts = relativeToRoot.split(path.sep);
  for (const [index, segment] of parts.entries()) {
    current = path.join(current, segment);
    let info;
    try {
      info = await lstat(current);
    } catch {
      throw new CatalogError("unknown_resource", "unknown or inaccessible skill resource");
    }
    if (info.isSymbolicLink()) throw new CatalogError("symlink_refused", "symbolic links inside skill roots are not served");
    if (index === parts.length - 1 ? !info.isFile() : !info.isDirectory()) {
      throw new CatalogError("unknown_resource", "skill resources require regular files and directories");
    }
  }
  return current;
}
