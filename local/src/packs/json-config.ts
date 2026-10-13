import { existsSync, readFileSync, statSync } from "node:fs";
import type { PackPlan, PackPlanFile } from "../types.js";

export type JsonObject = Record<string, unknown>;
export type JsonConfig = { before: string | null; obj: JsonObject; error?: string };

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

export function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readJsonConfig(path: string): JsonConfig {
  if (!existsSync(path)) return { before: null, obj: {} };
  const before = readFileSync(path, "utf8");
  if (before.trim() === "") return { before, obj: {} };
  try {
    const parsed: unknown = JSON.parse(before);
    if (isObject(parsed)) return { before, obj: parsed };
    return { before, obj: {}, error: "top-level value is not a JSON object" };
  } catch (err) {
    return { before, obj: {}, error: `not valid JSON: ${(err as Error).message}` };
  }
}

export function fileMode(path: string): number {
  return existsSync(path) ? statSync(path).mode & 0o777 : 0o600;
}

export function planJsonFile(path: string, current: JsonConfig, next: JsonObject): PackPlanFile | null {
  const after = `${JSON.stringify(next, null, 2)}\n`;
  if (after === current.before) return null;
  return { path, before: current.before, after, mode: fileMode(path) };
}

export function refuse(path: string, code: string, detail: string): PackPlan {
  return { files: [], commands: [], notes: [], conflicts: [{ path, code, detail }] };
}

export function noop(note: string): PackPlan {
  return { files: [], commands: [], notes: [note], conflicts: [] };
}

export function isRemoteEntry(entry: unknown, urlKeys: string[]): boolean {
  if (!isObject(entry)) return false;
  return urlKeys.some((key) => {
    const raw = entry[key];
    if (typeof raw !== "string") return false;
    try {
      return !LOOPBACK_HOSTS.has(new URL(raw).hostname);
    } catch {
      return false;
    }
  });
}
