import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import type { GisoolConfig } from "./types.js";

export const DEFAULT_PORT = 8799;

export const DEFAULT_ROOTS: readonly { id: string; path: string }[] = [
  { id: "agents", path: "~/.agents/skills" },
  { id: "claude", path: "~/.claude/skills" },
  { id: "codex", path: "~/.codex/skills" },
  { id: "gemini", path: "~/.gemini/skills" },
  { id: "omo", path: "~/.omo/agent/skills" },
  { id: "gajae", path: "~/.gjc/agent/skills" },
  { id: "openclaw", path: "~/.openclaw/skills" },
  { id: "gisul", path: "~/gisul/skills" },
];

const runtimeIds = ["claude-code", "codex", "gemini", "cursor", "omo", "gajae", "openclaw", "unknown"] as const;

const fileSchema = z.object({
  port: z.number().int().min(1).max(65535).optional(),
  captureLevel: z.enum(["metadata", "redacted", "full"]).optional(),
  retentionDays: z.number().int().positive().nullable().optional(),
  roots: z.array(z.object({ id: z.string().min(1), path: z.string().min(1) })).optional(),
  runtimes: z.partialRecord(z.enum(runtimeIds), z.object({ enabled: z.boolean() })).optional(),
});

export function resolveHome(env: NodeJS.ProcessEnv): string {
  return env.HOME && env.HOME.length > 0 ? env.HOME : homedir();
}

export function resolveGisoolHome(env: NodeJS.ProcessEnv): string {
  return env.GISOOL_HOME && env.GISOOL_HOME.length > 0 ? env.GISOOL_HOME : join(resolveHome(env), ".gisool");
}

export function expandHome(path: string, home: string): string {
  if (path === "~") return home;
  if (path.startsWith("~/")) return join(home, path.slice(2));
  return isAbsolute(path) ? path : join(home, path);
}

export function defaultConfigFile(): { port: number; captureLevel: "full"; retentionDays: null; roots: { id: string; path: string }[]; runtimes: Record<string, never> } {
  return { port: DEFAULT_PORT, captureLevel: "full", retentionDays: null, roots: DEFAULT_ROOTS.map((r) => ({ ...r })), runtimes: {} };
}

export function ensureGisoolHome(env: NodeJS.ProcessEnv): string {
  const dir = resolveGisoolHome(env);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  return dir;
}

/** Returns the daemon bearer token, creating a 32-byte hex token (mode 0600) on first use. */
export function ensureToken(gisoolHome: string): string {
  const path = join(gisoolHome, "token");
  if (existsSync(path)) {
    const token = readFileSync(path, "utf8").trim();
    if (/^[0-9a-f]{64}$/.test(token)) return token;
  }
  const token = randomBytes(32).toString("hex");
  writeFileSync(path, token + "\n", { mode: 0o600 });
  chmodSync(path, 0o600);
  return token;
}

/** Loads (and on first run creates) GISOOL_HOME, config.json and the token. No work happens at import time. */
export function loadConfig(env: NodeJS.ProcessEnv): GisoolConfig {
  const home = resolveHome(env);
  const gisoolHome = ensureGisoolHome(env);
  const configPath = join(gisoolHome, "config.json");
  if (!existsSync(configPath)) {
    writeFileSync(configPath, JSON.stringify(defaultConfigFile(), null, 2) + "\n", { mode: 0o600 });
  }
  const parsed = fileSchema.parse(JSON.parse(readFileSync(configPath, "utf8")));
  ensureToken(gisoolHome);
  const defaults = defaultConfigFile();
  return {
    port: parsed.port ?? defaults.port,
    captureLevel: parsed.captureLevel ?? defaults.captureLevel,
    retentionDays: parsed.retentionDays ?? null,
    roots: (parsed.roots ?? defaults.roots).map((r) => ({ id: r.id, path: expandHome(r.path, home) })),
    runtimes: parsed.runtimes ?? {},
  };
}
