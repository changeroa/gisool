import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, CallToolResultSchema, ErrorCode, ListToolsRequestSchema, ListToolsResultSchema, McpError } from "@modelcontextprotocol/sdk/types.js";
import { packageVersion, SERVER_INSTRUCTIONS } from "./tools.js";

/**
 * Bridges a stdio MCP client to the daemon's Streamable HTTP endpoint. The upstream connection opens lazily after the
 * downstream initialize so the daemon sees the real client name (runtime attribution depends on it).
 */
export async function runStdioProxy(opts: { port: number; token: string }): Promise<void> {
  const version = packageVersion();
  const server = new Server({ name: "gisool", version }, { capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS });
  let upstream: Promise<Client> | undefined;

  const connect = async (): Promise<Client> => {
    const info = server.getClientVersion();
    const client = new Client({ name: info?.name ?? "gisool-stdio-proxy", version: info?.version ?? version });
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${opts.port}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${opts.token}` } },
    });
    try {
      await client.connect(transport);
    } catch (error) {
      throw new McpError(ErrorCode.InternalError, `gisool daemon is not reachable on 127.0.0.1:${opts.port}; run \`gisool serve\` (${(error as Error).message})`);
    }
    client.onclose = () => { upstream = undefined; };
    return client;
  };
  const client = () => {
    upstream ??= connect().catch((error) => { upstream = undefined; throw error; });
    return upstream;
  };

  server.setRequestHandler(ListToolsRequestSchema, async (request) =>
    (await client()).request({ method: "tools/list", params: request.params }, ListToolsResultSchema));
  server.setRequestHandler(CallToolRequestSchema, async (request) =>
    (await client()).request({ method: "tools/call", params: request.params }, CallToolResultSchema));

  const transport = new StdioServerTransport();
  const closed = new Promise<void>((resolve) => { transport.onclose = resolve; });
  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    await server.close().catch(() => undefined);
    if (upstream) await (await upstream.catch(() => undefined))?.close().catch(() => undefined);
  };
  process.stdin.once("end", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
  process.once("SIGINT", () => void shutdown());
  await server.connect(transport);
  await closed;
  await shutdown();
}
