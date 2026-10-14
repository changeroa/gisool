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

// The catalog is this user's local skills and is refreshed by a file watcher.
export const SKILLS_CACHE = { ttlMs: 60_000, cacheScope: "private" } as const;

function toWire(entry: SkillEntry) {
  return {
    uri: entry.uri,
    frontmatter: entry.frontmatter ?? { name: entry.name, description: entry.description },
    resources: entry.resources.map(({ uri, digest, size }) => ({ uri, digest, size })),
  };
}

export function registerSkillsExtension(server: McpServer, catalog: Catalog): void {
  server.server.registerCapabilities({ extensions: { [SKILLS_EXTENSION_ID]: {} } });

  server.server.setRequestHandler(SkillsListRequestSchema, async () => ({
    skills: [...catalog.list()].sort((a, b) => a.name.localeCompare(b.name)).map(toWire),
    ...SKILLS_CACHE,
  }));

  server.server.setRequestHandler(SkillsGetRequestSchema, async (request) => {
    const entry = catalog.get(request.params.uri);
    if (!entry) throw new McpError(ErrorCode.InvalidParams, `Not a skill served by this server: ${request.params.uri}`);
    return { skill: toWire(entry), ...SKILLS_CACHE };
  });
}
