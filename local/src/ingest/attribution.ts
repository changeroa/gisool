import type { Attribution, CanonicalEvent, Store } from "../types.js";

export const WINDOW_MS = 120_000;
export const URI_WINDOW_MS = 10_000;
const MAX_TRACKED = 10_000;

type AttributionStore = Pick<Store, "upsertSession" | "openSessions" | "traceSession">;

/**
 * In-process join tables that the Store contract does not persist:
 * Claude tool_use_id -> session (from PostToolUse hooks) and loadId -> session (from attributed loads).
 */
export type AttributionState = {
  toolUseSessions: Map<string, string>;
  loadSessions: Map<string, string>;
};

export function createAttributionState(): AttributionState {
  return { toolUseSessions: new Map(), loadSessions: new Map() };
}

export function remember(map: Map<string, string>, key: string, value: string): void {
  map.delete(key);
  map.set(key, value);
  if (map.size > MAX_TRACKED) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
}

function attributed(sessionId: string | undefined): sessionId is string {
  return sessionId !== undefined && sessionId !== "unattributed";
}

/** Exact JSON string values only: a URI mentioned in shell/exec source is not a resource-read argument. */
export function toolCallReferencesUri(text: string | null, uri: string, gisoolMcp: boolean): boolean {
  if (text === null) return false;
  let args: unknown;
  try {
    args = JSON.parse(text);
  } catch {
    return false; // Truncated or non-JSON arguments cannot prove a URI match.
  }
  // Historical OTLP resource calls predate gisoolMcp; their explicit server argument is equally strong evidence.
  const server = args !== null && typeof args === "object" && "server" in args ? args.server : undefined;
  if (!gisoolMcp && !(typeof server === "string" && server.toLowerCase() === "gisool")) return false;
  const references = (value: unknown): boolean => {
    if (typeof value === "string") return value === uri;
    if (Array.isArray(value)) return value.some(references);
    return value !== null && typeof value === "object" && Object.values(value).some(references);
  };
  return references(args);
}

export function attribute(event: CanonicalEvent, store: AttributionStore, now: number, state: AttributionState = createAttributionState()): Attribution {
  const { ref } = event;
  const hasRuntimeKey = Boolean(ref.runtimeSessionId || ref.conversationId);

  // (1) hook / OTel events carry the runtime's own session id.
  if (event.source !== "mcp" && hasRuntimeKey) {
    return { sessionId: store.upsertSession(ref, event.ts), method: "runtime_id" };
  }

  // (2) MCP events: vendor _meta session ids, or a Claude tool_use_id already bound by a PostToolUse hook.
  if (event.source === "mcp") {
    if (hasRuntimeKey) return { sessionId: store.upsertSession(ref, event.ts), method: "vendor_meta" };
    const bound = event.toolUseId ? state.toolUseSessions.get(event.toolUseId) : undefined;
    if (bound) return { sessionId: bound, method: "vendor_meta" };
  }

  // (3) load / read_file joined to an attributed search (traceId) or load (loadId).
  if (event.kind === "load" || event.kind === "read_file") {
    const viaTrace = event.traceId ? store.traceSession(event.traceId) : undefined;
    if (attributed(viaTrace)) return { sessionId: viaTrace, method: "trace_handle" };
    const viaLoad = event.loadId ? state.loadSessions.get(event.loadId) : undefined;
    if (attributed(viaLoad)) return { sessionId: viaLoad, method: "trace_handle" };
  }

  // (4) exactly one open session of the same runtime active within the window; never across runtimes.
  if (ref.runtime === "unknown") return { sessionId: "unattributed", method: "none", reason: "no_session" };
  const open = store.openSessions(ref.runtime, 0).filter((s) => s.ref.runtime === ref.runtime);
  const fresh = open.filter((s) => now - s.lastActivityAt <= WINDOW_MS);
  if (fresh.length === 1) return { sessionId: fresh[0]!.id, method: "window" };

  // (5) unattributed with the reason the window could not decide.
  if (fresh.length > 1) return { sessionId: "unattributed", method: "none", reason: "ambiguous" };
  if (open.length > 0) return { sessionId: "unattributed", method: "none", reason: "stale" };
  return { sessionId: "unattributed", method: "none", reason: "no_session" };
}
