import { z } from "zod";
import { CLIENT_CAPABILITIES_KEY, CLIENT_INFO_KEY, PROTOCOL_VERSION, VERSION_KEY, type Message } from "./protocol.js";

/**
 * Dual-era support: initialization-based revisions are served by translating each request into a
 * modern request with synthesized `_meta`, then stripping modern-only result fields.
 */
export const LEGACY_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"] as const;

export type ClientInfo = { name: string; version: string };

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

export const initializeSchema = z.object({
  protocolVersion: z.string(),
  capabilities: z.record(z.string(), z.unknown()),
  clientInfo: z.object({ name: z.string(), version: z.string() }).passthrough(),
}).passthrough();

/**
 * A request without modern `_meta` and without a modern HTTP version header opens or continues the legacy era.
 * Clients before 2025-06-18 send no MCP-Protocol-Version header at all.
 */
export function isLegacyRequest(message: Message, versionHeader?: string): boolean {
  const meta = isObject(message.params) && isObject(message.params._meta) ? message.params._meta : {};
  if (VERSION_KEY in meta || CLIENT_CAPABILITIES_KEY in meta) return false;
  return versionHeader === undefined || (LEGACY_VERSIONS as readonly string[]).includes(versionHeader);
}

export function negotiateVersion(requested: string): string {
  return (LEGACY_VERSIONS as readonly string[]).includes(requested) ? requested : LEGACY_VERSIONS[0];
}

/** Legacy requests carry identity only on initialize; the session supplies it afterwards. */
export function toModernMessage(message: Message, clientInfo?: ClientInfo): Message {
  const params = isObject(message.params) ? message.params : {};
  const meta = isObject(params._meta) ? params._meta : {};
  return {
    ...message,
    params: {
      ...params,
      _meta: { ...meta, [VERSION_KEY]: PROTOCOL_VERSION, [CLIENT_CAPABILITIES_KEY]: {}, ...(clientInfo ? { [CLIENT_INFO_KEY]: { name: clientInfo.name, version: clientInfo.version } } : {}) },
    },
  };
}

export function legacyLocalResult(method: string): Record<string, unknown> | undefined {
  if (method === "ping") return {};
  if (method === "resources/templates/list") return { resourceTemplates: [] };
  return undefined;
}

export function toLegacyResult(result: Record<string, unknown>): Record<string, unknown> {
  const { resultType: _type, ttlMs: _ttl, cacheScope: _scope, _meta, ...rest } = result;
  if (!isObject(_meta)) return rest;
  const { "io.modelcontextprotocol/serverInfo": _server, ...meta } = _meta;
  return Object.keys(meta).length ? { ...rest, _meta: meta } : rest;
}

export function initializeResult(version: string, discover: Record<string, unknown>): Record<string, unknown> {
  const meta = isObject(discover._meta) ? discover._meta : {};
  return {
    protocolVersion: version,
    capabilities: discover.capabilities,
    serverInfo: meta["io.modelcontextprotocol/serverInfo"],
    ...(typeof discover.instructions === "string" ? { instructions: discover.instructions } : {}),
  };
}
