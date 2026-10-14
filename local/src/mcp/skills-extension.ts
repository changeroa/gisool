import { randomUUID } from "node:crypto";
import { CatalogError } from "../catalog/index.js";
import { errorEvent, loadEvent, readFileEvent, type McpCallContext } from "../ingest/mcp-recorder.js";
import { ingest } from "../ingest/pipeline.js";
import type { Catalog, SkillEntry } from "../types.js";
import { CACHE, RpcError, TRACE_KEY } from "./protocol.js";
import { paginate } from "./pagination.js";
import type { ToolDeps } from "./tools.js";

export const SKILLS_EXTENSION_ID = "io.modelcontextprotocol/skills";
const TEXT_EXTENSIONS = new Set(["md", "markdown", "txt", "json", "yaml", "yml", "toml", "csv", "html", "css", "xml", "svg", "py", "sh", "bash", "zsh", "js", "mjs", "cjs", "ts", "tsx", "jsx", "rb", "go", "rs", "java", "sql", "ini", "cfg", "env"]);
const MIME: Record<string, string> = { md: "text/markdown", markdown: "text/markdown", json: "application/json", yaml: "application/yaml", yml: "application/yaml", html: "text/html", css: "text/css", svg: "image/svg+xml", csv: "text/csv", xml: "application/xml", js: "text/javascript", mjs: "text/javascript", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", pdf: "application/pdf" };

function extensionOf(uri: string): string {
  const file = uri.slice(uri.lastIndexOf("/") + 1);
  return file.includes(".") ? file.slice(file.lastIndexOf(".") + 1).toLowerCase() : "";
}

function mimeOf(uri: string): string {
  const ext = extensionOf(uri);
  return MIME[ext] ?? (TEXT_EXTENSIONS.has(ext) ? "text/plain" : "application/octet-stream");
}

function toWire(entry: SkillEntry) {
  if (!entry.frontmatter) throw new RpcError(-32603, "Catalog entry has no frontmatter");
  return { uri: entry.uri, frontmatter: entry.frontmatter, resources: entry.resources.map(({ uri, digest, size }) => ({ uri, digest, size })) };
}

export function listSkills(catalog: Catalog, cursor?: string) {
  const { page, ...next } = paginate("skills/list", catalog.list(), { cursor, key: (entry) => entry.uri });
  return { skills: page.map(toWire), ...next, ...CACHE };
}

export function getSkill(catalog: Catalog, uri: string) {
  const entry = catalog.get(uri);
  if (!entry) throw new RpcError(-32602, `Not a skill served by this server: ${uri}`);
  return { skill: toWire(entry), ...CACHE };
}

export function listResources(catalog: Catalog, cursor?: string) {
  const resources = new Map(catalog.list().flatMap((entry) => entry.resources.map((file) => {
    const skill = catalog.get(file.uri);
    return [file.uri, {
      uri: file.uri, size: file.size, mimeType: mimeOf(file.uri),
      name: skill?.name ?? decodeURIComponent(file.uri.slice(file.uri.lastIndexOf("/") + 1)),
      ...(skill ? { description: skill.description } : {}),
    }] as const;
  })));
  const { page, ...next } = paginate("resources/list", [...resources.values()], { cursor, key: (file) => file.uri });
  return { resources: page, ...next, ...CACHE };
}

/** Reads are observations only: no approval state or load prerequisite is created. */
export async function readResource(deps: ToolDeps, uri: string, ctx: McpCallContext) {
  const now = () => deps.ingest.now?.() ?? Date.now();
  const trace = ctx.meta?.[TRACE_KEY];
  const ids = typeof trace === "string" ? { traceId: trace } : {};
  let file: Awaited<ReturnType<Catalog["readResource"]>>;
  try {
    file = await deps.catalog.readResource(uri);
  } catch (error) {
    const code = error instanceof CatalogError && error.code !== "digest_mismatch" ? -32602 : -32603;
    const reason = error instanceof CatalogError ? error.code : "internal_error";
    const message = code === -32602 ? `Resource not found or invalid: ${uri}` : `Resource unavailable; refresh skills/get before retrying: ${uri}`;
    ingest(errorEvent(ctx, { code: reason, message, tool: "resources/read", ...ids }, now()), deps.ingest);
    throw new RpcError(code, message, { reason });
  }
  const entry = deps.catalog.get(uri);
  if (entry) {
    // IDs identify observations, not content or connections. Two callers never share a load handle.
    const loadId = randomUUID();
    deps.store.putLoad({ loadId, uri, manifestDigest: entry.manifestDigest, resources: entry.resources, ...ids });
    ingest(loadEvent(ctx, { uri, loadId, manifestDigest: entry.manifestDigest, ...ids }, now()), deps.ingest);
  } else {
    const owner = deps.catalog.list().filter((skill) => skill.resources.some((r) => r.uri === uri)).sort((a, b) => b.uri.length - a.uri.length)[0];
    if (owner) ingest(readFileEvent(ctx, { skillUri: owner.uri, uri, bytes: file.size, ...ids }, now()), deps.ingest);
  }
  const bytes = Buffer.from(file.bytes);
  const text = TEXT_EXTENSIONS.has(extensionOf(uri)) && Buffer.from(file.text, "utf8").equals(bytes);
  const content = text ? { uri, mimeType: mimeOf(uri), text: file.text } : { uri, mimeType: mimeOf(uri), blob: bytes.toString("base64") };
  return { contents: [content], ...CACHE };
}
