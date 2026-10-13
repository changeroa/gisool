import { existsSync } from "node:fs";
import { join } from "node:path";
import type { PackCtx, PackPlan, RuntimePack } from "../types.js";
import { type JsonObject, isObject, isRemoteEntry, noop, planJsonFile, readJsonConfig, refuse } from "./json-config.js";

// Hook shape confirmed against https://geminicli.com/docs/hooks/ : settings.json "hooks" maps an event name to groups
// of { matcher?, hooks: [{ type: "command", name, command, timeout }] }; timeout is in milliseconds. BeforeAgent is a
// lifecycle event (exact-string matcher, so none is written); AfterTool matchers are regular expressions over tool names.
const HOOK_NAME = "gisool-capture";
const HOOK_TIMEOUT_MS = 5000;
const HOOK_EVENTS: { event: string; matcher?: string }[] = [{ event: "BeforeAgent" }, { event: "AfterTool", matcher: "activate_skill" }];
const URL_KEYS = ["httpUrl", "url"];

function localMcpUrl(port: number): string {
  return `http://127.0.0.1:${port}/mcp`;
}

function hookCommand(ctx: PackCtx): string {
  return `"${ctx.nodePath}" "${join(ctx.packageRoot, "packs", "hook-post.mjs")}" gemini`;
}

function isOurHookGroup(group: unknown): boolean {
  return (
    isObject(group) &&
    Array.isArray(group.hooks) &&
    group.hooks.some((h: unknown) => isObject(h) && typeof h.command === "string" && h.command.endsWith('hook-post.mjs" gemini'))
  );
}

export const geminiPack: RuntimePack = {
  id: "gemini",

  async detect({ home }) {
    const dir = join(home, ".gemini");
    const installed = existsSync(dir);
    const servers = readJsonConfig(join(dir, "settings.json")).obj.mcpServers;
    return {
      installed,
      evidence: installed ? [dir] : [],
      remoteGisulRegistered: isObject(servers) && isRemoteEntry(servers.gisul, URL_KEYS),
    };
  },

  async plan(ctx): Promise<PackPlan> {
    const dir = join(ctx.home, ".gemini");
    if (!existsSync(dir)) return noop("~/.gemini not found; Gemini CLI does not appear to be installed, nothing planned.");
    const path = join(dir, "settings.json");
    const current = readJsonConfig(path);
    if (current.error) return refuse(path, "unparseable_config", current.error);

    const next: JsonObject = structuredClone(current.obj);
    const servers = next.mcpServers ?? {};
    const hooks = next.hooks ?? {};
    if (!isObject(servers) || !isObject(hooks)) return refuse(path, "invalid_shape", "mcpServers and hooks must be JSON objects");

    const notes: string[] = [];
    if (ctx.disableRemote && isRemoteEntry(servers.gisul, URL_KEYS)) {
      notes.push("Remote gisul MCP entry left enabled: Gemini's disable key is unverified, so disable it manually.");
    }
    servers.gisool = { httpUrl: localMcpUrl(ctx.port), headers: { Authorization: `Bearer ${ctx.token}` } };
    next.mcpServers = servers;

    for (const { event, matcher } of HOOK_EVENTS) {
      const groups = hooks[event] ?? [];
      if (!Array.isArray(groups)) return refuse(path, "invalid_shape", `hooks.${event} must be an array`);
      const ours = {
        ...(matcher ? { matcher } : {}),
        hooks: [{ type: "command", name: HOOK_NAME, command: hookCommand(ctx), timeout: HOOK_TIMEOUT_MS }],
      };
      hooks[event] = [...groups.filter((group) => !isOurHookGroup(group)), ours];
    }
    next.hooks = hooks;

    const file = planJsonFile(path, current, next);
    notes.push("Restart Gemini CLI to load the gisool MCP server and capture hooks.");
    return { files: file ? [file] : [], commands: [], notes, conflicts: [] };
  },

  async doctorChecks({ home, port }) {
    const current = readJsonConfig(join(home, ".gemini", "settings.json"));
    if (current.error) return [{ name: "gemini settings.json", ok: false, detail: current.error }];
    const servers: JsonObject = isObject(current.obj.mcpServers) ? current.obj.mcpServers : {};
    const entry: JsonObject = isObject(servers.gisool) ? servers.gisool : {};
    const hooks: JsonObject = isObject(current.obj.hooks) ? current.obj.hooks : {};
    const hooksPresent = HOOK_EVENTS.every(({ event }) => {
      const groups = hooks[event];
      return Array.isArray(groups) && groups.some(isOurHookGroup);
    });
    return [
      { name: "gemini MCP gisool", ok: entry.httpUrl === localMcpUrl(port), detail: `httpUrl ${String(entry.httpUrl ?? "missing")}` },
      {
        name: "gemini capture hooks",
        ok: hooksPresent,
        detail: hooksPresent ? "BeforeAgent and AfterTool present" : "capture hooks missing; rerun gisool init",
      },
    ];
  },
};
