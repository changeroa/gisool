import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ErrorCode, ListResourcesRequestSchema, McpError, ReadResourceRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { Catalog, SkillEntry } from "../types.js";

export const SKILLS_EXTENSION_ID = "io.modelcontextprotocol/skills";

export const SkillsListRequestSchema = z.object({
  method: z.literal("skills/list"),
  params: z.object({ cursor: z.string().optional() }).passthrough().optional(),
});

export const SkillsGetRequestSchema = z.object({
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

const TEXT_EXTENSIONS = new Set(["md", "markdown", "txt", "json", "yaml", "yml", "toml", "csv", "html", "css", "xml", "svg", "py", "sh", "bash", "zsh", "js", "mjs", "cjs", "ts", "tsx", "jsx", "rb", "go", "rs", "java", "sql", "ini", "cfg", "env"]);
const MIME: Record<string, string> = { md: "text/markdown", markdown: "text/markdown", json: "application/json", yaml: "application/yaml", yml: "application/yaml", html: "text/html", css: "text/css", svg: "image/svg+xml", csv: "text/csv", xml: "application/xml", js: "text/javascript", mjs: "text/javascript", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", pdf: "application/pdf" };
const RESOURCE_NOT_FOUND = -32002;

function extensionOf(uri: string): string {
  const file = uri.slice(uri.lastIndexOf("/") + 1);
  const dot = file.lastIndexOf(".");
  return dot < 0 ? "" : file.slice(dot + 1).toLowerCase();
}

export function registerSkillsExtension(server: McpServer, catalog: Catalog): void {
  // SEP-2640 serves skill files through the base Resources primitive, so the resources capability is declared too.
  server.server.registerCapabilities({ resources: {}, extensions: { [SKILLS_EXTENSION_ID]: {} } });

  server.server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [...catalog.list()].sort((a, b) => a.uri.localeCompare(b.uri)).map((entry) => ({
      uri: entry.uri, name: entry.name, description: entry.description, mimeType: "text/markdown",
    })),
    ...SKILLS_CACHE,
  }));

  server.server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const { uri } = request.params;
    let file: Awaited<ReturnType<Catalog["readResource"]>>;
    try {
      file = await catalog.readResource(uri);
    } catch (error) {
      throw new McpError(RESOURCE_NOT_FOUND, `Resource not found: ${uri}`, { reason: (error as { code?: string }).code ?? "unreadable" });
    }
    const ext = extensionOf(uri);
    const mimeType = MIME[ext] ?? (TEXT_EXTENSIONS.has(ext) ? "text/plain" : "application/octet-stream");
    const content = TEXT_EXTENSIONS.has(ext) ? { uri, mimeType, text: file.text } : { uri, mimeType, blob: Buffer.from(file.bytes).toString("base64") };
    return { contents: [content], ...SKILLS_CACHE };
  });

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
