import type { OtelSpanRow, RuntimeId, Store } from "../types.js";

// OTLP/HTTP JSON ExportTraceServiceRequest decoding per https://opentelemetry.io/docs/specs/otlp/
// (lowerCamelCase fields, int64 as decimal strings, AnyValue as a one-of object). Only the keys of the
// otel_spans whitelist are read; no other span attribute is decoded, and none is stored.
type AnyValue = { stringValue?: unknown; intValue?: unknown };
type KeyValue = { key?: unknown; value?: unknown };
type Span = { traceId?: unknown; spanId?: unknown; parentSpanId?: unknown; name?: unknown;
  startTimeUnixNano?: unknown; endTimeUnixNano?: unknown; attributes?: unknown };

export type OtlpTracesOk = { ok: true; spans: OtelSpanRow[]; dropped: number; response: { partialSuccess: Record<string, never> } };
export type OtlpTracesError = { ok: false; status: 400; error: { code: "bad_otlp"; message: string } };
export type OtlpTracesResult = OtlpTracesOk | OtlpTracesError;

export type TracesStore = Pick<Store, "putSpans" | "countIngest">;
export type OtlpTracesResponse =
  | { status: 200; body: { partialSuccess: Record<string, never> }; kept: number; dropped: number }
  | { status: 400; body: { code: "bad_otlp"; message: string } };

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Join keys and ids are strings; an exporter that sends one as an int64 AnyValue still joins, so it is normalized. */
function attrString(list: unknown, key: string): string | undefined {
  if (!Array.isArray(list)) return undefined;
  for (const kv of list as KeyValue[]) {
    if (!kv || typeof kv !== "object" || kv.key !== key) continue;
    const value = kv.value as AnyValue | undefined;
    if (!value || typeof value !== "object") return undefined;
    if (typeof value.stringValue === "string") return nonEmpty(value.stringValue);
    if (typeof value.intValue === "string" || typeof value.intValue === "number") return nonEmpty(String(value.intValue));
    return undefined;
  }
  return undefined;
}

function msOf(nanos: unknown): number | undefined {
  const n = typeof nanos === "string" || typeof nanos === "number" ? Number(nanos) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.floor(n / 1e6) : undefined;
}

function runtimeOf(serviceName: string): RuntimeId {
  const name = serviceName.toLowerCase();
  if (name.includes("codex")) return "codex";
  if (name.includes("claude")) return "claude-code";
  return "unknown";
}

/**
 * Keeps a span only when it can be joined later: it carries `turn_id`, `turn.id` or `call_id`, and the ids the join
 * itself runs on (trace id, span id, name). Everything else is dropped here - one small Codex turn exports ~1,885
 * spans, almost all of them runtime internals (fs.read_file, auth, …) that answer no question about skill use.
 */
function rowOf(span: Span | undefined, runtime: RuntimeId, now: number): OtelSpanRow | undefined {
  if (!span || typeof span !== "object") return undefined;
  const attrs = span.attributes;
  const turnKey = attrString(attrs, "turn_id") ?? attrString(attrs, "turn.id");
  const callId = attrString(attrs, "call_id");
  if (turnKey === undefined && callId === undefined) return undefined;
  const traceId = nonEmpty(span.traceId);
  const spanId = nonEmpty(span.spanId);
  const name = nonEmpty(span.name);
  if (traceId === undefined || spanId === undefined || name === undefined) return undefined;
  const parentSpanId = nonEmpty(span.parentSpanId);
  const conversationId = attrString(attrs, "conversation.id");
  const startMs = msOf(span.startTimeUnixNano);
  const endMs = msOf(span.endTimeUnixNano);
  return {
    traceId, spanId, name, runtime, receivedAt: now,
    ...(parentSpanId !== undefined ? { parentSpanId } : {}),
    ...(conversationId !== undefined ? { conversationId } : {}),
    ...(turnKey !== undefined ? { turnKey } : {}),
    ...(callId !== undefined ? { callId } : {}),
    ...(startMs !== undefined ? { startMs } : {}),
    ...(endMs !== undefined ? { endMs } : {}),
  };
}

function badOtlp(message: string): OtlpTracesError {
  return { ok: false, status: 400, error: { code: "bad_otlp", message } };
}

/** Parses an OTLP/HTTP JSON traces export into the joinable spans; every other span is counted as dropped. */
export function parseOtlpTraces(body: unknown, now: number): OtlpTracesResult {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return badOtlp("body must be an ExportTraceServiceRequest JSON object");
  const resourceSpans = (body as { resourceSpans?: unknown }).resourceSpans;
  if (!Array.isArray(resourceSpans)) return badOtlp("resourceSpans must be an array");
  const spans: OtelSpanRow[] = [];
  let dropped = 0;
  for (const rs of resourceSpans as { resource?: { attributes?: unknown }; scopeSpans?: unknown }[]) {
    const runtime = runtimeOf(attrString(rs?.resource?.attributes, "service.name") ?? "");
    const scopeSpans = Array.isArray(rs?.scopeSpans) ? (rs.scopeSpans as { spans?: unknown }[]) : [];
    for (const ss of scopeSpans) {
      const list = Array.isArray(ss?.spans) ? (ss.spans as Span[]) : [];
      for (const span of list) {
        const row = rowOf(span, runtime, now);
        if (row) spans.push(row);
        else dropped += 1;
      }
    }
  }
  return { ok: true, spans, dropped, response: { partialSuccess: {} } };
}

/**
 * Parses a traces batch and stores the joinable spans, counting kept and dropped spans with the ingest counters.
 * A store failure propagates: the caller runs after the 202 was sent and owns the logging.
 */
export function ingestOtlpTraces(body: unknown, store: TracesStore, now: number): OtlpTracesResponse {
  const parsed = parseOtlpTraces(body, now);
  if (!parsed.ok) {
    store.countIngest("rejected", parsed.error.code);
    return { status: 400, body: parsed.error };
  }
  const kept = store.putSpans(parsed.spans, parsed.dropped);
  return { status: 200, body: parsed.response, kept, dropped: parsed.dropped };
}
