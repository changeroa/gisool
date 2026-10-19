import { createInterface } from "node:readline";
import { initializeResult, initializeSchema, isLegacyRequest, legacyLocalResult, negotiateVersion, toLegacyResult, toModernMessage, type ClientInfo } from "./legacy.js";
import { checkVersion, errorResponse, idSchema, messageId, messageSchema, parseParams, requestHeaders, responseSchema, RpcError, rpcFailure, type Message } from "./protocol.js";

/**
 * Dual-era stdio binding. Modern requests pass through with their own identity and capabilities. A legacy
 * `initialize` scopes its client identity to this process; legacy requests are forwarded as modern ones.
 */
export async function runStdioProxy(opts: { port: number; token: string }): Promise<void> {
  let legacyClient: ClientInfo | undefined;
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
    const forward = async (request: Message, signal: AbortSignal) => {
      const params = parseParams(request);
      checkVersion(params._meta);
      const response = await fetch(`http://127.0.0.1:${opts.port}/mcp`, {
        method: "POST",
        headers: { ...requestHeaders(request, params), Authorization: `Bearer ${opts.token}` },
        body: JSON.stringify(request),
        signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]),
      });
      const body: unknown = await response.json();
      const reply = responseSchema.safeParse(body);
      if (!reply.success || reply.data.id !== request.id) throw new RpcError(-32603, `Daemon returned an invalid MCP response (HTTP ${response.status})`);
      return reply.data;
    };
    try {
      if (pending.has(message.id)) throw new RpcError(-32600, "Request ID is already in flight");
      controller = new AbortController();
      pending.set(message.id, controller);
      let reply: unknown;
      if (!isLegacyRequest(message)) {
        reply = await forward(message, controller.signal);
      } else if (message.method === "initialize") {
        const init = initializeSchema.safeParse(message.params);
        if (!init.success) throw new RpcError(-32602, "Invalid initialize params", init.error.issues);
        const clientInfo = { name: init.data.clientInfo.name, version: init.data.clientInfo.version };
        const discover = await forward(toModernMessage({ jsonrpc: "2.0", id: message.id, method: "server/discover" }, clientInfo), controller.signal);
        if ("error" in discover) throw new RpcError(discover.error.code, discover.error.message, discover.error.data);
        legacyClient = clientInfo;
        reply = { jsonrpc: "2.0", id: message.id, result: initializeResult(negotiateVersion(init.data.protocolVersion), discover.result) };
      } else {
        const local = legacyLocalResult(message.method);
        const modern = local ? undefined : await forward(toModernMessage(message, legacyClient), controller.signal);
        reply = modern && "error" in modern ? modern : { jsonrpc: "2.0", id: message.id, result: local ?? toLegacyResult(modern!.result) };
      }
      if (!closing && !controller.signal.aborted) send(reply);
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
