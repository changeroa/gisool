import { z } from "zod";

export const PROTOCOL_VERSION = "2026-07-28";
export const VERSION_KEY = "io.modelcontextprotocol/protocolVersion";
export const CLIENT_INFO_KEY = "io.modelcontextprotocol/clientInfo";
export const CLIENT_CAPABILITIES_KEY = "io.modelcontextprotocol/clientCapabilities";
export const TRACE_KEY = "app.gisool/traceId";
export const CACHE = { ttlMs: 60_000, cacheScope: "private" } as const;

export class RpcError extends Error {
  constructor(readonly code: number, message: string, readonly data?: unknown) {
    super(message);
  }
}

export const idSchema = z.union([z.string(), z.number().int()]);
export const responseSchema = z.union([
  z.object({ jsonrpc: z.literal("2.0"), id: idSchema, result: z.object({ resultType: z.literal("complete") }).passthrough() }).strict(),
  z.object({ jsonrpc: z.literal("2.0"), id: idSchema.optional(), error: z.object({ code: z.number().int(), message: z.string(), data: z.unknown().optional() }) }).strict(),
]);
export function messageId(value: unknown): string | number | undefined {
  if (typeof value !== "object" || value === null || !("id" in value)) return undefined;
  const id = idSchema.safeParse(value.id);
  return id.success ? id.data : undefined;
}
export const messageSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: idSchema.optional(),
  method: z.string(),
  params: z.unknown().optional(),
}).strict();
export type Message = z.infer<typeof messageSchema>;
const object = z.record(z.string(), z.unknown());
const metaKey = /^(?:[A-Za-z](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*\/)?(?:[A-Za-z0-9](?:[A-Za-z0-9_.-]*[A-Za-z0-9])?)?$/;
export const metaSchema = z.object({
  [VERSION_KEY]: z.string(),
  [CLIENT_CAPABILITIES_KEY]: z.object({
    elicitation: z.object({ form: object.optional(), url: object.optional() }).passthrough().optional(),
    sampling: z.object({ tools: object.optional(), context: object.optional() }).passthrough().optional(),
    roots: object.optional(),
    extensions: z.record(z.string().regex(metaKey).refine((s) => s.includes("/")), object).optional(),
  }).passthrough(),
  [CLIENT_INFO_KEY]: z.object({ name: z.string(), version: z.string() }).passthrough().optional(),
  [TRACE_KEY]: z.string().max(128).optional(),
  "io.modelcontextprotocol/logLevel": z.enum(["debug", "info", "notice", "warning", "error", "critical", "alert", "emergency"]).optional(),
  progressToken: idSchema.optional(),
}).catchall(z.unknown()).refine((meta) => Object.keys(meta).every((key) => metaKey.test(key)), "Invalid _meta key");
export type RequestMeta = z.infer<typeof metaSchema>;
export const paramsSchema = z.object({ _meta: metaSchema }).passthrough();
export type RequestParams = z.infer<typeof paramsSchema>;

export function parseParams(message: Message): RequestParams {
  const parsed = paramsSchema.safeParse(message.params);
  if (!parsed.success) throw new RpcError(-32602, `Invalid params: required request _meta must describe MCP ${PROTOCOL_VERSION}`, parsed.error.issues);
  return parsed.data;
}

export function checkVersion(meta: RequestMeta): void {
  const requested = meta[VERSION_KEY];
  if (requested !== PROTOCOL_VERSION) {
    throw new RpcError(-32022, `Unsupported protocol version; gisool supports only ${PROTOCOL_VERSION}`, { supported: [PROTOCOL_VERSION], requested });
  }
}

export function errorResponse(id: string | number | undefined, error: RpcError) {
  return { jsonrpc: "2.0", ...(id === undefined ? {} : { id }), error: { code: error.code, message: error.message, ...(error.data === undefined ? {} : { data: error.data }) } };
}

export function rpcFailure(error: unknown): RpcError {
  if (error instanceof RpcError) return error;
  if (error instanceof z.ZodError) return new RpcError(-32602, "Invalid request parameters", error.issues);
  return new RpcError(-32603, "Internal error");
}

/** HTTP field values use the spec's sentinel encoding, not URL encoding. */
export function encodeHeader(value: string): string {
  return /^[\x20-\x7e\t]*$/.test(value) && value.trim() === value && !(value.startsWith("=?base64?") && value.endsWith("?="))
    ? value : `=?base64?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

function decodeHeader(value: string): string {
  if (!/^[\x20-\x7e\t]*$/.test(value) || value.trim() !== value) throw new RpcError(-32020, "Malformed MCP header");
  if (!value.startsWith("=?base64?") || !value.endsWith("?=")) return value;
  const encoded = value.slice(9, -2);
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.toString("base64") !== encoded) throw new RpcError(-32020, "Malformed Base64 MCP header");
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new RpcError(-32020, "MCP header is not UTF-8");
  }
}

export function checkHeaders(message: Message, header: (name: string) => string | undefined): void {
  const raw = object.safeParse(message.params);
  const meta = object.safeParse(raw.success ? raw.data._meta : undefined);
  const version = header("MCP-Protocol-Version");
  const method = header("Mcp-Method");
  const hint = message.method === "initialize" ? `; gisool supports only MCP ${PROTOCOL_VERSION}, without initialize` : "";
  if (!version || !method) throw new RpcError(-32020, `Missing required MCP headers${hint}`);
  if (method !== message.method || (meta.success && typeof meta.data[VERSION_KEY] === "string" && version !== meta.data[VERSION_KEY])) {
    throw new RpcError(-32020, `MCP header does not match request body${hint}`);
  }
  const name = header("Mcp-Name");
  const nameRequired = ["tools/call", "resources/read", "prompts/get"].includes(message.method);
  if (nameRequired || name !== undefined) {
    const expected = raw.success ? (message.method === "resources/read" ? raw.data.uri : raw.data.name) : undefined;
    if (name === undefined || decodeHeader(name) !== expected) throw new RpcError(-32020, "Mcp-Name does not match request body");
  }
}

export function requestHeaders(message: Message, params: RequestParams): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json", Accept: "application/json, text/event-stream",
    "MCP-Protocol-Version": params._meta[VERSION_KEY], "Mcp-Method": message.method,
  };
  const name = message.method === "resources/read" ? params.uri : params.name;
  if (["tools/call", "resources/read", "prompts/get"].includes(message.method) && typeof name === "string") headers["Mcp-Name"] = encodeHeader(name);
  return headers;
}
