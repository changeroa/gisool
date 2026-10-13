import { randomUUID } from "node:crypto";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { bearerOf, safeEqual } from "../api/security.js";
import { createMcpServer, type ToolDeps } from "./tools.js";

export const SESSION_IDLE_MS = 24 * 60 * 60 * 1000;

export type McpHttpDeps = ToolDeps & {
  token?: string;
  idleMs?: number;
  sweepMs?: number;
};

export type McpHttpHandle = { sessionCount(): number; sweep(now?: number): number; close(): Promise<void> };

type Session = { transport: StreamableHTTPServerTransport; server: McpServer; lastSeen: number };

function rpcError(res: Response, status: number, message: string): void {
  res.status(status).json({ jsonrpc: "2.0", error: { code: -32000, message }, id: null });
}

export function registerMcp(app: Express, deps: McpHttpDeps): McpHttpHandle {
  const sessions = new Map<string, Session>();
  const idleMs = deps.idleMs ?? SESSION_IDLE_MS;

  const auth = (req: Request, res: Response, next: NextFunction) => {
    if (deps.token && !safeEqual(bearerOf(req), deps.token)) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    next();
  };

  const existing = (req: Request): Session | undefined => {
    const id = req.header("mcp-session-id");
    const session = id ? sessions.get(id) : undefined;
    if (session) session.lastSeen = Date.now();
    return session;
  };

  const closeSession = async (id: string) => {
    const session = sessions.get(id);
    if (!session) return;
    sessions.delete(id);
    await session.transport.close().catch(() => undefined);
    await session.server.close().catch(() => undefined);
  };

  app.post("/mcp", auth, express.json({ limit: "4mb" }), async (req: Request, res: Response) => {
    const id = req.header("mcp-session-id");
    let session = existing(req);
    if (id && !session) return rpcError(res, 404, "Unknown or expired MCP session; reinitialize");
    if (!session) {
      if (!isInitializeRequest(req.body)) return rpcError(res, 400, "Missing mcp-session-id; send initialize first");
      const server = createMcpServer(deps);
      const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
        sessionIdGenerator: randomUUID,
        onsessioninitialized: (sid) => { sessions.set(sid, created); },
      });
      const created: Session = { server, transport, lastSeen: Date.now() };
      transport.onclose = () => {
        const sid = transport.sessionId;
        if (sid && sessions.get(sid) === created) sessions.delete(sid);
      };
      await server.connect(transport);
      session = created;
    }
    await session.transport.handleRequest(req, res, req.body);
  });

  const handleSessionRequest = async (req: Request, res: Response) => {
    const session = existing(req);
    if (!session) return rpcError(res, req.header("mcp-session-id") ? 404 : 400, "Unknown or missing mcp-session-id");
    await session.transport.handleRequest(req, res);
  };
  app.get("/mcp", auth, handleSessionRequest);
  app.delete("/mcp", auth, handleSessionRequest);

  const sweep = (now = Date.now()) => {
    const stale = [...sessions.entries()].filter(([, s]) => now - s.lastSeen > idleMs).map(([sid]) => sid);
    for (const sid of stale) void closeSession(sid);
    return stale.length;
  };
  const timer = setInterval(sweep, deps.sweepMs ?? 60 * 60 * 1000);
  timer.unref();

  return {
    sessionCount: () => sessions.size,
    sweep,
    async close() {
      clearInterval(timer);
      await Promise.all([...sessions.keys()].map(closeSession));
    },
  };
}
