import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";
import { registerRoutes } from "./api/routes.js";
import { authGate, deny, localOnly, requireJson } from "./api/security.js";
import { createSseHub } from "./api/sse.js";
import { registerStatic } from "./api/static.js";
import { createCatalog } from "./catalog/index.js";
import { ensureGisoolHome, ensureToken, resolveGisoolHome, resolveHome } from "./config.js";
import { createFsWatchdog } from "./fs-watchdog.js";
import { startHerdrSync } from "./herdr/sync.js";
import { createIngestDeps } from "./ingest/pipeline.js";
import { registerMcp } from "./mcp/http.js";
import { packageVersion } from "./mcp/tools.js";
import { createSearchIndex } from "./search/index.js";
import { openDb, selfCheck } from "./store/db.js";
import { createStore } from "./store/index.js";
import type { GisoolConfig, SessionRow, Store } from "./types.js";
import { assertNodeVersion, assertPlatform, GisoolStartupError } from "./version.js";

export type ServerDeps = {
  gisoolHome?: string;
  openStore?: () => Store;
  /** Install SIGINT/SIGTERM handlers that close the daemon and exit (default true). */
  handleSignals?: boolean;
  dashboardDir?: string;
  log?: (msg: string) => void;
  /** Filesystem-stall watchdog; defaults probe GISOOL_HOME every 15 s and exit(70) after 30 s so launchd restarts. */
  fsWatchdog?: { probe?: () => Promise<unknown>; intervalMs?: number; timeoutMs?: number; onStall?: (stalledMs: number) => void };
};
export type RunningServer = { port: number; host: "127.0.0.1"; close(): Promise<void> };

export const HOST = "127.0.0.1";
export const LOG_MAX_BYTES = 5 * 1024 * 1024;
const DAY_MS = 86_400_000;

export function createFileLogger(path: string, maxBytes = LOG_MAX_BYTES): (msg: string) => void {
  mkdirSync(dirname(path), { recursive: true });
  return (msg: string) => {
    try {
      if ((statSync(path, { throwIfNoEntry: false })?.size ?? 0) >= maxBytes) renameSync(path, `${path}.1`);
      appendFileSync(path, `${new Date().toISOString()} ${msg}\n`);
    } catch (error) {
      process.stderr.write(`gisool: cannot write ${path}: ${(error as Error).message}\n${msg}\n`);
    }
  };
}

function listen(server: Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException) => {
      server.off("listening", onListening);
      reject(error.code === "EADDRINUSE" ? new GisoolStartupError("port_in_use", `${HOST}:${port} is already in use`) : error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve((server.address() as AddressInfo).port);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, HOST);
  });
}

export async function startServer(config: GisoolConfig, deps: ServerDeps = {}): Promise<RunningServer> {
  assertNodeVersion();
  assertPlatform();
  const gisoolHome = deps.gisoolHome ?? resolveGisoolHome(process.env);
  if (deps.gisoolHome === undefined) ensureGisoolHome(process.env);
  else mkdirSync(gisoolHome, { recursive: true, mode: 0o700 });
  const log = deps.log ?? createFileLogger(join(gisoolHome, "logs", "daemon.log"));
  const token = ensureToken(gisoolHome);
  const version = packageVersion();

  const db = openDb(join(gisoolHome, "gisool.db"));
  const cleanup: (() => void)[] = [];
  let store: Store | undefined;
  try {
    selfCheck(db);
    store = deps.openStore ? deps.openStore() : createStore(db, { config, gisoolHome, home: resolveHome(process.env) });
    const ownStore = store;
    cleanup.push(() => ownStore.close());
    if (deps.openStore) cleanup.push(() => db.close());

    const herdr = process.env.GISOOL_HERDR === "off" ? undefined : startHerdrSync(db, { log });
    if (herdr) cleanup.push(() => herdr.close());
    let linkQueued = false;
    let herdrClosed = false;
    cleanup.push(() => { herdrClosed = true; });

    const catalog = createCatalog({ roots: config.roots, watch: true, log });
    cleanup.push(() => catalog.close());
    await catalog.refresh();
    const search = createSearchIndex(db);
    search.rebuild(catalog.list());
    ownStore.upsertSkills(catalog.list());
    // Skills deleted while the daemon was down, or from a root removed from the config, never produce a delta.
    const present = new Set(catalog.list().map((s) => s.uri));
    const stale = (db.prepare("SELECT uri FROM skills WHERE removed_at IS NULL").all() as { uri: string }[]).map((r) => r.uri).filter((u) => !present.has(u));
    if (stale.length) ownStore.markRemoved(stale);
    catalog.onDelta((delta) => {
      try {
        search.apply(delta);
        ownStore.upsertSkills([...delta.added, ...delta.changed]);
        if (delta.removed.length) ownStore.markRemoved(delta.removed);
      } catch (error) {
        log(`applying catalog delta failed: ${(error as Error).message}`);
      }
    });

    const sessionRowStmt = db.prepare("SELECT runtime, started_at FROM sessions WHERE id = ?");
    const lookupRow = (id: string): SessionRow | undefined => {
      const meta = sessionRowStmt.get(id) as { runtime: string; started_at: number } | undefined;
      if (!meta) return undefined;
      return ownStore.sessions({ from: meta.started_at, to: meta.started_at + 1, runtime: [meta.runtime as SessionRow["runtime"]] }).find((r) => r.id === id);
    };
    const sse = createSseHub(lookupRow, log);
    cleanup.push(() => sse.close());

    const ingestDeps = createIngestDeps(ownStore, {
      captureLevel: config.captureLevel,
      publish: (change) => {
        sse.notify(change.sessionId);
        // Ingest batches are synchronous; coalesce their notifications into one linking pass.
        if (!herdr || linkQueued) return;
        linkQueued = true;
        queueMicrotask(() => {
          linkQueued = false;
          if (herdrClosed) return;
          try {
            herdr.linkSessions();
          } catch (error) {
            log(`herdr linking failed: ${error instanceof Error ? error.message : String(error)}`);
          }
        });
      },
      log: (message, error) => log(`ingest: ${message}: ${error instanceof Error ? error.message : String(error)}`),
    });

    const wd = deps.fsWatchdog ?? {};
    const watchdog = createFsWatchdog({
      probe: wd.probe ?? (() => stat(gisoolHome)),
      intervalMs: wd.intervalMs ?? 15_000,
      timeoutMs: wd.timeoutMs ?? 30_000,
      onStall: wd.onStall ?? ((stalledMs) => {
        log(`filesystem requests stalled for ${stalledMs} ms; exiting so the service manager restarts gisool`);
        process.exit(70);
      }),
    });

    let boundPort = config.port;
    const app = express();
    app.disable("x-powered-by");
    // Routes match exactly as authGate classifies them; `/API/...` must not reach an `/api/...` handler.
    app.set("case sensitive routing", true);
    app.use(localOnly(() => boundPort));
    // Authenticate before parsing so unauthenticated callers cannot make the daemon buffer bodies or bump reject counters.
    app.use(authGate(token));
    const smallJson = express.json({ limit: "1mb" });
    const otlpJson = express.json({ limit: "8mb" });
    app.use((req: Request, res: Response, next: NextFunction) => {
      // The MCP route owns parsing so malformed JSON receives a protocol error.
      if (req.path === "/mcp") return next();
      const parser = req.path.startsWith("/ingest/otlp/") ? otlpJson : smallJson;
      parser(req, res, (error?: unknown) => {
        if (!error) return next();
        const type = (error as { type?: string }).type;
        if (type === "entity.too.large") {
          ownStore.countIngest("rejected", "payload_too_large");
          return deny(res, 413, "payload_too_large");
        }
        if (req.path.startsWith("/ingest/")) ownStore.countIngest("rejected", "bad_json");
        deny(res, 400, "bad_json");
      });
    });
    app.use(requireJson((req) => {
      if (req.path.startsWith("/ingest/")) ownStore.countIngest("rejected", "unsupported_media_type");
    }));

    registerRoutes(app, { store: ownStore, catalog, ingest: ingestDeps, sse, version, log, fsHealth: () => watchdog.health() });
    registerMcp(app, { catalog, search, store: ownStore, ingest: ingestDeps, token });
    registerStatic(app, { token, ...(deps.dashboardDir ? { dir: deps.dashboardDir } : {}) });
    app.use((_req: Request, res: Response) => deny(res, 404, "not_found"));
    app.use((error: unknown, req: Request, res: Response, _next: NextFunction) => {
      const status = (error as { status?: number }).status;
      if (status === 400) return deny(res, 400, "bad_request");
      // serve-static raises 403 for malformed paths (e.g. encoded traversal); nothing is served, so report not_found.
      if (status === 403 || status === 404) return deny(res, 404, "not_found");
      if (status !== undefined && status > 400 && status < 500) return deny(res, status, "request_rejected");
      log(`${req.method} ${req.path} failed: ${(error as Error).stack ?? String(error)}`);
      if (!res.headersSent) deny(res, 500, "internal_error");
    });

    const server = createServer(app);
    boundPort = await listen(server, config.port);

    let retentionTimer: NodeJS.Timeout | undefined;
    cleanup.push(() => watchdog.stop());
    if (config.retentionDays !== null) {
      const days = config.retentionDays;
      const runRetention = () => {
        try {
          log(`retention removed ${ownStore.retention(days)} sessions older than ${days} days`);
        } catch (error) {
          log(`retention failed: ${(error as Error).message}`);
        }
      };
      runRetention();
      retentionTimer = setInterval(runRetention, DAY_MS);
      retentionTimer.unref();
    }

    let closing: Promise<void> | undefined;
    const onSignal = (signal: NodeJS.Signals) => {
      log(`received ${signal}, shutting down`);
      void close().then(() => process.exit(0));
    };
    const handleSignals = deps.handleSignals ?? true;
    if (handleSignals) {
      process.once("SIGINT", onSignal);
      process.once("SIGTERM", onSignal);
    }
    const close = () => {
      closing ??= (async () => {
        if (handleSignals) {
          process.off("SIGINT", onSignal);
          process.off("SIGTERM", onSignal);
        }
        if (retentionTimer) clearInterval(retentionTimer);
        sse.close();
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        for (const fn of cleanup.reverse()) {
          try {
            fn();
          } catch (error) {
            log(`shutdown step failed: ${(error as Error).message}`);
          }
        }
        log("gisool stopped");
      })();
      return closing;
    };

    log(`gisool ${version} listening on http://${HOST}:${boundPort}`);
    return { port: boundPort, host: HOST, close };
  } catch (error) {
    for (const fn of cleanup.reverse()) {
      try {
        fn();
      } catch {
        // Startup already failed; the original error is the one worth reporting.
      }
    }
    if (!store) db.close();
    log(`startup failed: ${(error as Error).message}`);
    throw error;
  }
}
