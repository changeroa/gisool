import type { CanonicalEvent, SessionRef } from "../types.js";
import { makeEvent, skillNameFromPath, skillNamesInCommand, str } from "./hooks.js";
import { sha256Hex } from "./redact.js";

// OTLP/HTTP JSON ExportLogsServiceRequest decoding per https://opentelemetry.io/docs/specs/otlp/
// (lowerCamelCase fields, int64 as decimal strings, AnyValue as a one-of object).
type AnyValue = {
  stringValue?: string; boolValue?: boolean; intValue?: string | number; doubleValue?: number;
  arrayValue?: { values?: AnyValue[] }; kvlistValue?: { values?: KeyValue[] }; bytesValue?: string;
};
type KeyValue = { key: string; value?: AnyValue };
type LogRecord = { timeUnixNano?: string | number; observedTimeUnixNano?: string | number; eventName?: string; body?: AnyValue;
  attributes?: KeyValue[]; traceId?: string; spanId?: string };
type Attrs = Record<string, unknown>;

/**
 * One canonical event derived from one agent record. `discriminator` tells apart events of the same kind
 * derived from the same record (the skill name of a skill-derived event); it is part of the source_key.
 */
type Derived = { event: CanonicalEvent; discriminator: string };

export type OtlpOk = { ok: true; events: CanonicalEvent[]; unknown: number; ignored: number; response: { partialSuccess: Record<string, never> } };
export type OtlpError = { ok: false; status: 400; error: { code: "bad_otlp"; message: string } };
export type OtlpResult = OtlpOk | OtlpError;

/**
 * Known event names gisool deliberately does not store: they carry no model call, tool run or skill signal.
 * They count as `ignored`, never as `unknown`, so `ingest.dropped` keeps meaning "gisool did not understand this".
 * `codex.api_request` belongs here because it carries neither a session nor a timestamp id and cannot be attributed.
 */
const IGNORED_NAMES = new Set([
  "claude_code.tool_decision", "claude_code.mcp_server_connection", "claude_code.plugin_loaded", "claude_code.assistant_response",
  "codex.startup_phase", "codex.turn_ttft", "codex.tool_decision", "codex.api_request",
]);
const IGNORED_PREFIXES = ["claude_code.hook_", "codex.websocket_"];

function decode(value: AnyValue | undefined): unknown {
  if (!value || typeof value !== "object") return undefined;
  if (value.stringValue !== undefined) return value.stringValue;
  if (value.boolValue !== undefined) return value.boolValue;
  if (value.intValue !== undefined) return Number(value.intValue);
  if (value.doubleValue !== undefined) return value.doubleValue;
  if (value.arrayValue) return (value.arrayValue.values ?? []).map(decode);
  if (value.kvlistValue) return toAttrs(value.kvlistValue.values);
  if (value.bytesValue !== undefined) return value.bytesValue;
  return undefined;
}

function toAttrs(list: KeyValue[] | undefined): Attrs {
  const out: Attrs = {};
  if (!Array.isArray(list)) return out;
  for (const kv of list) if (kv && typeof kv.key === "string") out[kv.key] = decode(kv.value);
  return out;
}

/** Numeric attributes arrive as intValue (decimal string), doubleValue or stringValue depending on the agent and the field. */
function num(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

/** `success` arrives as boolValue from Codex and as the string "true"/"false" from Claude Code. */
function bool(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
}

function compact(data: Attrs): Attrs {
  const out: Attrs = {};
  for (const [key, value] of Object.entries(data)) if (value !== undefined) out[key] = value;
  return out;
}

function derive(event: CanonicalEvent, discriminator = ""): Derived {
  return { event, discriminator };
}

function parseJsonObject(value: unknown): Attrs | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Attrs) : undefined;
  } catch {
    return undefined; // tool_input is truncated at ~4 KB by Claude Code, so unparseable JSON is expected and simply carries no path.
  }
}

function tsOf(record: LogRecord, now: number): number {
  const nanos = Number(record.timeUnixNano ?? 0) || Number(record.observedTimeUnixNano ?? 0);
  return nanos > 0 ? Math.floor(nanos / 1e6) : now;
}

function runtimeOf(name: string): "codex" | "claude-code" {
  return name.startsWith("codex.") ? "codex" : "claude-code";
}

function eventNameOf(record: LogRecord, attrs: Attrs, serviceHint: string): string | undefined {
  const candidates = [record.eventName, attrs["event.name"], decode(record.body)].filter((v): v is string => typeof v === "string" && v.length > 0);
  const prefixed = candidates.find((n) => n.startsWith("claude_code.") || n.startsWith("codex."));
  if (prefixed) return prefixed;
  const bare = candidates[0];
  if (!bare) return undefined;
  return serviceHint.includes("codex") ? `codex.${bare}` : `claude_code.${bare}`;
}

function promptText(attrs: Attrs): string | undefined {
  const text = str(attrs.prompt) ?? str(attrs.prompt_text);
  return text === "<REDACTED>" ? undefined : text;
}

/**
 * Identifies the agent record an event was derived from:
 * `runtime|event.name|event.timestamp|event.sequence|session id|call or tool id|sha256(record JSON)`.
 * The record hash keeps two otherwise identical-looking records apart; the named parts keep the key stable
 * for the same record re-sent in a retried batch.
 */
function recordKeyOf(name: string, attrs: Attrs, record: LogRecord): string {
  const timestamp = str(attrs["event.timestamp"]) ?? String(record.timeUnixNano ?? record.observedTimeUnixNano ?? "");
  const sequence = attrs["event.sequence"] === undefined ? "" : String(attrs["event.sequence"]);
  const sessionId = str(attrs["session.id"]) ?? str(attrs["conversation.id"]) ?? "";
  const callId = str(attrs.tool_use_id) ?? str(attrs.call_id) ?? "";
  return [runtimeOf(name), name, timestamp, sequence, sessionId, callId, sha256Hex(JSON.stringify(record ?? null))].join("|");
}

/** sha256(recordKey|derivedKind|discriminator|index): unique per derived event, identical when the agent replays the record. */
function sourceKeyOf(recordKey: string, kind: string, discriminator: string, index: number): string {
  return sha256Hex(`${recordKey}|${kind}|${discriminator}|${index}`);
}

// Claude Code tool_result attributes (https://code.claude.com/docs/en/monitoring-usage.md, "Tool result event"):
// `tool_name`, `tool_use_id`, `success`, `duration_ms`, `tool_input_size_bytes`, `tool_result_size_bytes`, and with
// OTEL_LOG_TOOL_DETAILS=1 `tool_parameters` (JSON string: Bash `bash_command`/`full_command`, MCP `mcp_server_name`/`mcp_tool_name`,
// Skill `skill_name`) and `tool_input` (JSON-serialized arguments, e.g. Read `file_path`).
function claudeSkillReads(attrs: Attrs, ref: SessionRef, ts: number, extra: Partial<CanonicalEvent>): Derived[] {
  const toolName = str(attrs.tool_name);
  const params = parseJsonObject(attrs.tool_parameters) ?? {};
  const input = parseJsonObject(attrs.tool_input) ?? {};
  if (toolName === "Read") {
    const filePath = str(input.file_path) ?? str(params.file_path);
    const name = skillNameFromPath(filePath);
    return name ? [derive(makeEvent("native_skill", "otel", ref, ts, { ...extra, data: { name, via: "file_read", path: filePath, tool: "Read" } }), name)] : [];
  }
  if (toolName === "Bash") {
    const command = str(params.full_command) ?? str(params.bash_command) ?? str(input.command);
    return skillNamesInCommand(command).map((name) => derive(makeEvent("native_skill", "otel", ref, ts, { ...extra, data: { name, via: "file_read", tool: "Bash" } }), name));
  }
  return [];
}

function claudeToolResult(attrs: Attrs, ref: SessionRef, ts: number, turnKey: string | undefined): Derived[] {
  const toolName = str(attrs.tool_name);
  const params = parseJsonObject(attrs.tool_parameters) ?? {};
  const input = parseJsonObject(attrs.tool_input) ?? {};
  const mcpServer = str(attrs.mcp_server_name) ?? str(params.mcp_server_name) ?? "";
  const gisoolMcp = mcpServer.toLowerCase() === "gisool" || isGisoolCall(toolName, input) || isGisoolCall(toolName, params);
  const toolUseId = str(attrs.tool_use_id);
  const extra: Partial<CanonicalEvent> = { ...(toolUseId ? { toolUseId } : {}), ...(turnKey ? { turnKey } : {}) };
  // The arguments go in `text` so applyCapture, redaction and retention treat them exactly like prompt content.
  const args = str(attrs.tool_input) ?? str(attrs.tool_parameters);
  const call = makeEvent("tool_call", "otel", ref, ts, {
    ...extra,
    ...(args !== undefined ? { text: args } : {}),
    data: compact({
      toolName: toolName ?? "unknown", success: bool(attrs.success), durationMs: num(attrs.duration_ms), toolUseId,
      inputBytes: num(attrs.tool_input_size_bytes), resultBytes: num(attrs.tool_result_size_bytes), ...(gisoolMcp ? { gisoolMcp: true } : {}),
    }),
  });
  // A gisool MCP call is recorded in full by the MCP recorder (search/load/read_file); this row is only the
  // Claude-side view of that tool run and derives no skill reads of its own.
  if (gisoolMcp) return [derive(call)];
  return [derive(call), ...claudeSkillReads(attrs, ref, ts, extra)];
}

function isGisoolCall(toolName: string | undefined, args: Attrs): boolean {
  return (toolName?.startsWith("mcp__gisool__") ?? false) || str(args.server)?.toLowerCase() === "gisool";
}

function claudeRecord(name: string, attrs: Attrs, ts: number): Derived[] | "ignored" | "unknown" {
  const ref: SessionRef = { runtime: "claude-code", runtimeSessionId: str(attrs["session.id"]) };
  const turnKey = str(attrs["prompt.id"]);
  const turn = turnKey ? { turnKey } : {};
  switch (name) {
    case "claude_code.user_prompt": {
      const text = promptText(attrs);
      const promptLength = typeof attrs.prompt_length === "number" ? attrs.prompt_length : undefined;
      const data: Attrs = { promptId: turnKey };
      if (text === undefined) Object.assign(data, { promptUnavailable: true, promptLength });
      return [derive(makeEvent("prompt", "otel", ref, ts, { ...turn, ...(text !== undefined ? { text } : {}), data }))];
    }
    case "claude_code.api_request":
      return [derive(makeEvent("llm_call", "otel", ref, ts, {
        ...turn,
        data: compact({
          model: str(attrs.model), inputTokens: num(attrs.input_tokens), outputTokens: num(attrs.output_tokens),
          cacheReadTokens: num(attrs.cache_read_tokens), cacheCreationTokens: num(attrs.cache_creation_tokens),
          // Claude reports input_tokens without the cached ones, so the buckets add up; Codex reports them included.
          inputIncludesCache: false, costUsd: num(attrs.cost_usd), durationMs: num(attrs.duration_ms), ttftMs: num(attrs.ttft_ms),
          requestId: str(attrs.request_id), skillName: str(attrs["skill.name"]),
        }),
      }))];
    case "claude_code.skill_activated": {
      const skill = str(attrs["skill.name"]);
      if (!skill) return "ignored";
      return [derive(makeEvent("native_skill", "otel", ref, ts, {
        ...turn, data: { name: skill, via: "otel", trigger: str(attrs.invocation_trigger), source: str(attrs["skill.source"]) },
      }), skill)];
    }
    case "claude_code.tool_result":
      return claudeToolResult(attrs, ref, ts, turnKey);
    default:
      return "unknown";
  }
}

function codexRecord(name: string, attrs: Attrs, ts: number): Derived[] | "ignored" | "unknown" {
  const ref: SessionRef = { runtime: "codex", conversationId: str(attrs["conversation.id"]) };
  const turnKey = str(attrs["turn.id"]) ?? str(attrs.turn_id);
  const turn = turnKey ? { turnKey } : {};
  switch (name) {
    case "codex.user_prompt": {
      const text = promptText(attrs);
      return [derive(makeEvent("prompt", "otel", ref, ts, { ...turn, ...(text !== undefined ? { text } : { data: { promptUnavailable: true } }) }))];
    }
    case "codex.sse_event": {
      // Only the completion event carries the turn's usage; every other SSE kind is noise for gisool.
      if (str(attrs["event.kind"]) !== "response.completed") return "ignored";
      return [derive(makeEvent("llm_call", "otel", ref, ts, {
        ...turn,
        data: compact({
          model: str(attrs.model), inputTokens: num(attrs.input_token_count), outputTokens: num(attrs.output_token_count),
          cacheReadTokens: num(attrs.cached_token_count), cacheWriteTokens: num(attrs.cache_write_token_count),
          reasoningTokens: num(attrs.reasoning_token_count), totalTokens: num(attrs.tool_token_count),
          // Codex counts cached tokens inside input_token_count (non-cached = input - cached).
          inputIncludesCache: true, ttftMs: num(attrs.ttft_ms),
        }),
      }))];
    }
    case "codex.tool_result": {
      const callId = str(attrs.call_id);
      const args = str(attrs.arguments);
      const toolName = str(attrs.tool_name);
      const gisoolMcp = isGisoolCall(toolName, parseJsonObject(args) ?? {})
        || str(attrs.mcp_server_name)?.toLowerCase() === "gisool";
      return [derive(makeEvent("tool_call", "otel", ref, ts, {
        ...turn, ...(callId ? { callId } : {}), ...(args !== undefined ? { text: args } : {}),
        data: compact({ toolName: toolName ?? "unknown", success: bool(attrs.success), durationMs: num(attrs.duration_ms),
          ...(gisoolMcp ? { gisoolMcp: true } : {}) }),
      }))];
    }
    case "codex.skill_invocation": {
      const skill = str(attrs["skill.name"]);
      if (!skill) return "ignored";
      return [derive(makeEvent("native_skill", "otel", ref, ts, {
        ...turn, data: { name: skill, via: "otel", scope: str(attrs["skill.scope"]), invocationType: str(attrs["skill.invocation_type"]) },
      }), skill)];
    }
    case "codex.conversation_starts":
      return [derive(makeEvent("session_start", "otel", ref, ts))];
    default:
      return "unknown";
  }
}

function mapRecord(name: string, attrs: Attrs, ts: number): Derived[] | "ignored" | "unknown" {
  if (IGNORED_NAMES.has(name) || IGNORED_PREFIXES.some((prefix) => name.startsWith(prefix))) return "ignored";
  if (name.startsWith("claude_code.")) return claudeRecord(name, attrs, ts);
  if (name.startsWith("codex.")) return codexRecord(name, attrs, ts);
  return "unknown";
}

function badOtlp(message: string): OtlpError {
  return { ok: false, status: 400, error: { code: "bad_otlp", message } };
}

/** Parses an OTLP/HTTP JSON logs export into CanonicalEvents; unknown event names are counted, not stored. */
export function parseOtlpLogs(body: unknown, now: number): OtlpResult {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return badOtlp("body must be an ExportLogsServiceRequest JSON object");
  const resourceLogs = (body as { resourceLogs?: unknown }).resourceLogs;
  if (!Array.isArray(resourceLogs)) return badOtlp("resourceLogs must be an array");
  const events: CanonicalEvent[] = [];
  let unknown = 0;
  let ignored = 0;
  for (const rl of resourceLogs as { resource?: { attributes?: KeyValue[] }; scopeLogs?: unknown }[]) {
    const resourceAttrs = toAttrs(rl?.resource?.attributes);
    const scopeLogs = Array.isArray(rl?.scopeLogs) ? (rl.scopeLogs as { scope?: { name?: string }; logRecords?: unknown }[]) : [];
    for (const sl of scopeLogs) {
      const serviceHint = `${String(resourceAttrs["service.name"] ?? "")} ${sl?.scope?.name ?? ""}`.toLowerCase();
      const records = Array.isArray(sl?.logRecords) ? (sl.logRecords as LogRecord[]) : [];
      for (const record of records) {
        const attrs = { ...resourceAttrs, ...toAttrs(record?.attributes) };
        const name = record ? eventNameOf(record, attrs, serviceHint) : undefined;
        const mapped = name ? mapRecord(name, attrs, tsOf(record, now)) : "unknown";
        if (mapped === "unknown") {
          unknown += 1;
          continue;
        }
        if (mapped === "ignored") {
          ignored += 1;
          continue;
        }
        const recordKey = recordKeyOf(name!, attrs, record);
        const spanId = str(record.spanId);
        const otelTraceId = str(record.traceId);
        const seen = new Map<string, number>();
        for (const { event, discriminator } of mapped) {
          const slot = `${event.kind}|${discriminator}`;
          const index = seen.get(slot) ?? 0;
          seen.set(slot, index + 1);
          event.sourceKey = sourceKeyOf(recordKey, event.kind, discriminator, index);
          // The log's own span context is what joins a Codex tool run to the execution span that carries its turn id.
          if (spanId) event.spanId = spanId;
          if (otelTraceId) event.data = { ...event.data, otelTraceId };
          events.push(event);
        }
      }
    }
  }
  return { ok: true, events, unknown, ignored, response: { partialSuccess: {} } };
}
