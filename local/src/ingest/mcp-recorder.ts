import type { CanonicalEvent, SearchEventData, SearchOutcome, SessionRef, SkillUri } from "../types.js";
import { makeEvent, str } from "./hooks.js";
import { runtimeFromClientName } from "./runtimes.js";

export type McpCallContext = { clientName?: string; meta?: Record<string, unknown> };
type McpBase = { ref: SessionRef; toolUseId?: string; data: Record<string, unknown> };

/**
 * Vendor _meta keys: Codex sends unprefixed `threadId` (-> conversationId) and `sessionId` (-> runtimeSessionId);
 * Claude Code sends `claudecode/toolUseId`; OpenCode dev builds send `ai.opencode/sessionID`.
 */
export function mcpBase(ctx: McpCallContext): McpBase {
  const meta = ctx.meta ?? {};
  const ref: SessionRef = { runtime: runtimeFromClientName(ctx.clientName) };
  if (ctx.clientName) ref.clientName = ctx.clientName;
  const runtimeSessionId = str(meta.sessionId) ?? str(meta["ai.opencode/sessionID"]);
  const conversationId = str(meta.threadId);
  if (runtimeSessionId) ref.runtimeSessionId = runtimeSessionId;
  if (conversationId) ref.conversationId = conversationId;
  const toolUseId = str(meta["claudecode/toolUseId"]);
  const data: Record<string, unknown> = {};
  return toolUseId ? { ref, toolUseId, data } : { ref, data };
}

function build(kind: CanonicalEvent["kind"], ctx: McpCallContext, ts: number, extra: Partial<CanonicalEvent>, data: Record<string, unknown>): CanonicalEvent {
  const base = mcpBase(ctx);
  return makeEvent(kind, "mcp", base.ref, ts, { ...(base.toolUseId ? { toolUseId: base.toolUseId } : {}), ...extra, data: { ...base.data, ...data } });
}

export function searchEvent(ctx: McpCallContext, outcome: SearchOutcome, opts: { total: number; chosen?: SkillUri[] }, ts: number): CanonicalEvent {
  const data: SearchEventData & { chosen: SkillUri[] } = {
    query: outcome.query, mode: outcome.mode, candidates: outcome.candidates, elapsedMs: outcome.elapsedMs, total: opts.total, chosen: opts.chosen ?? [],
    ...(outcome.abstained ? { abstained: outcome.abstained } : {}),
  };
  return build("search", ctx, ts, { traceId: outcome.traceId, text: outcome.query }, data);
}

export function loadEvent(ctx: McpCallContext, load: { uri: SkillUri; loadId: string; manifestDigest: string; traceId?: string }, ts: number): CanonicalEvent {
  return build("load", ctx, ts, { skillUri: load.uri, loadId: load.loadId, ...(load.traceId ? { traceId: load.traceId } : {}) },
    { uri: load.uri, loadId: load.loadId, manifestDigest: load.manifestDigest, observationOnly: true });
}

export function readFileEvent(ctx: McpCallContext, read: { skillUri: SkillUri; uri: SkillUri; bytes: number; loadId?: string; traceId?: string }, ts: number): CanonicalEvent {
  return build("read_file", ctx, ts, { skillUri: read.skillUri, ...(read.loadId ? { loadId: read.loadId } : {}), ...(read.traceId ? { traceId: read.traceId } : {}) },
    { skillUri: read.skillUri, uri: read.uri, bytes: read.bytes });
}

export function errorEvent(ctx: McpCallContext, err: { code: string; message: string; tool?: string; traceId?: string; skillUri?: SkillUri; loadId?: string }, ts: number): CanonicalEvent {
  return build("error", ctx, ts, { ...(err.traceId ? { traceId: err.traceId } : {}), ...(err.skillUri ? { skillUri: err.skillUri } : {}), ...(err.loadId ? { loadId: err.loadId } : {}) },
    { code: err.code, message: err.message, ...(err.tool ? { tool: err.tool } : {}) });
}
