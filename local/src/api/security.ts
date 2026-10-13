import { createHmac, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, RequestHandler, Response } from "express";

export const DASH_COOKIE = "gisool_dash";

export function deny(res: Response, status: number, error: string, extra: Record<string, unknown> = {}): void {
  res.status(status).json({ error, ...extra });
}

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function dashCookieValue(token: string): string {
  return createHmac("sha256", token).update("dash").digest("hex");
}

export function bearerOf(req: Request): string {
  const header = req.header("authorization") ?? "";
  return header.startsWith("Bearer ") ? header.slice(7).trim() : "";
}

export function cookieOf(req: Request, name: string): string | undefined {
  for (const part of (req.header("cookie") ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

/**
 * DNS-rebinding and cross-site guard. `port()` is read per request so a server bound to port 0 checks its real port.
 * Host must be 127.0.0.1:<port> or localhost:<port>; a present Origin must be the matching http origin;
 * `Sec-Fetch-Site: cross-site` is always refused.
 */
export function localOnly(port: () => number): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const p = port();
    const hosts = [`127.0.0.1:${p}`, `localhost:${p}`];
    if (!hosts.includes(req.header("host") ?? "")) return deny(res, 403, "host_not_allowed");
    const origin = req.header("origin");
    if (origin !== undefined && !hosts.some((h) => origin === `http://${h}`)) return deny(res, 403, "origin_not_allowed");
    if ((req.header("sec-fetch-site") ?? "").toLowerCase() === "cross-site") return deny(res, 403, "cross_site_not_allowed");
    next();
  };
}

/**
 * `/mcp` and `/ingest/*` take only the bearer token; `/api/*` also accepts the dashboard cookie; everything else is public.
 * The path is classified lowercased and percent-decoded so case or encoding variants (`/API/`, `/%61pi/`) cannot
 * skip the gate even if a router ever matches them; a path that does not decode is refused.
 */
export function authGate(token: string): RequestHandler {
  const cookie = dashCookieValue(token);
  return (req: Request, res: Response, next: NextFunction) => {
    let path: string;
    try {
      path = decodeURIComponent(req.path).toLowerCase();
    } catch {
      return deny(res, 400, "bad_path");
    }
    const bearerOnly = path === "/mcp" || path.startsWith("/mcp/") || path.startsWith("/ingest/");
    const api = path === "/api" || path.startsWith("/api/");
    if (!bearerOnly && !api) return next();
    if (safeEqual(bearerOf(req), token)) return next();
    if (api) {
      const presented = cookieOf(req, DASH_COOKIE);
      if (presented !== undefined && safeEqual(presented, cookie)) return next();
    }
    deny(res, 401, "unauthorized");
  };
}

const MUTATIONS = new Set(["POST", "PUT", "PATCH"]);

/** Mutations must declare a JSON body; OTLP protobuf gets a hint to switch the exporter to http/json. */
export function requireJson(onReject?: (req: Request) => void): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!MUTATIONS.has(req.method) || req.is("application/json")) return next();
    onReject?.(req);
    const protobuf = req.path.startsWith("/ingest/otlp/") && /protobuf/i.test(req.header("content-type") ?? "");
    deny(res, 415, "unsupported_media_type", protobuf
      ? { hint: "gisool accepts OTLP/HTTP JSON only; set OTEL_EXPORTER_OTLP_PROTOCOL=http/json (or OTEL_EXPORTER_OTLP_LOGS_PROTOCOL=http/json)" }
      : { hint: "send Content-Type: application/json" });
  };
}
