import { existsSync } from "node:fs";
import { join } from "node:path";
import type { PackCtx, PackPlan, RuntimePack } from "../types.js";
import { type JsonObject, isObject, isRemoteEntry, noop, planJsonFile, readJsonConfig, refuse } from "./json-config.js";

// Hook shape confirmed against https://cursor.com/docs/agent/hooks : hooks.json is { "version": 1, "hooks": { <event>: [{ "command": ... }] } }
// and Cursor reloads hooks config files automatically. MCP servers live in ~/.cursor/mcp.json under mcpServers.
const HOOK_EVENTS = ["beforeSubmitPrompt", "sessionStart", "sessionEnd"];
const URL_KEYS = ["url"];

function localMcpUrl(port: number): string {
  return `http://127.0.0.1:${port}/mcp`;
}

function hookCommand(ctx: PackCtx): string {
  return `"${ctx.nodePath}" "${join(ctx.packageRoot, "packs", "hook-post.mjs")}" cursor`;
}

function isOurHook(entry: unknown): boolean {
  return isObject(entry) && typeof entry.command === "string" && entry.command.endsWith('hook-post.mjs" cursor');
}

export const cursorPack: RuntimePack = {
  id: "cursor",

  async detect({ home }) {
    const dir = join(home, ".cursor");
    const installed = existsSync(dir);
    const servers = readJsonConfig(join(dir, "mcp.json")).obj.mcpServers;
    return {
      installed,
      evidence: installed ? [dir] : [],
      remoteGisulRegistered: isObject(servers) && isRemoteEntry(servers.gisul, URL_KEYS),
    };
  },

  async plan(ctx): Promise<PackPlan> {
    const dir = join(ctx.home, ".cursor");
    if (!existsSync(dir)) return noop("~/.cursor not found; Cursor does not appear to be installed, nothing planned.");
    const mcpPath = join(dir, "mcp.json");
    const hooksPath = join(dir, "hooks.json");
    const mcp = readJsonConfig(mcpPath);
    const hooksFile = readJsonConfig(hooksPath);
    for (const [path, cfg] of [
      [mcpPath, mcp],
      [hooksPath, hooksFile],
    ] as const) {
      if (cfg.error) return refuse(path, "unparseable_config", cfg.error);
    }

    const nextMcp: JsonObject = structuredClone(mcp.obj);
    const servers = nextMcp.mcpServers ?? {};
    if (!isObject(servers)) return refuse(mcpPath, "invalid_shape", "mcpServers must be a JSON object");
    const notes: string[] = [];
    if (ctx.disableRemote && isRemoteEntry(servers.gisul, URL_KEYS)) {
      notes.push("Remote gisul MCP entry left enabled: Cursor's disable key is unverified, so disable it manually.");
    }
    servers.gisool = { url: localMcpUrl(ctx.port), headers: { Authorization: `Bearer ${ctx.token}` } };
    nextMcp.mcpServers = servers;

    if (hooksFile.obj.version !== undefined && hooksFile.obj.version !== 1) {
      return refuse(hooksPath, "invalid_shape", "hooks.json version must be 1");
    }
    const nextHooks: JsonObject = { ...structuredClone(hooksFile.obj), version: 1 };
    const hooks = nextHooks.hooks ?? {};
    if (!isObject(hooks)) return refuse(hooksPath, "invalid_shape", "hooks must be a JSON object");
    for (const event of HOOK_EVENTS) {
      const entries = hooks[event] ?? [];
      if (!Array.isArray(entries)) return refuse(hooksPath, "invalid_shape", `hooks.${event} must be an array`);
      hooks[event] = [...entries.filter((entry) => !isOurHook(entry)), { command: hookCommand(ctx) }];
    }
    nextHooks.hooks = hooks;

    const files = [planJsonFile(mcpPath, mcp, nextMcp), planJsonFile(hooksPath, hooksFile, nextHooks)].filter(
      (f) => f !== null,
    );
    notes.push("Restart Cursor or reload MCP servers to load the gisool MCP entry; Cursor reloads hooks.json on change.");
    return { files, commands: [], notes, conflicts: [] };
  },

  async doctorChecks({ home, port }) {
    const mcp = readJsonConfig(join(home, ".cursor", "mcp.json"));
    if (mcp.error) return [{ name: "cursor mcp.json", ok: false, detail: mcp.error }];
    const hooksFile = readJsonConfig(join(home, ".cursor", "hooks.json"));
    if (hooksFile.error) return [{ name: "cursor hooks.json", ok: false, detail: hooksFile.error }];
    const servers: JsonObject = isObject(mcp.obj.mcpServers) ? mcp.obj.mcpServers : {};
    const entry: JsonObject = isObject(servers.gisool) ? servers.gisool : {};
    const hooks: JsonObject = isObject(hooksFile.obj.hooks) ? hooksFile.obj.hooks : {};
    const hooksPresent = HOOK_EVENTS.every((event) => {
      const entries = hooks[event];
      return Array.isArray(entries) && entries.some(isOurHook);
    });
    return [
      { name: "cursor MCP gisool", ok: entry.url === localMcpUrl(port), detail: `url ${String(entry.url ?? "missing")}` },
      {
        name: "cursor capture hooks",
        ok: hooksPresent,
        detail: hooksPresent ? "beforeSubmitPrompt, sessionStart, sessionEnd present" : "capture hooks missing; rerun gisool init",
      },
    ];
  },
};
