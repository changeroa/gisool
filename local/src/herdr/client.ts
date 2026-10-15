import { execFile } from "node:child_process";
import { createConnection, type Socket } from "node:net";
import { z } from "zod";

const messageSchema = z.object({
  id: z.string().optional(),
  result: z.unknown().optional(),
  error: z.unknown().optional(),
  event: z.string().optional(),
  data: z.unknown().optional(),
});

export type HerdrMethod = "ping" | "session.snapshot" | "events.subscribe";
export type HerdrClient = {
  request(method: HerdrMethod, params?: Record<string, unknown>): Promise<unknown>;
  close(): void;
};

/** Every connection attempt discovers the current socket with a bounded command. */
export function resolveHerdrSocket(env: NodeJS.ProcessEnv = process.env, signal?: AbortSignal): Promise<string> {
  if (env.GISOOL_HERDR_SOCKET) return Promise.resolve(env.GISOOL_HERDR_SOCKET);
  return new Promise((resolve, reject) => {
    execFile("herdr", ["status", "server"], { env, timeout: 5_000, signal }, (error, stdout) => {
      if (error) return reject(error);
      const path = /^socket:\s*(\S.*)$/m.exec(stdout)?.[1]?.trim();
      if (!path) return reject(new Error("herdr status server returned no socket: line"));
      resolve(path);
    });
  });
}

export function createHerdrClient(opts: {
  readonly env?: NodeJS.ProcessEnv;
  readonly log: (message: string) => void;
  readonly onConnect: (client: HerdrClient) => Promise<void>;
  readonly onDisconnect: () => void;
  readonly onEvent: (event: string, data: unknown) => void;
}): HerdrClient {
  const abort = new AbortController();
  let socket: Socket | undefined;
  let socketPath: string | undefined;
  const sockets = new Set<Socket>();
  let stopped = false;
  let retry: NodeJS.Timeout | undefined;
  let backoff = 1_000;
  let state: "connected" | "unreachable" | undefined;
  let seq = 0;
  const pending = new Map<string, { socket: Socket; resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
  const transition = (next: typeof state) => {
    if (state === next) return;
    state = next;
    opts.log(`herdr ${next}`);
  };
  const scheduleReconnect = () => {
    if (stopped) return;
    transition("unreachable");
    retry = setTimeout(connect, backoff);
    retry.unref();
    backoff = Math.min(backoff * 2, 30_000);
  };
  const client: HerdrClient = {
    request(method, params = {}) {
      if (stopped || !socketPath || !socket || socket.destroyed) return Promise.reject(new Error("herdr disconnected"));
      // herdr closes one-shot RPC sockets after their reply. Only subscriptions persist.
      const active = method === "events.subscribe" ? socket : createConnection(socketPath);
      if (active !== socket) attach(active);
      return new Promise((resolve, reject) => {
        const id = String(++seq);
        const timer = setTimeout(() => active.destroy(new Error(`herdr ${method} timed out`)), 5_000);
        timer.unref();
        pending.set(id, { socket: active, resolve, reject, timer });
        active.write(`${JSON.stringify({ id, method, params })}\n`);
      });
    },
    close() {
      stopped = true;
      abort.abort();
      if (retry) clearTimeout(retry);
      for (const active of sockets) active.destroy();
      for (const p of pending.values()) {
        clearTimeout(p.timer);
        p.reject(new Error("herdr client closed"));
      }
      pending.clear();
    },
  };

  const attach = (active: Socket) => {
    sockets.add(active);
    let buffer = "";
    active.setEncoding("utf8");
    active.on("error", (error) => {
      if (!stopped && active !== socket) socket?.destroy(error);
    });
    active.on("close", () => {
      sockets.delete(active);
      for (const [id, p] of pending) {
        if (p.socket !== active) continue;
        clearTimeout(p.timer);
        p.reject(new Error("herdr disconnected"));
        pending.delete(id);
      }
      if (stopped || active !== socket) return;
      for (const other of sockets) other.destroy();
      opts.onDisconnect();
      scheduleReconnect();
    });
    active.on("data", (chunk: string) => {
      buffer += chunk;
      let newline: number;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        let raw: unknown;
        try {
          raw = JSON.parse(line);
        } catch (error) {
          if (error instanceof SyntaxError) continue;
          throw error;
        }
        const parsed = messageSchema.safeParse(raw);
        if (!parsed.success) continue;
        const message = parsed.data;
        if (message.id) {
          const p = pending.get(message.id);
          if (!p || p.socket !== active) continue;
          pending.delete(message.id);
          clearTimeout(p.timer);
          if (message.error !== undefined) p.reject(new Error(`herdr error: ${JSON.stringify(message.error)}`));
          else p.resolve(message.result);
          if (active !== socket) active.destroy();
        } else if (message.event && active === socket) opts.onEvent(message.event, message.data);
      }
      if (buffer.length > 8 * 1024 * 1024) active.destroy(new Error("herdr line exceeds 8 MB"));
    });
  };
  const connect = () => {
    if (stopped) return;
    void resolveHerdrSocket(opts.env, abort.signal).then((path) => {
      if (stopped) return;
      socketPath = path;
      const active = createConnection(path);
      socket = active;
      attach(active);
      active.once("connect", () => {
        void opts.onConnect(client).then(() => {
          if (stopped || active.destroyed) return;
          backoff = 1_000;
          transition("connected");
        }, (error: unknown) => active.destroy(error instanceof Error ? error : new Error(String(error))));
      });
    }, scheduleReconnect);
  };
  connect();
  return client;
}
