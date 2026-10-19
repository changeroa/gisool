import type { AssignedTreeEvent, Filter, RuntimeId, SessionTree, SkillSpan, Store, TreeEvent, TurnTree } from "../types.js";
import { flowTree, sessionTree } from "./tree.js";

/** "Used the skill?" per skill span, computed on read from reported events only; an unknown is `null`, never 0. */

/** The measurements a model call can report. A runtime that omits one measured nothing, which is never a zero. */
export const TOKEN_KEYS = ["inputTokens", "outputTokens", "cacheReadTokens", "cacheCreationTokens", "cacheWriteTokens",
  "reasoningTokens", "totalTokens"] as const;
export type UsageTokenKey = (typeof TOKEN_KEYS)[number];

/**
 * Token buckets stay separated by cache semantics: Claude reports input without the cached tokens, Codex includes them.
 * Each measurement sums the calls that reported it and stays null while none did; `unknownCalls` says how many of
 * `calls` reported nothing for it, so a partial sum is never read as a complete count. `totalTokens` is the
 * runtime-reported total, summed as reported and never derived from the other buckets.
 */
export type UsageTokens = {
  readonly inputIncludesCache: boolean; readonly calls: number;
  readonly inputTokens: number | null; readonly outputTokens: number | null; readonly cacheReadTokens: number | null;
  readonly cacheCreationTokens: number | null; readonly cacheWriteTokens: number | null; readonly reasoningTokens: number | null;
  readonly totalTokens: number | null;
  readonly unknownCalls: Readonly<Record<UsageTokenKey, number>>;
};

/** A read of the skill's own files: `reported` comes from gisool MCP, `heuristic` from a tool argument path. */
export type SupportingRead = {
  readonly eventId: string; readonly kind: "read_file" | "tool_call"; readonly uri: string | null;
  readonly label: "reported" | "heuristic";
};

export type CorrectionStatus = "correction" | "no_correction" | "unknown";
/** Word-list guess about the next user prompt; `unknown` whenever there is no next prompt or its text was not captured. */
export type UsageCorrection = {
  readonly status: CorrectionStatus; readonly label: "heuristic"; readonly matched: readonly string[];
  readonly reason: "no_next_prompt" | "text_not_captured" | null;
};

export type AttributionShare = {
  readonly reported: number; readonly single: number; readonly coActive: number; readonly total: number;
  // null when the span saw no tool or model call at all: there is no share to report, which is not a share of 0.
  readonly coActiveShare: number | null;
};

/**
 * What the `followThrough` calls were, never whether they helped. A Codex `exec` call runs model-written code that may only
 * dispatch the span's other tool calls or also do work of its own; nothing reported says which, so it stays unresolved and
 * `workExecutions` is null rather than a guess. `results` partitions `observations`: a call without a status is unknown.
 */
export type SpanActivity = {
  readonly version: 1;
  readonly observations: number;
  // Calls of a shell tool (exec_command, Bash, shell, local_shell): one command run each.
  readonly commands: number;
  readonly unresolvedExec: number;
  readonly results: { readonly success: number; readonly failure: number; readonly unknown: number };
  readonly workExecutions: number | null;
};

export type SkillSpanUsage = {
  readonly turnId: string; readonly spanId: string; readonly skill: string; readonly name: string; readonly uri: string | null;
  readonly activatedAt: number; readonly durationMs: number;
  // Tool calls after the activation, gisool MCP calls excluded; 0 means "loaded, no action". A call is not an outcome.
  readonly followThrough: number;
  readonly activity: SpanActivity;
  // gisool MCP calls (skill discovery and reading), reported apart from followThrough.
  readonly skillToolCalls: number;
  // Failed tool calls, gisool MCP calls included.
  readonly toolFailures: number;
  readonly supportingReads: readonly SupportingRead[];
  readonly llmCalls: number;
  // Sum of reported costs; null when the span has no model call or any of them reported no cost (Codex never does).
  readonly costUsd: number | null; readonly costUnknownCalls: number;
  readonly tokens: readonly UsageTokens[];
  readonly nextPromptCorrection: UsageCorrection;
  readonly attribution: AttributionShare;
};

export type SessionUsage = { readonly sessionId: string; readonly runtime: RuntimeId; readonly spans: readonly SkillSpanUsage[] };

export type SkillUsageAggregate = {
  readonly skill: string; readonly name: string; readonly uri: string | null;
  readonly spans: number; readonly spansWithoutFollowThrough: number;
  readonly followThrough: number; readonly skillToolCalls: number; readonly toolFailures: number;
  readonly supportingReads: number; readonly heuristicReads: number;
  readonly durationMs: number; readonly llmCalls: number;
  readonly costUsd: number | null; readonly costUnknownCalls: number;
  readonly tokens: readonly UsageTokens[];
  readonly corrections: { readonly correction: number; readonly no_correction: number; readonly unknown: number };
  readonly attribution: AttributionShare;
  // Summed over the skill's spans; workExecutions stays null while any span left one unresolved.
  readonly activity: SpanActivity;
};

export type FlowUsage = { readonly id: string; readonly sessions: readonly SessionUsage[]; readonly skills: readonly SkillUsageAggregate[] };
/** `skills` always covers every eligible session of the range; `truncated` reports a shortened `sessions` detail list. */
export type RangeUsage = { readonly from: number; readonly to: number; readonly sessionCount: number; readonly truncated: boolean;
  readonly sessions: readonly SessionUsage[]; readonly skills: readonly SkillUsageAggregate[] };

const KOREAN_CORRECTIONS = ["아니", "다시", "틀렸", "잘못", "그게 아니", "왜 안"] as const;
const ENGLISH_CORRECTIONS = ["no,", "wrong", "again", "that's not", "undo", "revert"] as const;

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** "again" must not fire inside "against"; "no," carries its own right-hand boundary. */
const ENGLISH_PATTERNS: readonly (readonly [string, RegExp])[] = ENGLISH_CORRECTIONS.map((token) => [
  token,
  new RegExp(`${/^[a-z0-9]/.test(token) ? "(?<![a-z0-9])" : ""}${escapeRegex(token)}${/[a-z0-9]$/.test(token) ? "(?![a-z0-9])" : ""}`, "i"),
]);

function numberOf(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringOf(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Case-insensitive word-list match; typographic apostrophes are folded so "that’s not" reads as "that's not". */
export function correctionMatches(text: string): string[] {
  const normalized = text.replace(/[\u2018\u2019]/g, "'").toLowerCase();
  const matched: string[] = [];
  for (const token of KOREAN_CORRECTIONS) if (normalized.includes(token)) matched.push(token);
  for (const [token, pattern] of ENGLISH_PATTERNS) if (pattern.test(normalized)) matched.push(token);
  return matched;
}

function correctionOf(next: TreeEvent | null): UsageCorrection {
  if (next === null) return { status: "unknown", label: "heuristic", matched: [], reason: "no_next_prompt" };
  // Capture level metadata (and a runtime that reports no prompt text) leaves nothing to match on.
  if (next.text === null) return { status: "unknown", label: "heuristic", matched: [], reason: "text_not_captured" };
  const matched = correctionMatches(next.text);
  return { status: matched.length > 0 ? "correction" : "no_correction", label: "heuristic", matched, reason: null };
}

/** The first prompt of a later turn in the same session; turns without a prompt event (Codex spans) are skipped. */
export function nextPromptAfterTurn(session: SessionTree, turnIndex: number): TreeEvent | null {
  for (let i = turnIndex + 1; i < session.turns.length; i += 1) {
    const prompt = session.turns[i]?.events.find((e) => e.kind === "prompt");
    if (prompt) return prompt;
  }
  return null;
}

function callTokens(data: Readonly<Record<string, unknown>>): UsageTokens {
  const measured = {} as Record<UsageTokenKey, number | null>;
  const unknownCalls = {} as Record<UsageTokenKey, number>;
  for (const key of TOKEN_KEYS) {
    const value = numberOf(data[key]);
    measured[key] = value ?? null;
    unknownCalls[key] = value === undefined ? 1 : 0;
  }
  return { inputIncludesCache: data.inputIncludesCache === true, calls: 1, ...measured, unknownCalls };
}

/** An unreported measurement adds nothing: the sum covers the calls that reported it, unknownCalls counts the rest. */
function sumTokens(a: UsageTokens, b: UsageTokens): UsageTokens {
  const measured = {} as Record<UsageTokenKey, number | null>;
  const unknownCalls = {} as Record<UsageTokenKey, number>;
  for (const key of TOKEN_KEYS) {
    const left = a[key];
    const right = b[key];
    measured[key] = left === null ? right : right === null ? left : left + right;
    unknownCalls[key] = a.unknownCalls[key] + b.unknownCalls[key];
  }
  return { inputIncludesCache: a.inputIncludesCache, calls: a.calls + b.calls, ...measured, unknownCalls };
}

function mergeTokens(into: Map<boolean, UsageTokens>, buckets: Iterable<UsageTokens>): void {
  for (const bucket of buckets) {
    const current = into.get(bucket.inputIncludesCache);
    into.set(bucket.inputIncludesCache, current ? sumTokens(current, bucket) : bucket);
  }
}

function sortedTokens(buckets: Map<boolean, UsageTokens>): UsageTokens[] {
  return [...buckets.values()].sort((a, b) => Number(a.inputIncludesCache) - Number(b.inputIncludesCache));
}

function skillDirHint(span: SkillSpan): string | null {
  const path = stringOf(span.activation.data.path);
  if (path === undefined) return null;
  const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return cut > 0 ? path.slice(0, cut) : null;
}

function readFileBelongsTo(event: AssignedTreeEvent, span: SkillSpan): boolean {
  const skillUri = event.skillUri ?? stringOf(event.data.skillUri) ?? null;
  if (skillUri === null) return false;
  if (span.uri !== null) return skillUri === span.uri;
  return skillUri.split("/").at(-2) === span.name;
}

const COMMAND_KEYS = new Set(["command", "full_command", "bash_command", "cmd", "argv", "script", "shell_command"]);

type ArgString = { readonly text: string; readonly command: boolean };

/**
 * The strings an argument blob can hold. A JSON value under a command key (and any text that is not JSON)
 * is a command line; every other JSON string is one path argument and keeps its spaces and quotes as data.
 */
function collectArgStrings(text: string): ArgString[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [{ text, command: true }];
  }
  const out: ArgString[] = [];
  const walk = (value: unknown, command: boolean): void => {
    if (typeof value === "string") out.push({ text: value, command });
    else if (Array.isArray(value)) for (const item of value) walk(item, command);
    else if (value !== null && typeof value === "object") {
      for (const [key, item] of Object.entries(value)) walk(item, command || COMMAND_KEYS.has(key));
    }
  };
  walk(parsed, false);
  return out.length > 0 ? out : [{ text, command: true }];
}

/**
 * Shell-like split of a command line: whitespace separates, single and double quotes group and are dropped.
 * A backslash escapes a separator, a quote or itself; anywhere else it stays, so `C:\skills\x` survives intact.
 */
function shellTokens(text: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let open = false;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]!;
    if (quote === null && /\s/.test(char)) {
      if (open) tokens.push(current);
      current = "";
      open = false;
      continue;
    }
    if (quote === null && (char === '"' || char === "'")) {
      quote = char;
      open = true;
      continue;
    }
    if (quote === char) {
      quote = null;
      continue;
    }
    const next = text[i + 1];
    if (char === "\\" && quote !== "'" && next !== undefined && (/\s/.test(next) || next === '"' || next === "'" || next === "\\")) {
      current += next;
      open = true;
      i += 1;
      continue;
    }
    current += char;
    open = true;
  }
  if (open) tokens.push(current);
  return tokens;
}

function normalizePath(path: string): string {
  return path.replace(/\\+/g, "/").replace(/\/+$/, "");
}

/**
 * Whole-token comparison, never a substring: `/skills/db-query` does not reference `/skills/db-query'backup`.
 * `insideOnly` drops the bare directory itself, which is what naming a directory on a command line is.
 */
function tokenReferencesDir(token: string, dir: string, insideOnly: boolean): boolean {
  const path = normalizePath(token);
  const target = normalizePath(dir);
  if (path === "" || target === "") return false;
  if (path.startsWith(`${target}/`)) return true;
  const rooted = target.startsWith("/") || /^[A-Za-z]:\//.test(target);
  if (!rooted && path.includes(`/${target}/`)) return true;
  if (insideOnly) return false;
  return path === target || (!rooted && path.endsWith(`/${target}`));
}

/**
 * Native skills leave no MCP trail, so a tool argument naming a file inside the skill directory is counted as a read.
 * The skill name stands in as a relative directory only while the activation reported no directory of its own.
 */
function argsReferenceSkillDir(event: AssignedTreeEvent, span: SkillSpan, dirHint: string | null): boolean {
  if (event.text === null) return false;
  const target = dirHint ?? span.name;
  for (const { text, command } of collectArgStrings(event.text)) {
    for (const token of command ? shellTokens(text) : [text]) {
      if (tokenReferencesDir(token, target, command)) return true;
    }
  }
  return false;
}

function supportingReadsOf(span: SkillSpan, turn: TurnTree): SupportingRead[] {
  const reads: SupportingRead[] = [];
  const start = turn.events.findIndex((e) => e.id === span.activation.id);
  // Row order, not timestamps, decides "after the activation": events can share a millisecond.
  for (const event of turn.events.slice(start < 0 ? turn.events.length : start + 1)) {
    if (event.kind === "read_file" && readFileBelongsTo(event, span)) {
      reads.push({ eventId: event.id, kind: "read_file", uri: event.skillUri ?? stringOf(event.data.uri) ?? null, label: "reported" });
    }
  }
  if (span.activation.kind !== "native_skill") return reads;
  const dirHint = skillDirHint(span);
  for (const event of span.events) {
    if (event.kind !== "tool_call" || event.data.gisoolMcp === true) continue;
    if (argsReferenceSkillDir(event, span, dirHint)) {
      reads.push({ eventId: event.id, kind: "tool_call", uri: null, label: "heuristic" });
    }
  }
  return reads;
}

const SHELL_TOOLS = new Set(["exec_command", "Bash", "shell", "local_shell"]);

/** Only Codex names its code-running wrapper `exec`; elsewhere the name carries no wrapper meaning. */
function activityKind(event: AssignedTreeEvent, runtime: RuntimeId): "command" | "unresolved_exec" | "other" {
  const toolName = stringOf(event.data.toolName);
  if (runtime === "codex" && toolName === "exec") return "unresolved_exec";
  return toolName !== undefined && SHELL_TOOLS.has(toolName) ? "command" : "other";
}

/** Usage of one skill span: `turn` supplies the events outside the span (MCP reads), `nextPrompt` the correction guess. */
export function spanUsage(span: SkillSpan, ctx: { turn: TurnTree; nextPrompt: TreeEvent | null; runtime: RuntimeId }): SkillSpanUsage {
  let followThrough = 0;
  let commands = 0;
  let unresolvedExec = 0;
  const results = { success: 0, failure: 0, unknown: 0 };
  let skillToolCalls = 0;
  let toolFailures = 0;
  let llmCalls = 0;
  let costSum = 0;
  let costUnknownCalls = 0;
  let reported = 0;
  let single = 0;
  let coActive = 0;
  const buckets = new Map<boolean, UsageTokens>();
  for (const event of span.events) {
    if (event.attribution === "reported") reported += 1;
    else if (event.attribution === "co_active") coActive += 1;
    else if (event.attribution === "single") single += 1;
    if (event.kind === "tool_call") {
      if (event.data.gisoolMcp === true) skillToolCalls += 1;
      else {
        followThrough += 1;
        const kind = activityKind(event, ctx.runtime);
        if (kind === "command") commands += 1;
        else if (kind === "unresolved_exec") unresolvedExec += 1;
        results[event.data.success === true ? "success" : event.data.success === false ? "failure" : "unknown"] += 1;
      }
      if (event.data.success === false) toolFailures += 1;
    }
    if (event.kind === "llm_call") {
      llmCalls += 1;
      const cost = numberOf(event.data.costUsd);
      if (cost === undefined) costUnknownCalls += 1;
      else costSum += cost;
      mergeTokens(buckets, [callTokens(event.data)]);
    }
  }
  const total = span.events.length;
  return {
    turnId: ctx.turn.id, spanId: span.id, skill: span.skill, name: span.name, uri: span.uri,
    activatedAt: span.startedAt, durationMs: Math.max(0, span.endedAt - span.startedAt),
    followThrough, activity: { version: 1, observations: followThrough, commands, unresolvedExec, results,
      workExecutions: unresolvedExec > 0 ? null : followThrough },
    skillToolCalls, toolFailures, supportingReads: supportingReadsOf(span, ctx.turn), llmCalls,
    costUsd: llmCalls > 0 && costUnknownCalls === 0 ? costSum : null, costUnknownCalls,
    tokens: sortedTokens(buckets), nextPromptCorrection: correctionOf(ctx.nextPrompt),
    attribution: { reported, single, coActive, total, coActiveShare: total > 0 ? coActive / total : null },
  };
}

export function sessionUsage(session: SessionTree): SessionUsage {
  const spans: SkillSpanUsage[] = [];
  session.turns.forEach((turn, index) => {
    const nextPrompt = nextPromptAfterTurn(session, index);
    for (const span of turn.skillSpans) spans.push(spanUsage(span, { turn, nextPrompt, runtime: session.runtime }));
  });
  return { sessionId: session.id, runtime: session.runtime, spans };
}

/** Per-skill totals across any set of spans. Cost stays null while a single contributing model call reported none. */
export function aggregateUsage(spans: Iterable<SkillSpanUsage>): SkillUsageAggregate[] {
  type Acc = {
    skill: string; name: string; uri: string | null; spans: number; spansWithoutFollowThrough: number;
    followThrough: number; skillToolCalls: number; toolFailures: number; supportingReads: number; heuristicReads: number;
    durationMs: number; llmCalls: number; costSum: number; costUnknownCalls: number; tokens: Map<boolean, UsageTokens>;
    corrections: { correction: number; no_correction: number; unknown: number };
    reported: number; single: number; coActive: number; total: number;
    commands: number; unresolvedExec: number; results: { success: number; failure: number; unknown: number };
    workExecutions: number | null;
  };
  const bySkill = new Map<string, Acc>();
  for (const usage of spans) {
    const acc = bySkill.get(usage.skill) ?? {
      skill: usage.skill, name: usage.name, uri: usage.uri, spans: 0, spansWithoutFollowThrough: 0,
      followThrough: 0, skillToolCalls: 0, toolFailures: 0, supportingReads: 0, heuristicReads: 0,
      durationMs: 0, llmCalls: 0, costSum: 0, costUnknownCalls: 0, tokens: new Map<boolean, UsageTokens>(),
      corrections: { correction: 0, no_correction: 0, unknown: 0 }, reported: 0, single: 0, coActive: 0, total: 0,
      commands: 0, unresolvedExec: 0, results: { success: 0, failure: 0, unknown: 0 }, workExecutions: 0,
    };
    acc.uri = acc.uri ?? usage.uri;
    acc.spans += 1;
    if (usage.followThrough === 0) acc.spansWithoutFollowThrough += 1;
    acc.followThrough += usage.followThrough;
    acc.skillToolCalls += usage.skillToolCalls;
    acc.toolFailures += usage.toolFailures;
    acc.supportingReads += usage.supportingReads.length;
    acc.heuristicReads += usage.supportingReads.filter((r) => r.label === "heuristic").length;
    acc.durationMs += usage.durationMs;
    acc.llmCalls += usage.llmCalls;
    acc.costSum += usage.costUsd ?? 0;
    acc.costUnknownCalls += usage.costUnknownCalls;
    mergeTokens(acc.tokens, usage.tokens);
    acc.corrections[usage.nextPromptCorrection.status] += 1;
    acc.reported += usage.attribution.reported;
    acc.single += usage.attribution.single;
    acc.coActive += usage.attribution.coActive;
    acc.total += usage.attribution.total;
    acc.commands += usage.activity.commands;
    acc.unresolvedExec += usage.activity.unresolvedExec;
    acc.results.success += usage.activity.results.success;
    acc.results.failure += usage.activity.results.failure;
    acc.results.unknown += usage.activity.results.unknown;
    acc.workExecutions = acc.workExecutions === null || usage.activity.workExecutions === null ? null
      : acc.workExecutions + usage.activity.workExecutions;
    bySkill.set(usage.skill, acc);
  }
  return [...bySkill.values()]
    .map((acc) => ({
      skill: acc.skill, name: acc.name, uri: acc.uri, spans: acc.spans, spansWithoutFollowThrough: acc.spansWithoutFollowThrough,
      followThrough: acc.followThrough, skillToolCalls: acc.skillToolCalls, toolFailures: acc.toolFailures,
      supportingReads: acc.supportingReads, heuristicReads: acc.heuristicReads, durationMs: acc.durationMs,
      llmCalls: acc.llmCalls, costUsd: acc.llmCalls > 0 && acc.costUnknownCalls === 0 ? acc.costSum : null,
      costUnknownCalls: acc.costUnknownCalls, tokens: sortedTokens(acc.tokens), corrections: acc.corrections,
      attribution: { reported: acc.reported, single: acc.single, coActive: acc.coActive, total: acc.total,
        coActiveShare: acc.total > 0 ? acc.coActive / acc.total : null },
      activity: { version: 1 as const, observations: acc.followThrough, commands: acc.commands, unresolvedExec: acc.unresolvedExec,
        results: acc.results, workExecutions: acc.workExecutions },
    }))
    .sort((a, b) => a.skill.localeCompare(b.skill));
}

/** Usage of every session linked to one flow (or to the herdr workspace acting as one). */
export function flowUsage(store: Pick<Store, "treeSessionData" | "treeFlowData" | "flowEventScope">, flowOrWorkspaceId: string): FlowUsage | undefined {
  const flow = flowTree(store, flowOrWorkspaceId);
  if (!flow) return undefined;
  const sessions: SessionUsage[] = [];
  for (const tab of flow.tabs) {
    for (const pane of tab.panes) {
      for (const link of pane.sessions) {
        if (link.session === null || sessions.some((s) => s.sessionId === link.session?.id)) continue;
        sessions.push(sessionUsage(link.session));
      }
    }
  }
  return { id: flow.id, sessions, skills: aggregateUsage(sessions.flatMap((s) => s.spans)) };
}

/**
 * Usage of the sessions in a time range. Every eligible session is analysed and aggregated; an optional
 * `detailLimit` shortens only the per-session list and then says so through `truncated` and `sessionCount`.
 */
export function rangeUsage(store: Pick<Store, "treeSessionData" | "sessions">,
  opts: { from: number; to: number; detailLimit?: number; automated?: Filter["automated"] }): RangeUsage {
  const filter: Filter = { from: opts.from, to: opts.to, ...(opts.automated !== undefined ? { automated: opts.automated } : {}) };
  const detailLimit = opts.detailLimit === undefined ? undefined : Math.max(0, Math.floor(opts.detailLimit));
  const sessions: SessionUsage[] = [];
  const spans: SkillSpanUsage[] = [];
  let sessionCount = 0;
  for (const row of store.sessions(filter)) {
    const tree = sessionTree(store, row.id);
    if (!tree) continue;
    const usage = sessionUsage(tree);
    sessionCount += 1;
    spans.push(...usage.spans);
    if (detailLimit === undefined || sessions.length < detailLimit) sessions.push(usage);
  }
  return { from: opts.from, to: opts.to, sessionCount, truncated: sessions.length < sessionCount, sessions,
    skills: aggregateUsage(spans) };
}
