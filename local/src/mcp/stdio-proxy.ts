import { createInterface } from "node:readline";
import { checkVersion, errorResponse, idSchema, messageId, messageSchema, parseParams, requestHeaders, responseSchema, RpcError, rpcFailure } from "./protocol.js";

/** Transparent modern stdio binding. Client identity and capabilities stay on each request. */
export async function runStdioProxy(opts: { port: number; token: string }): Promise<void> {
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const pending = new Map<string | number, AbortController>();
  const send = (value: unknown) => { process.stdout.write(JSON.stringify(value) + "\n"); };
  let closing = false;
  const shutdown = () => {
    closing = true;
    for (const controller of pending.values()) controller.abort();
    pending.clear();
    lines.close();
    process.stdin.pause();
  };
  const onLine = async (line: string) => {
    let value: unknown;
    try { value = JSON.parse(line); } catch {
      send(errorResponse(undefined, new RpcError(-32700, "Invalid JSON")));
      return;
    }
    const parsed = messageSchema.safeParse(value);
    if (!parsed.success) { send(errorResponse(messageId(value), new RpcError(-32600, "Expected one JSON-RPC request or notification"))); return; }
    const message = parsed.data;
    if (message.id === undefined) {
      if (message.method === "notifications/cancelled" && typeof message.params === "object" && message.params !== null && "requestId" in message.params) {
        const id = idSchema.safeParse(message.params.requestId);
        if (id.success) pending.get(id.data)?.abort();
      }
      return;
    }
    let controller: AbortController | undefined;
    try {
      const params = parseParams(message);
      checkVersion(params._meta);
      if (pending.has(message.id)) throw new RpcError(-32600, "Request ID is already in flight");
      controller = new AbortController();
      pending.set(message.id, controller);
      const response = await fetch(`http://127.0.0.1:${opts.port}/mcp`, {
        method: "POST",
        headers: { ...requestHeaders(message, params), Authorization: `Bearer ${opts.token}` },
        body: JSON.stringify(message),
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(60_000)]),
      });
      const body: unknown = await response.json();
      const reply = responseSchema.safeParse(body);
      if (!reply.success || reply.data.id !== message.id) throw new RpcError(-32603, `Daemon returned an invalid MCP response (HTTP ${response.status})`);
      if (!closing && !controller.signal.aborted) send(reply.data);
    } catch (error) {
      if (!closing && !controller?.signal.aborted) send(errorResponse(message.id, rpcFailure(error)));
    } finally {
      if (controller && pending.get(message.id) === controller) pending.delete(message.id);
    }
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
  await new Promise<void>((resolve) => {
    lines.on("line", (line) => { if (!closing) void onLine(line); });
    lines.once("close", resolve);
  });
  shutdown();
  process.off("SIGTERM", shutdown);
  process.off("SIGINT", shutdown);
}
