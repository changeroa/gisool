import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { bearerOf, safeEqual } from "../api/security.js";
import { createDispatcher } from "./dispatch.js";
import { checkHeaders, checkVersion, errorResponse, messageId, messageSchema, parseParams, RpcError, rpcFailure } from "./protocol.js";
import type { ToolDeps } from "./tools.js";

export type McpHttpDeps = ToolDeps & { token: string };

/** Modern MCP: every POST is self-contained; no initialize, sessions, GET stream or DELETE. */
export function registerMcp(app: Express, deps: McpHttpDeps): void {
  const dispatch = createDispatcher(deps);
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
