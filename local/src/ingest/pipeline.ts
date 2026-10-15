import type { Attribution, CanonicalEvent, CaptureLevel, HookPayload, RuntimeId, Store } from "../types.js";
import { attribute, createAttributionState, remember, type AttributionState } from "./attribution.js";
import { normalizeHook } from "./hooks.js";
import { parseOtlpLogs } from "./otlp.js";
import { applyCapture } from "./redact.js";

export type IngestChange = { sessionId: string; attribution: Attribution; event?: CanonicalEvent };
export type IngestStore = Pick<Store, "append" | "upsertSession" | "openSessions" | "traceSession" | "reattribute" | "findEventByToolUseId" | "countIngest">;
export type IngestDeps = {
  store: IngestStore;
  captureLevel: CaptureLevel | (() => CaptureLevel);
  state: AttributionState;
  publish?: (change: IngestChange) => void;
  sessionChanged?: () => void;
  log?: (message: string, error: unknown) => void;
  now?: () => number;
};

export type OtlpResponse = { status: 200; body: { partialSuccess: Record<string, never> } } | { status: 400; body: { code: "bad_otlp"; message: string } };

export function createIngestDeps(store: IngestStore, opts: Partial<Omit<IngestDeps, "store">> = {}): IngestDeps {
  return { store, captureLevel: opts.captureLevel ?? "full", state: opts.state ?? createAttributionState(), publish: opts.publish,
    sessionChanged: opts.sessionChanged, log: opts.log, now: opts.now };
}

function nowOf(deps: IngestDeps): number {
  return deps.now ? deps.now() : Date.now();
}

function logError(deps: IngestDeps, message: string, error: unknown): void {
  if (deps.log) deps.log(message, error);
  else console.error(`[gisool ingest] ${message}`, error);
}

function count(deps: IngestDeps, kind: "accepted" | "rejected" | "dropped", code?: string): void {
  try {
    deps.store.countIngest(kind, code);
  } catch (error) {
    logError(deps, `countIngest(${kind}) failed`, error);
  }
}

function capture(event: CanonicalEvent, level: CaptureLevel): CanonicalEvent {
  if (event.text === undefined) return event;
  const captured = applyCapture(level, event.text);
  const { text: _dropped, ...rest } = event;
  const next: CanonicalEvent = { ...rest, textDigest: captured.textDigest, textLength: captured.textLength };
  if (captured.text !== undefined) next.text = captured.text;
  if (event.kind === "search" && typeof event.data.query === "string") next.data = { ...event.data, query: captured.text ?? "" };
  return next;
}

/**
 * capture -> attribute -> store.append -> publish, fully synchronous. Errors are logged, counted as
 * rejected `ingest_error`, and swallowed so one bad event never breaks a batch or blocks an agent.
 * Returns undefined for an event the store already had (a replayed record), which is counted nowhere and published nowhere.
 */
export function ingest(event: CanonicalEvent, deps: IngestDeps): Attribution | undefined {
  try {
    const level = typeof deps.captureLevel === "function" ? deps.captureLevel() : deps.captureLevel;
    const captured = capture(event, level);
    const attribution = attribute(captured, deps.store, nowOf(deps), deps.state);
    // Attribution can upsert a session even when append later rejects a replay.
    if (attribution.sessionId !== "unattributed") deps.sessionChanged?.();
    const inserted = deps.store.append(captured, attribution);
    if (captured.loadId && attribution.sessionId !== "unattributed") remember(deps.state.loadSessions, captured.loadId, attribution.sessionId);
    if (!inserted) return undefined;
    count(deps, "accepted");
    if (deps.publish && attribution.sessionId !== "unattributed") deps.publish({ sessionId: attribution.sessionId, attribution, event: captured });
    return attribution;
  } catch (error) {
    logError(deps, `failed to ingest ${event.kind} event ${event.id}`, error);
    count(deps, "rejected", "ingest_error");
    return undefined;
  }
}

/** Binds Claude tool_use_ids to sessions in either arrival order and ingests the hook's events. */
export function ingestHook(runtime: RuntimeId, payload: HookPayload, deps: IngestDeps): { accepted: number; dropped: number } {
  const now = nowOf(deps);
  const { events, bindings } = normalizeHook(runtime, payload, now);
  for (const binding of bindings) {
    try {
      const sessionId = deps.store.upsertSession(binding.ref, now);
      deps.sessionChanged?.();
      remember(deps.state.toolUseSessions, binding.toolUseId, sessionId);
      const eventId = deps.store.findEventByToolUseId(binding.toolUseId);
      if (eventId) {
        deps.store.reattribute(eventId, sessionId, "vendor_meta");
        deps.publish?.({ sessionId, attribution: { sessionId, method: "vendor_meta" } });
      }
    } catch (error) {
      logError(deps, `failed to bind tool_use_id ${binding.toolUseId}`, error);
      count(deps, "rejected", "ingest_error");
    }
  }
  if (events.length === 0 && bindings.length === 0) {
    count(deps, "dropped", "unknown_event");
    return { accepted: 0, dropped: 1 };
  }
  let accepted = 0;
  for (const event of events) if (ingest(event, deps)) accepted += 1;
  return { accepted, dropped: 0 };
}

export function ingestOtlp(body: unknown, deps: IngestDeps): OtlpResponse {
  const parsed = parseOtlpLogs(body, nowOf(deps));
  if (!parsed.ok) {
    count(deps, "rejected", parsed.error.code);
    return { status: 400, body: parsed.error };
  }
  for (let i = 0; i < parsed.unknown; i += 1) count(deps, "dropped", "unknown_event");
  for (const event of parsed.events) ingest(event, deps);
  return { status: 200, body: parsed.response };
}
