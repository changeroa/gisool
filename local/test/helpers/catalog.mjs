import { readdirSync, lstatSync } from "node:fs";
import { join } from "node:path";

/** Recursive listing of dir: relative path -> { size, mtimeMs, type }, without following symlinks. */
export function snapshotTree(dir) {
  const out = {};
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const p = join(dir, entry.name);
    const info = lstatSync(p);
    out[entry.name] = { size: info.size, mtimeMs: info.mtimeMs, type: info.isSymbolicLink() ? "link" : info.isDirectory() ? "dir" : "file" };
    if (entry.isDirectory()) for (const [rel, v] of Object.entries(snapshotTree(p))) out[entry.name + "/" + rel] = v;
  }
  return out;
}

export const quietLog = () => {};
