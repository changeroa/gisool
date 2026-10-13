import { existsSync, lstatSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type { PackCtx, PackPlan, PackPlanFile, RuntimeId, RuntimePack } from "../types.js";

export type PiPackSpec = {
  id: "omo" | "gajae";
  /** Agent directory (same resolution as clients/runtime-install.mjs resolveAgentDir). */
  agentDir(home: string, env: NodeJS.ProcessEnv): string;
  /** Directory name under <agentDir>/extensions. */
  extensionName: string;
  /** Marker path (relative to home) whose presence signals an install. */
  installMarker: string;
};

const EXT_FILES = ["index.js", "discovery.md"] as const;
const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

function readOrNull(path: string): string | null {
  try {
    if (!lstatSync(path).isFile()) return null;
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

export function resolveOmoAgentDir(home: string, env: NodeJS.ProcessEnv): string {
  for (const name of ["OMO_CODING_AGENT_DIR", "SENPI_CODING_AGENT_DIR", "PI_CODING_AGENT_DIR"]) {
    const v = env[name]?.trim();
    if (v) return resolve(v);
  }
  return join(home, ".omo", "agent");
}

export function resolveGajaeAgentDir(home: string, env: NodeJS.ProcessEnv): string {
  for (const name of ["GJC_CODING_AGENT_DIR", "PI_CODING_AGENT_DIR"]) {
    const v = env[name]?.trim();
    if (v) return resolve(v);
  }
  const configDir = env.GJC_CONFIG_DIR?.trim() || env.PI_CONFIG_DIR?.trim() || ".gjc";
  if (isAbsolute(configDir) || configDir.split(/[\\/]/).some(part => ["", ".", ".."].includes(part))) {
    throw new Error("Use GJC_CODING_AGENT_DIR for an explicit Gajae profile path");
  }
  return join(home, configDir, "agent");
}

function isLoopbackUrl(raw: string): boolean {
  try {
    const host = new URL(raw).hostname.replace(/^\[|\]$/g, "");
    return host === "localhost" || host === "::1" || host.startsWith("127.");
  } catch {
    return false;
  }
}

function isRemoteGisul(server: unknown): boolean {
  if (!isObject(server)) return false;
  if (typeof server.url === "string") return !isLoopbackUrl(server.url);
  const argv = [server.command, ...(Array.isArray(server.args) ? server.args : [])];
  return argv.some(a => typeof a === "string" && a.includes("mcp-remote"));
}

function parseConfig(text: string | null): Record<string, unknown> | undefined {
  if (text === null) return {};
  try {
    const v = JSON.parse(text);
    return isObject(v) && (v.mcpServers === undefined || isObject(v.mcpServers)) ? v : undefined;
  } catch {
    return undefined;
  }
}

export function createPiPack(spec: PiPackSpec): RuntimePack {
  const extDir = (agentDir: string) => join(agentDir, "extensions", spec.extensionName);
  return {
    id: spec.id as RuntimeId,
    async detect({ home, env }) {
      let agentDir: string;
      try { agentDir = spec.agentDir(home, env); } catch { return { installed: false, evidence: [], remoteGisulRegistered: false }; }
      const evidence = [agentDir, join(home, spec.installMarker)].filter(p => existsSync(p));
      const cfg = parseConfig(readOrNull(join(agentDir, "mcp.json")));
      const servers = isObject(cfg?.mcpServers) ? cfg.mcpServers : {};
      return { installed: evidence.length > 0, evidence, remoteGisulRegistered: isRemoteGisul(servers.gisul) };
    },
    async plan(ctx: PackCtx): Promise<PackPlan> {
      const plan: PackPlan = { files: [], commands: [], notes: [], conflicts: [] };
      let agentDir: string;
      try { agentDir = spec.agentDir(ctx.home, ctx.env); } catch (e) {
        plan.conflicts.push({ path: ctx.home, code: "agent_dir_unresolved", detail: (e as Error).message });
        return plan;
      }
      const mcpPath = join(agentDir, "mcp.json");
      const before = readOrNull(mcpPath);
      const cfg = parseConfig(before);
      if (!cfg) {
        plan.conflicts.push({ path: mcpPath, code: "invalid_mcp_config", detail: "mcp.json is not a JSON object with an mcpServers map; left untouched" });
        return plan;
      }
      const servers: Record<string, unknown> = { ...(isObject(cfg.mcpServers) ? cfg.mcpServers : {}) };
      servers.gisool = { type: "http", url: `http://127.0.0.1:${ctx.port}/mcp`, headers: { Authorization: `Bearer ${ctx.token}` } };
      if (ctx.disableRemote && isRemoteGisul(servers.gisul)) {
        servers.gisul = { ...(servers.gisul as Record<string, unknown>), enabled: false };
        plan.notes.push("remote gisul entry set to enabled:false (original definition kept)");
      }
      const mcpAfter = JSON.stringify({ ...cfg, mcpServers: servers }, null, 2) + "\n";
      plan.files.push({ path: mcpPath, before, after: mcpAfter, mode: 0o600 });

      const dir = extDir(agentDir);
      const source = join(ctx.packageRoot, "packs", spec.id, "extension");
      const add = (path: string, after: string): void => {
        const f: PackPlanFile = { path, before: readOrNull(path), after, mode: 0o644 };
        plan.files.push(f);
      };
      for (const name of EXT_FILES) add(join(dir, name), readFileSync(join(source, name), "utf8"));
      add(join(dir, "config.json"), JSON.stringify({ port: ctx.port }, null, 2) + "\n");
      plan.notes.push(`extension forwarder installed at ${dir}; it reads the token from $GISOOL_HOME/token at load`);
      return plan;
    },
    async doctorChecks({ home, env, port }) {
      const checks: { name: string; ok: boolean; detail: string }[] = [];
      let agentDir: string;
      try { agentDir = spec.agentDir(home, env); } catch (e) {
        return [{ name: `${spec.id} agent dir`, ok: false, detail: (e as Error).message }];
      }
      const cfg = parseConfig(readOrNull(join(agentDir, "mcp.json")));
      const entry = isObject(cfg?.mcpServers) ? cfg.mcpServers.gisool : undefined;
      const want = `http://127.0.0.1:${port}/mcp`;
      const url = isObject(entry) ? entry.url : undefined;
      checks.push({ name: `${spec.id} mcp.json gisool`, ok: url === want, detail: url === want ? want : `expected ${want}, found ${String(url)}` });
      const idx = join(extDir(agentDir), "index.js");
      checks.push({ name: `${spec.id} extension forwarder`, ok: existsSync(idx), detail: idx });
      const cfgPath = join(extDir(agentDir), "config.json");
      let cfgPort: unknown;
      try { cfgPort = JSON.parse(readOrNull(cfgPath) ?? "{}").port; } catch { /* reported below */ }
      checks.push({ name: `${spec.id} extension port`, ok: cfgPort === port, detail: cfgPort === port ? String(port) : `expected ${port}, found ${String(cfgPort)}` });
      return checks;
    },
  };
}

export const omoPack: RuntimePack = createPiPack({
  id: "omo",
  agentDir: resolveOmoAgentDir,
  extensionName: "gisool",
  installMarker: ".omo",
});
