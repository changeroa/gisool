import { randomUUID } from "node:crypto";
import type { CanonicalEvent, EventKind, HookPayload, RuntimeId, SessionRef } from "../types.js";

export type ToolUseBinding = { toolUseId: string; ref: SessionRef };
export type HookResult = { events: CanonicalEvent[]; bindings: ToolUseBinding[] };

type Raw = Record<string, unknown>;

const SKILL_FILE_IN_PATH = /[\\/]([^\\/]+)[\\/]SKILL\.md$/;
const SKILL_FILE_IN_COMMAND = /[\\/]([^\\/\s'"`]+)[\\/]SKILL\.md(?![\w.])/g;

export function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function obj(value: unknown): Raw | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Raw) : undefined;
}

export function skillNameFromPath(path: string | undefined): string | undefined {
  return path ? SKILL_FILE_IN_PATH.exec(path)?.[1] : undefined;
}

export function skillNamesInCommand(command: string | undefined): string[] {
  if (!command) return [];
  const names = new Set<string>();
  for (const match of command.matchAll(SKILL_FILE_IN_COMMAND)) names.add(match[1]!);
  return [...names];
}

function commandText(value: unknown): string | undefined {
  if (Array.isArray(value)) return value.filter((v) => typeof v === "string").join(" ");
  return str(value);
}

export function makeEvent(kind: EventKind, source: CanonicalEvent["source"], ref: SessionRef, ts: number, extra: Partial<CanonicalEvent> = {}): CanonicalEvent {
  return { id: randomUUID(), ts, kind, source, ref, data: {}, ...extra };
}

function promptEvent(ref: SessionRef, ts: number, prompt: unknown, data: Raw = {}): CanonicalEvent {
  const text = typeof prompt === "string" ? prompt : undefined;
  return makeEvent("prompt", "hook", ref, ts, text === undefined ? { data: { ...data, promptUnavailable: true } } : { text, data });
}

function nativeSkill(ref: SessionRef, ts: number, name: string, via: "tool" | "file_read" | "expansion", extra: Partial<CanonicalEvent> = {}, data: Raw = {}): CanonicalEvent {
  return makeEvent("native_skill", "hook", ref, ts, { ...extra, data: { ...data, name, via } });
}

function fileReadSkills(ref: SessionRef, ts: number, toolName: string | undefined, input: Raw | undefined, toolUseId?: string): CanonicalEvent[] {
  const extra = toolUseId ? { toolUseId } : {};
  if (toolName === "Read") {
    const filePath = str(input?.file_path);
    const name = skillNameFromPath(filePath);
    return name ? [nativeSkill(ref, ts, name, "file_read", extra, { path: filePath, tool: "Read" })] : [];
  }
  if (toolName === "Bash" || toolName === "shell" || toolName === "local_shell") {
    return skillNamesInCommand(commandText(input?.command)).map((name) => nativeSkill(ref, ts, name, "file_read", extra, { tool: toolName }));
  }
  return [];
}

function claudeCode(p: Raw, ts: number): HookResult {
  const ref: SessionRef = { runtime: "claude-code", runtimeSessionId: str(p.session_id), cwd: str(p.cwd) };
  const events: CanonicalEvent[] = [];
  const bindings: ToolUseBinding[] = [];
  switch (p.hook_event_name) {
    case "UserPromptSubmit":
      events.push(promptEvent(ref, ts, p.prompt, str(p.prompt_id) ? { promptId: p.prompt_id } : {}));
      break;
    case "SessionStart":
      events.push(makeEvent("session_start", "hook", ref, ts, { data: { source: p.source } }));
      break;
    case "SessionEnd":
      events.push(makeEvent("session_end", "hook", ref, ts, { data: { reason: p.reason } }));
      break;
    case "UserPromptExpansion": {
      const name = str(p.command_name);
      if (name && p.expansion_type === "slash_command") events.push(nativeSkill(ref, ts, name, "expansion", {}, { commandSource: p.command_source }));
      break;
    }
    case "PostToolUse": {
      const toolName = str(p.tool_name);
      const input = obj(p.tool_input);
      const toolUseId = str(p.tool_use_id);
      if (toolName?.startsWith("mcp__gisool__")) {
        if (toolUseId && ref.runtimeSessionId) bindings.push({ toolUseId, ref });
      } else if (toolName === "Skill") {
        const name = str(input?.skill) ?? str(input?.skill_name) ?? str(input?.name);
        if (name) events.push(nativeSkill(ref, ts, name, "tool", toolUseId ? { toolUseId } : {}));
      } else {
        events.push(...fileReadSkills(ref, ts, toolName, input, toolUseId));
      }
      break;
    }
  }
  return { events, bindings };
}

function codex(p: Raw, ts: number): HookResult {
  const ref: SessionRef = { runtime: "codex", runtimeSessionId: str(p.session_id), cwd: str(p.cwd) };
  const events: CanonicalEvent[] = [];
  if (p.hook_event_name === "UserPromptSubmit") events.push(promptEvent(ref, ts, p.prompt, str(p.turn_id) ? { turnId: p.turn_id } : {}));
  else if (p.hook_event_name === "PostToolUse" && p.tool_name === "Bash") events.push(...fileReadSkills(ref, ts, "Bash", obj(p.tool_input)));
  else if (p.hook_event_name === "SessionStart") events.push(makeEvent("session_start", "hook", ref, ts));
  return { events, bindings: [] };
}

function gemini(p: Raw, ts: number): HookResult {
  const ref: SessionRef = { runtime: "gemini", runtimeSessionId: str(p.session_id), cwd: str(p.cwd) };
  const events: CanonicalEvent[] = [];
  switch (p.hook_event_name) {
    case "BeforeAgent":
      events.push(promptEvent(ref, ts, p.prompt));
      break;
    case "AfterTool": {
      const input = obj(p.tool_input);
      const name = p.tool_name === "activate_skill" ? str(input?.name) ?? str(input?.skill) : undefined;
      if (name) events.push(nativeSkill(ref, ts, name, "tool"));
      break;
    }
    case "SessionStart":
      events.push(makeEvent("session_start", "hook", ref, ts));
      break;
    case "SessionEnd":
      events.push(makeEvent("session_end", "hook", ref, ts));
      break;
  }
  return { events, bindings: [] };
}

function cursor(p: Raw, ts: number): HookResult {
  const roots = Array.isArray(p.workspace_roots) ? p.workspace_roots : [];
  const ref: SessionRef = { runtime: "cursor", conversationId: str(p.conversation_id), cwd: str(roots[0]) ?? str(p.cwd) };
  const events: CanonicalEvent[] = [];
  if (p.hook_event_name === "beforeSubmitPrompt") events.push(promptEvent(ref, ts, p.prompt, str(p.generation_id) ? { generationId: p.generation_id } : {}));
  else if (p.hook_event_name === "sessionStart") events.push(makeEvent("session_start", "hook", ref, ts));
  else if (p.hook_event_name === "sessionEnd") events.push(makeEvent("session_end", "hook", ref, ts));
  return { events, bindings: [] };
}

function piForwarder(runtime: "omo" | "gajae", p: Raw, ts: number): HookResult {
  if (p.event !== "before_agent_start") return { events: [], bindings: [] };
  const ref: SessionRef = { runtime, runtimeSessionId: str(p.sessionId), cwd: str(p.cwd) };
  return { events: [promptEvent(ref, ts, p.prompt)], bindings: [] };
}

function openclaw(p: Raw, ts: number): HookResult {
  if (p.event !== "before_agent_run" && p.event !== "message_received") return { events: [], bindings: [] };
  const sessionKey = str(p.sessionKey);
  const ref: SessionRef = { runtime: "openclaw", runtimeSessionId: str(p.sessionId) ?? sessionKey };
  return { events: [promptEvent(ref, ts, p.prompt, { hook: p.event, ...(sessionKey ? { sessionKey } : {}) })], bindings: [] };
}

/** Normalizes one raw hook payload; unrecognized events yield no events (the pipeline counts them as dropped). */
export function normalizeHook(runtime: RuntimeId, payload: HookPayload, now: number): HookResult {
  const p = payload as Raw;
  switch (runtime) {
    case "claude-code":
      return claudeCode(p, now);
    case "codex":
      return codex(p, now);
    case "gemini":
      return gemini(p, now);
    case "cursor":
      return cursor(p, now);
    case "omo":
    case "gajae":
      return piForwarder(runtime, p, now);
    case "openclaw":
      return openclaw(p, now);
    case "unknown":
      return { events: [], bindings: [] };
  }
}
