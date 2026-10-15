import type { AssignedTreeEvent, Filter, RuntimeId, SessionTree, SkillSpan, Store, TreeEvent, TurnTree } from "../types.js";
import { flowTree, sessionTree } from "./tree.js";

/** "Used the skill?" per skill span, computed on read from reported events only; an unknown is `null`, never 0. */

/** Token buckets stay separated by cache semantics: Claude reports input without the cached tokens, Codex includes them. */
export type UsageTokens = {
  readonly inputIncludesCache: boolean; readonly calls: number;
  readonly inputTokens: number; readonly outputTokens: number; readonly cacheReadTokens: number;
  readonly cacheCreationTokens: number; readonly cacheWriteTokens: number; readonly reasoningTokens: number;
  // Runtime-reported total, summed as reported; never derived from the other buckets.
  readonly totalTokens: number;
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

export type SkillSpanUsage = {
  readonly turnId: string; readonly spanId: string; readonly skill: string; readonly name: string; readonly uri: string | null;
  readonly activatedAt: number; readonly durationMs: number;
  // Tool calls after the activation, gisool MCP calls excluded; 0 means "loaded, no action".
  readonly followThrough: number;
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
  const bucket = (key: string): number => numberOf(data[key]) ?? 0;
  return { inputIncludesCache: data.inputIncludesCache === true, calls: 1,
    inputTokens: bucket("inputTokens"), outputTokens: bucket("outputTokens"), cacheReadTokens: bucket("cacheReadTokens"),
    cacheCreationTokens: bucket("cacheCreationTokens"), cacheWriteTokens: bucket("cacheWriteTokens"),
    reasoningTokens: bucket("reasoningTokens"), totalTokens: bucket("totalTokens") };
}

function sumTokens(a: UsageTokens, b: UsageTokens): UsageTokens {
  return { inputIncludesCache: a.inputIncludesCache, calls: a.calls + b.calls,
    inputTokens: a.inputTokens + b.inputTokens, outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens, cacheCreationTokens: a.cacheCreationTokens + b.cacheCreationTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens, reasoningTokens: a.reasoningTokens + b.reasoningTokens,
    totalTokens: a.totalTokens + b.totalTokens };
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

const PATH_CHAR = /[A-Za-z0-9._-]/;

function normalizeSeparators(path: string): string {
  return path.replace(/\\+/g, "/");
}

/** A directory matches only on a path-segment boundary, so `/skills/db-query` never swallows `/skills/db-query-backup`. */
function referencesDirectory(haystack: string, dir: string): boolean {
  for (let at = haystack.indexOf(dir); at >= 0; at = haystack.indexOf(dir, at + 1)) {
    const before = haystack[at - 1];
    const after = haystack[at + dir.length];
    if ((before === undefined || !PATH_CHAR.test(before)) && (after === undefined || !PATH_CHAR.test(after))) return true;
  }
  return false;
}

/** Native skills leave no MCP trail, so a tool argument naming a file inside the skill directory is counted as a read. */
function argsReferenceSkillDir(event: AssignedTreeEvent, span: SkillSpan, dirHint: string | null): boolean {
  if (event.text === null) return false;
  const haystack = normalizeSeparators(event.text);
  if (dirHint !== null && referencesDirectory(haystack, normalizeSeparators(dirHint))) return true;
  return haystack.includes(`/${span.name}/`);
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

/** Usage of one skill span: `turn` supplies the events outside the span (MCP reads), `nextPrompt` the correction guess. */
export function spanUsage(span: SkillSpan, ctx: { turn: TurnTree; nextPrompt: TreeEvent | null }): SkillSpanUsage {
  let followThrough = 0;
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
      else followThrough += 1;
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
    followThrough, skillToolCalls, toolFailures, supportingReads: supportingReadsOf(span, ctx.turn), llmCalls,
    costUsd: llmCalls > 0 && costUnknownCalls === 0 ? costSum : null, costUnknownCalls,
    tokens: sortedTokens(buckets), nextPromptCorrection: correctionOf(ctx.nextPrompt),
    attribution: { reported, single, coActive, total, coActiveShare: total > 0 ? coActive / total : null },
  };
}

export function sessionUsage(session: SessionTree): SessionUsage {
  const spans: SkillSpanUsage[] = [];
  session.turns.forEach((turn, index) => {
    const nextPrompt = nextPromptAfterTurn(session, index);
    for (const span of turn.skillSpans) spans.push(spanUsage(span, { turn, nextPrompt }));
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
  };
  const bySkill = new Map<string, Acc>();
  for (const usage of spans) {
    const acc = bySkill.get(usage.skill) ?? {
      skill: usage.skill, name: usage.name, uri: usage.uri, spans: 0, spansWithoutFollowThrough: 0,
      followThrough: 0, skillToolCalls: 0, toolFailures: 0, supportingReads: 0, heuristicReads: 0,
      durationMs: 0, llmCalls: 0, costSum: 0, costUnknownCalls: 0, tokens: new Map<boolean, UsageTokens>(),
      corrections: { correction: 0, no_correction: 0, unknown: 0 }, reported: 0, single: 0, coActive: 0, total: 0,
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
    }))
    .sort((a, b) => a.skill.localeCompare(b.skill));
}

/** Usage of every session linked to one flow (or to the herdr workspace acting as one). */
export function flowUsage(store: Pick<Store, "treeSessionData" | "treeFlowData">, flowOrWorkspaceId: string): FlowUsage | undefined {
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
