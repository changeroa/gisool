import type { CanonicalEvent, SessionRef } from "../types.js";
import { makeEvent, skillNameFromPath, skillNamesInCommand, str } from "./hooks.js";

// OTLP/HTTP JSON ExportLogsServiceRequest decoding per https://opentelemetry.io/docs/specs/otlp/
// (lowerCamelCase fields, int64 as decimal strings, AnyValue as a one-of object).
type AnyValue = {
  stringValue?: string; boolValue?: boolean; intValue?: string | number; doubleValue?: number;
  arrayValue?: { values?: AnyValue[] }; kvlistValue?: { values?: KeyValue[] }; bytesValue?: string;
};
type KeyValue = { key: string; value?: AnyValue };
type LogRecord = { timeUnixNano?: string | number; observedTimeUnixNano?: string | number; eventName?: string; body?: AnyValue; attributes?: KeyValue[] };
type Attrs = Record<string, unknown>;

export type OtlpOk = { ok: true; events: CanonicalEvent[]; unknown: number; ignored: number; response: { partialSuccess: Record<string, never> } };
export type OtlpError = { ok: false; status: 400; error: { code: "bad_otlp"; message: string } };
export type OtlpResult = OtlpOk | OtlpError;

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

// Claude Code tool_result attributes (https://code.claude.com/docs/en/monitoring-usage.md, "Tool result event"):
// `tool_name`, `tool_use_id`, and with OTEL_LOG_TOOL_DETAILS=1 `tool_parameters` (JSON string: Bash `bash_command`/`full_command`,
// MCP `mcp_server_name`/`mcp_tool_name`, Skill `skill_name`) and `tool_input` (JSON-serialized arguments, e.g. Read `file_path`).
function claudeToolResult(attrs: Attrs, ref: SessionRef, ts: number): CanonicalEvent[] | "ignored" {
  const toolName = str(attrs.tool_name);
  const params = parseJsonObject(attrs.tool_parameters) ?? {};
  const input = parseJsonObject(attrs.tool_input) ?? {};
  const mcpServer = str(attrs.mcp_server_name) ?? str(params.mcp_server_name) ?? "";
  if (mcpServer.toLowerCase().includes("gisool") || toolName?.startsWith("mcp__gisool__")) return "ignored";
  const toolUseId = str(attrs.tool_use_id);
  const extra = toolUseId ? { toolUseId } : {};
  if (toolName === "Read") {
    const filePath = str(input.file_path) ?? str(params.file_path);
    const name = skillNameFromPath(filePath);
    return name ? [makeEvent("native_skill", "otel", ref, ts, { ...extra, data: { name, via: "file_read", path: filePath, tool: "Read" } })] : [];
  }
  if (toolName === "Bash") {
    const command = str(params.full_command) ?? str(params.bash_command) ?? str(input.command);
    return skillNamesInCommand(command).map((name) => makeEvent("native_skill", "otel", ref, ts, { ...extra, data: { name, via: "file_read", tool: "Bash" } }));
  }
  return [];
}

function mapRecord(name: string, attrs: Attrs, ts: number): CanonicalEvent[] | "ignored" | "unknown" {
  if (name.startsWith("claude_code.")) {
    const ref: SessionRef = { runtime: "claude-code", runtimeSessionId: str(attrs["session.id"]) };
    switch (name) {
      case "claude_code.user_prompt": {
        const text = promptText(attrs);
        const promptLength = typeof attrs.prompt_length === "number" ? attrs.prompt_length : undefined;
        const data: Attrs = { promptId: str(attrs["prompt.id"]) };
        if (text === undefined) Object.assign(data, { promptUnavailable: true, promptLength });
        return [makeEvent("prompt", "otel", ref, ts, { ...(text !== undefined ? { text } : {}), data })];
      }
      case "claude_code.skill_activated": {
        const skill = str(attrs["skill.name"]);
        if (!skill) return "ignored";
        return [makeEvent("native_skill", "otel", ref, ts, { data: { name: skill, via: "otel", trigger: str(attrs.invocation_trigger), source: str(attrs["skill.source"]) } })];
      }
      case "claude_code.tool_result":
        return claudeToolResult(attrs, ref, ts);
      default:
        return "unknown";
    }
  }
  if (name.startsWith("codex.")) {
    const ref: SessionRef = { runtime: "codex", conversationId: str(attrs["conversation.id"]) };
    switch (name) {
      case "codex.user_prompt": {
        const text = promptText(attrs);
        return [makeEvent("prompt", "otel", ref, ts, text !== undefined ? { text } : { data: { promptUnavailable: true } })];
      }
      case "codex.skill_invocation": {
        const skill = str(attrs["skill.name"]);
        if (!skill) return "ignored";
        return [makeEvent("native_skill", "otel", ref, ts, { data: { name: skill, via: "otel", scope: str(attrs["skill.scope"]), invocationType: str(attrs["skill.invocation_type"]) } })];
      }
      case "codex.conversation_starts":
        return [makeEvent("session_start", "otel", ref, ts)];
      default:
        return "unknown";
    }
  }
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
        if (mapped === "unknown") unknown += 1;
        else if (mapped === "ignored") ignored += 1;
        else events.push(...mapped);
      }
    }
  }
  return { ok: true, events, unknown, ignored, response: { partialSuccess: {} } };
}
