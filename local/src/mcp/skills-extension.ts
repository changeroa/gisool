import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { Catalog, SkillEntry } from "../types.js";

export const SKILLS_EXTENSION_ID = "io.modelcontextprotocol/skills";

const SkillsListRequestSchema = z.object({
  method: z.literal("skills/list"),
  params: z.object({ cursor: z.string().optional() }).passthrough().optional(),
});

const SkillsGetRequestSchema = z.object({
  method: z.literal("skills/get"),
  params: z.object({ uri: z.string() }).passthrough(),
});

function toWire(entry: SkillEntry) {
  return {
    uri: entry.uri,
    frontmatter: {
      name: entry.name,
      description: entry.description,
      ...(entry.invocation === "explicit" ? { "disable-model-invocation": true } : {}),
      ...(entry.tags.length ? { keywords: entry.tags } : {}),
    },
    resources: entry.resources.map(({ uri, digest, size }) => ({ uri, digest, size })),
  };
}

export function registerSkillsExtension(server: McpServer, catalog: Catalog): void {
  server.server.registerCapabilities({ extensions: { [SKILLS_EXTENSION_ID]: {} } });

  server.server.setRequestHandler(SkillsListRequestSchema, async () => ({
    skills: [...catalog.list()].sort((a, b) => a.name.localeCompare(b.name)).map(toWire),
  }));

  server.server.setRequestHandler(SkillsGetRequestSchema, async (request) => {
    const entry = catalog.get(request.params.uri);
    if (!entry) throw new McpError(ErrorCode.InvalidParams, `Not a skill served by this server: ${request.params.uri}`);
    return { skill: toWire(entry) };
  });
}
