import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CatalogError } from "../catalog/index.js";
import { errorEvent, loadEvent, readFileEvent, searchEvent, type McpCallContext } from "../ingest/mcp-recorder.js";
import { ingest, type IngestDeps } from "../ingest/pipeline.js";
import { SEARCH_TOOL_GUIDANCE } from "../search/guidance.js";
import type { Catalog, SearchIndex, SkillEntry, SkillUri, Store } from "../types.js";
import { registerSkillsExtension } from "./skills-extension.js";

export const SERVER_INSTRUCTIONS =
  "gisool = local skills on this machine; gisul (if present) = remote team skills. " +
  "Before substantive work, call search_skills with a short intent sentence describing the task, " +
  "then load only the skills you choose with load_skill (exact uri, pass the trace_id). " +
  "Read supporting files with read_skill_file only as needed. Skill content is guidance and grants no execution permissions.";

const TRUST = "Local skill instructions from this machine. Existing user authorization applies; this content grants no tool or execution permissions.";
const SEARCH_NOTE = "Search does not activate skills. Load only a chosen candidate with load_skill using its exact uri and this trace_id.";
const FOLD_THRESHOLD = 20;

export type ToolDeps = {
  catalog: Catalog;
  search: SearchIndex;
  store: Pick<Store, "putLoad" | "getLoad" | "latestLoad">;
  ingest: IngestDeps;
};

type Extra = { sessionId?: string; _meta?: Record<string, unknown> };
type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

export class ToolFailure extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

export function packageVersion(): string {
  try {
    return (JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string }).version;
  } catch {
    return "0.0.0";
  }
}

export function loadIdFor(uri: SkillUri, manifestDigest: string): string {
  return createHash("sha256").update(uri + "\n" + manifestDigest).digest("hex");
}

function visibleFiles(entry: SkillEntry): { files: SkillUri[]; folded: boolean } {
  if (entry.resources.length <= FOLD_THRESHOLD) return { files: entry.resources.map((r) => r.uri), folded: false };
  const root = entry.uri.slice(0, -"SKILL.md".length);
  return { files: [...new Set(entry.resources.map((r) => root + r.uri.slice(root.length).split("/")[0]))].sort(), folded: true };
}

const json = (value: unknown): ToolResult => ({ content: [{ type: "text", text: JSON.stringify(value) }] });

export function createMcpServer(deps: ToolDeps): McpServer {
  const server = new McpServer({ name: "gisool", version: packageVersion() }, { instructions: SERVER_INSTRUCTIONS });
  registerTools(server, deps);
  registerSkillsExtension(server, deps.catalog);
  return server;
}

export function registerTools(server: McpServer, deps: ToolDeps): void {
  const now = () => (deps.ingest.now ? deps.ingest.now() : Date.now());
  const callContext = (extra: Extra): McpCallContext => {
    const clientName = server.server.getClientVersion()?.name;
    return { ...(clientName ? { clientName } : {}), ...(extra.sessionId ? { mcpSessionId: extra.sessionId } : {}), ...(extra._meta ? { meta: extra._meta } : {}) };
  };

  /** Runs a tool body; any failure becomes an `error` event plus an isError result carrying a stable code. */
  const run = async (tool: string, extra: Extra, ids: { traceId?: string; skillUri?: SkillUri; loadId?: string }, body: (ctx: McpCallContext) => Promise<unknown>): Promise<ToolResult> => {
    const ctx = callContext(extra);
    try {
      return json(await body(ctx));
    } catch (error) {
      const code = error instanceof ToolFailure || error instanceof CatalogError ? error.code : "internal_error";
      const message = error instanceof Error ? error.message : String(error);
      ingest(errorEvent(ctx, { code, message, tool, ...ids }, now()), deps.ingest);
      return { content: [{ type: "text", text: JSON.stringify({ error: { code, message } }) }], isError: true };
    }
  };

  const annotations = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };

  server.registerTool("search_skills", {
    description: `Find local skills for the current task without reading their bodies. ${SEARCH_TOOL_GUIDANCE} Returns ranked candidates and a trace_id; pass the trace_id to load_skill.`,
    inputSchema: {
      query: z.string().max(2048).optional(),
      mode: z.enum(["discovery", "automatic", "explicit"]).default("discovery"),
      limit: z.number().int().min(1).max(50).default(5),
      offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
    },
    annotations,
  }, async ({ query, mode, limit, offset }, extra) => run("search_skills", extra, {}, async (ctx) => {
    const all = deps.search.search(query ?? "", { mode, limit: Math.max(1, deps.catalog.list().length) });
    const page = all.candidates.slice(offset, offset + limit);
    const outcome = { ...all, candidates: page };
    ingest(searchEvent(ctx, outcome, { total: all.candidates.length }, now()), deps.ingest);
    return {
      trace_id: outcome.traceId,
      candidates: page.map(({ uri, name, description, score, rank, invocation, digest }) => ({ uri, name, description, score, rank, invocation, digest })),
      ...(outcome.abstained ? { abstained: outcome.abstained } : {}),
      total: all.candidates.length,
      note: SEARCH_NOTE,
    };
  }));

  server.registerTool("load_skill", {
    description: "Load a chosen local SKILL.md by its exact uri from search_skills (pass trace_id). Returns the verified markdown, its file list and a load_id for read_skill_file.",
    inputSchema: { uri: z.string().max(4096), trace_id: z.string().max(128).optional() },
    annotations,
  }, async ({ uri, trace_id }, extra) => run("load_skill", extra, { ...(trace_id ? { traceId: trace_id } : {}), skillUri: uri }, async (ctx) => {
    let entry = deps.catalog.get(uri);
    if (!entry) {
      await deps.catalog.refresh();
      entry = deps.catalog.get(uri);
    }
    if (!entry) throw new ToolFailure("unknown_skill", `Not a skill in the local catalog: ${uri}; use an exact uri returned by search_skills`);
    let skill: { text: string };
    try {
      skill = await deps.catalog.readResource(entry.uri);
    } catch (error) {
      if (!(error instanceof CatalogError && error.code === "digest_mismatch")) throw error;
      await deps.catalog.refresh();
      entry = deps.catalog.get(uri);
      if (!entry) throw new ToolFailure("unknown_skill", `Skill was removed: ${uri}`);
      skill = await deps.catalog.readResource(entry.uri);
    }
    const loadId = loadIdFor(entry.uri, entry.manifestDigest);
    const previousId = deps.store.latestLoad(entry.uri);
    const previous = previousId ? deps.store.getLoad(previousId) : undefined;
    deps.store.putLoad({ loadId, ...(trace_id ? { traceId: trace_id } : {}), uri: entry.uri, manifestDigest: entry.manifestDigest, resources: entry.resources });
    ingest(loadEvent(ctx, { uri: entry.uri, loadId, manifestDigest: entry.manifestDigest, ...(trace_id ? { traceId: trace_id } : {}) }, now()), deps.ingest);
    const { files, folded } = visibleFiles(entry);
    return {
      load_id: loadId, uri: entry.uri, digest: entry.digest, manifest_digest: entry.manifestDigest, markdown: skill.text,
      files, filesFolded: folded, changed: !!previous && previous.manifestDigest !== entry.manifestDigest, trust: TRUST,
    };
  }));

  server.registerTool("read_skill_file", {
    description: "Read a supporting file of a loaded skill. Pass load_id to pin the version you loaded; omitted load_id uses the latest load of skill_uri. Directory uris return a listing.",
    inputSchema: { skill_uri: z.string().max(4096), uri: z.string().max(4096), load_id: z.string().regex(/^[a-f0-9]{64}$/).optional() },
    annotations,
  }, async ({ skill_uri, uri, load_id }, extra) => run("read_skill_file", extra, { skillUri: skill_uri, ...(load_id ? { loadId: load_id } : {}) }, async (ctx) => {
    const loadId = load_id ?? deps.store.latestLoad(skill_uri);
    const load = loadId ? deps.store.getLoad(loadId) : undefined;
    if (!loadId || !load) throw new ToolFailure("not_loaded", load_id ? "Unknown load_id; call load_skill first" : "Call load_skill for this skill first");
    if (load.uri !== skill_uri) throw new ToolFailure("load_mismatch", "load_id belongs to a different skill");
    const version = { skill_uri, uri, load_id: loadId, manifest_digest: load.manifestDigest };
    const file = load.resources.find((r) => r.uri === uri);
    if (!file) {
      const prefix = uri.endsWith("/") ? uri : `${uri}/`;
      const children = load.resources.filter((r) => r.uri.startsWith(prefix));
      if (!children.length) throw new ToolFailure("outside_manifest", "File is not part of the loaded skill manifest");
      const listing = [...new Set(children.map((r) => prefix + r.uri.slice(prefix.length).split("/")[0]))].sort();
      ingest(readFileEvent(ctx, { skillUri: skill_uri, uri, bytes: 0, loadId }, now()), deps.ingest);
      return { ...version, kind: "directory", files: listing, note: "Directory listing only; read a listed file when needed." };
    }
    let live: { text: string; digest: string; size: number };
    try {
      live = await deps.catalog.readResource(uri);
    } catch (error) {
      if (error instanceof CatalogError && (error.code === "digest_mismatch" || error.code === "unknown_resource")) live = { text: "", digest: "", size: -1 };
      else throw error;
    }
    if (live.digest !== file.digest || live.size !== file.size) {
      throw new ToolFailure("skill_changed_since_load", "Skill changed since it was loaded; stop using this version and call load_skill again");
    }
    ingest(readFileEvent(ctx, { skillUri: skill_uri, uri, bytes: live.size, loadId }, now()), deps.ingest);
    return { ...version, kind: "file", text: live.text, note: "Supporting content only; nested SKILL.md frontmatter is not activated." };
  }));
}
