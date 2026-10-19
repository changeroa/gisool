import { z } from "zod";
import { CACHE, CLIENT_INFO_KEY, PROTOCOL_VERSION, RpcError, type Message, type RequestParams } from "./protocol.js";
import { paginate } from "./pagination.js";
import { getSkill, listResources, listSkills, readResource, SKILLS_EXTENSION_ID } from "./skills-extension.js";
import { createSearchTool, packageVersion, SEARCH_TOOL, SERVER_INSTRUCTIONS, type ToolDeps } from "./tools.js";

const listParams = z.object({ cursor: z.string().optional() }).passthrough();
const uriParams = z.object({ uri: z.string().min(1) }).passthrough();
const toolParams = z.object({ name: z.string(), arguments: z.record(z.string(), z.unknown()).optional() }).passthrough();

export function createDispatcher(deps: ToolDeps) {
  const search = createSearchTool(deps);
  const serverInfo = { name: "gisool", version: packageVersion() };
  return async (request: Message, params: RequestParams) => {
    const clientInfo = params._meta[CLIENT_INFO_KEY];
    const ctx = { ...(clientInfo ? { clientName: clientInfo.name } : {}), meta: params._meta };
    let result: Record<string, unknown>;
    switch (request.method) {
      case "server/discover":
        result = {
          supportedVersions: [PROTOCOL_VERSION],
          capabilities: { tools: {}, resources: {}, extensions: { [SKILLS_EXTENSION_ID]: {} } },
          instructions: SERVER_INSTRUCTIONS, ...CACHE,
        };
        break;
      case "tools/list": {
        const { cursor } = listParams.parse(params);
        const { page, ...next } = paginate("tools/list", [SEARCH_TOOL], { cursor, key: (tool) => tool.name });
        result = { tools: page, ...next, ...CACHE };
        break;
      }
      case "tools/call": {
        const { name, arguments: args } = toolParams.parse(params);
        if (name !== SEARCH_TOOL.name) throw new RpcError(-32602, `Unknown tool: ${name}`);
        result = search(args, ctx);
        break;
      }
      case "skills/list":
        result = listSkills(deps.catalog, listParams.parse(params).cursor);
        break;
      case "skills/get":
        result = getSkill(deps.catalog, uriParams.parse(params).uri);
        break;
      case "resources/list":
        result = listResources(deps.catalog, listParams.parse(params).cursor);
        break;
      case "resources/read":
        result = await readResource(deps, uriParams.parse(params).uri, ctx);
        break;
      default:
        throw new RpcError(-32601, `Unknown method: ${request.method}`);
    }
    return { resultType: "complete", ...result, _meta: { "io.modelcontextprotocol/serverInfo": serverInfo } };
  };
}
