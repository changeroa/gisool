import type { Request, Response } from "express";
import type { SessionRow } from "../types.js";

export type SseHub = {
  handler(req: Request, res: Response): void;
  notify(sessionId: string): void;
  clientCount(): number;
  close(): void;
};

export function createSseHub(lookup: (sessionId: string) => SessionRow | undefined, log: (msg: string) => void, heartbeatMs = 25_000): SseHub {
  const clients = new Set<Response>();
  const pending = new Set<string>();
  let scheduled = false;

  const flush = () => {
    scheduled = false;
    const ids = [...pending];
    pending.clear();
    if (clients.size === 0) return;
    for (const id of ids) {
      let row: SessionRow | undefined;
      try {
        row = lookup(id);
      } catch (error) {
        log(`sse lookup for session ${id} failed: ${(error as Error).message}`);
        continue;
      }
      if (!row) continue;
      const frame = `event: session\ndata: ${JSON.stringify(row)}\n\n`;
      for (const res of clients) res.write(frame);
    }
  };

  const heartbeat = setInterval(() => {
    for (const res of clients) res.write(": ping\n\n");
  }, heartbeatMs);
  heartbeat.unref();

  return {
    handler(req, res) {
      res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store", Connection: "keep-alive", "X-Accel-Buffering": "no" });
      res.write(": connected\n\n");
      clients.add(res);
      req.on("close", () => clients.delete(res));
    },
    notify(sessionId) {
      pending.add(sessionId);
      if (!scheduled) {
        scheduled = true;
        setImmediate(flush);
      }
    },
    clientCount: () => clients.size,
    close() {
      clearInterval(heartbeat);
      for (const res of clients) res.end();
      clients.clear();
      pending.clear();
    },
  };
}
