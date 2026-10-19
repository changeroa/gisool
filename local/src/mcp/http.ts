import { randomUUID } from "node:crypto";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { bearerOf, safeEqual } from "../api/security.js";
import { createDispatcher } from "./dispatch.js";
import { initializeResult, initializeSchema, isLegacyRequest, legacyLocalResult, negotiateVersion, toLegacyResult, toModernMessage, type ClientInfo } from "./legacy.js";
import { checkHeaders, checkVersion, errorResponse, messageId, messageSchema, parseParams, RpcError, rpcFailure, type Message } from "./protocol.js";
import type { ToolDeps } from "./tools.js";

export type McpHttpDeps = ToolDeps & { token: string };

const MAX_LEGACY_SESSIONS = 1024;

/**
 * Dual-era MCP. Modern POSTs are self-contained. An `initialize` opens a legacy session whose only state is
 * the client identity used for attribution; unknown session IDs are served anonymously rather than rejected,
 * so a daemon restart never strands a legacy client. No GET stream or DELETE in either era.
 */
export function registerMcp(app: Express, deps: McpHttpDeps): void {
  const dispatch = createDispatcher(deps);
  const sessions = new Map<string, ClientInfo>();
  const legacy = async (message: Message & { id: string | number }, req: Request, res: Response) => {
    try {
      let result: Record<string, unknown>;
      if (message.method === "initialize") {
        const init = initializeSchema.safeParse(message.params);
        if (!init.success) throw new RpcError(-32602, "Invalid initialize params", init.error.issues);
        const clientInfo = { name: init.data.clientInfo.name, version: init.data.clientInfo.version };
        const discover = toModernMessage({ jsonrpc: "2.0", id: message.id, method: "server/discover" }, clientInfo);
        result = initializeResult(negotiateVersion(init.data.protocolVersion), await dispatch(discover, parseParams(discover)));
        const sessionId = randomUUID();
        if (sessions.size >= MAX_LEGACY_SESSIONS) sessions.delete(sessions.keys().next().value!);
        sessions.set(sessionId, clientInfo);
        res.set("Mcp-Session-Id", sessionId);
      } else {
        const local = legacyLocalResult(message.method);
        const sessionId = req.header("Mcp-Session-Id");
        const modern = toModernMessage(message, sessionId ? sessions.get(sessionId) : undefined);
        result = local ?? toLegacyResult(await dispatch(modern, parseParams(modern)));
      }
      if (!res.destroyed) res.json({ jsonrpc: "2.0", id: message.id, result });
    } catch (error) {
      // Legacy clients surface JSON-RPC errors only from 200 responses.
      if (!res.destroyed) res.json(errorResponse(message.id, rpcFailure(error)));
    }
  };
  const auth = (req: Request, res: Response, next: NextFunction) => {
    if (!safeEqual(bearerOf(req), deps.token)) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    next();
  };
  app.post("/mcp", auth, express.json({ limit: "1mb", strict: false }), async (req: Request, res: Response) => {
    const parsed = messageSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(errorResponse(messageId(req.body), new RpcError(-32600, "Expected one JSON-RPC request or notification")));
      return;
    }
    const message = parsed.data;
    if (message.id === undefined) {
      // No client notification is acted upon over HTTP in this revision.
      res.status(202).end();
      return;
    }
    const version = req.header("MCP-Protocol-Version");
    if (isLegacyRequest(message, version)) {
      if (req.header("accept") && !req.accepts("application/json")) {
        res.status(406).json(errorResponse(message.id, new RpcError(-32600, "Accept must include application/json")));
        return;
      }
      await legacy({ ...message, id: message.id }, req, res);
      return;
    }
    try {
      checkHeaders(message, (name) => req.header(name));
      const params = parseParams(message);
      checkVersion(params._meta);
      if (!req.header("accept") || !req.accepts("application/json") || !req.accepts("text/event-stream")) {
        res.status(406).json(errorResponse(message.id, new RpcError(-32600, "Accept must include application/json and text/event-stream")));
        return;
      }
      const result = await dispatch(message, params);
      if (!res.destroyed) res.json({ jsonrpc: "2.0", id: message.id, result });
    } catch (error) {
      const failure = rpcFailure(error);
      const status = failure.code === -32601 ? 404 : failure.code === -32603 ? 500 : 400;
      if (!res.destroyed) res.status(status).json(errorResponse(message.id, failure));
    }
  });
  app.all("/mcp", auth, (_req: Request, res: Response) => { res.set("Allow", "POST").status(405).end(); });
  app.use("/mcp", (error: unknown, _req: Request, res: Response, next: NextFunction) => {
    const parsed = bodyErrorStatus(error);
    if (parsed === undefined) { next(error); return; }
    res.status(parsed).json(errorResponse(undefined, new RpcError(parsed === 413 ? -32600 : -32700, parsed === 413 ? "Request body exceeds 1 MiB" : "Invalid JSON")));
  });
}

function bodyErrorStatus(error: unknown): number | undefined {
  if (error instanceof Error && "type" in error) {
    if (error.type === "entity.too.large") return 413;
    if (error.type === "entity.parse.failed") return 400;
  }
  return undefined;
}
