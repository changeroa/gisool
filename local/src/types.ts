import type { FlowUsage, SessionUsage, SkillUsageAggregate } from "./analysis/usage.js";
import type { FlowComparison } from "./workflow/compare.js";
import type { WorkflowSpec } from "./workflow/spec.js";

export type SkillUri = string;   // "skill://local/<rootId>/<dir>/SKILL.md"
export type RuntimeId = "claude-code" | "codex" | "gemini" | "cursor" | "omo" | "gajae" | "openclaw" | "unknown";
export type CaptureLevel = "metadata" | "redacted" | "full";      // default "full"
export type SkillEntry = { uri: SkillUri; rootId: string; dir: string; name: string; description: string;
  tags: string[]; whenToUse?: string; examples: string[]; aliasesKo: string[]; group?: { id: string; stage?: string };
  invocation: "automatic" | "explicit"; bodyHead: string; digest: string; manifestDigest: string;
  resources: { uri: SkillUri; digest: string; size: number }[]; mtimeMs: number;
  // SKILL.md YAML frontmatter as JSON, verbatim (SEP-2640 skills/list and skills/get carry it unchanged)
  frontmatter?: Record<string, unknown> };
export type CatalogDelta = { added: SkillEntry[]; changed: SkillEntry[]; removed: SkillUri[] };
export interface Catalog { list(): SkillEntry[]; get(uri: SkillUri): SkillEntry | undefined;
  readResource(uri: SkillUri): Promise<{ text: string; digest: string; size: number; bytes: Uint8Array }>;
  refresh(): Promise<CatalogDelta>; onDelta(cb: (d: CatalogDelta) => void): () => void;
  report(): { duplicates: { name: string; uris: SkillUri[] }[]; families: { id: string; uris: SkillUri[] }[]; roots: { id: string; path: string; readable: boolean; count: number }[] } }
export type Candidate = { uri: SkillUri; name: string; description: string; score: number; rank: number;
  invocation: "automatic" | "explicit"; digest: string; matched: string[] };
export type AbstainReason = "empty_query" | "no_overlap" | "below_threshold" | "explicit_only";
export type SearchMode = "discovery" | "automatic" | "explicit";
export type SearchOutcome = { traceId: string; query: string; mode: SearchMode; candidates: Candidate[];
  abstained?: { reason: AbstainReason; hint: string }; elapsedMs: number };
export interface SearchIndex { rebuild(entries: SkillEntry[]): void; apply(delta: CatalogDelta): void;
  search(query: string, opts: { mode: SearchMode; limit: number }): SearchOutcome }
export type EventKind = "session_start" | "prompt" | "search" | "load" | "read_file" | "native_skill" | "llm_call" | "tool_call" | "session_end" | "error";
export type SessionRef = { runtime: RuntimeId; runtimeSessionId?: string; conversationId?: string; clientName?: string; cwd?: string };
// session upsert key = (runtime, runtimeSessionId ?? conversationId); Codex MCP _meta.threadId maps to conversationId
export type SearchEventData = { query: string; mode: SearchMode; candidates: Candidate[]; abstained?: { reason: AbstainReason; hint: string }; elapsedMs: number; total: number };
export type TraceStepDetail =
  | { kind: "prompt"; text?: string; textLength?: number }
  | ({ kind: "search"; traceId: string; chosen: SkillUri[] } & SearchEventData)
  | { kind: "load"; uri: SkillUri; loadId: string; manifestDigest: string }
  | { kind: "read_file"; skillUri: SkillUri; uri: SkillUri; bytes: number }
  | { kind: "native_skill"; name: string; via: "tool" | "otel" | "file_read" | "expansion" }
  // inputIncludesCache says whether cacheReadTokens are already part of inputTokens (Codex) or not (Claude Code);
  // costUsd is absent when the runtime reports no cost, which is never the same as 0.
  | { kind: "llm_call"; model?: string; inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheCreationTokens?: number;
      cacheWriteTokens?: number; reasoningTokens?: number; totalTokens?: number; inputIncludesCache: boolean; costUsd?: number; durationMs?: number;
      ttftMs?: number; requestId?: string }
  | { kind: "tool_call"; toolName: string; success?: boolean; durationMs?: number; toolUseId?: string; callId?: string; inputBytes?: number;
      resultBytes?: number; gisoolMcp?: boolean; args?: string; argsLength?: number }
  | { kind: "session_start" | "session_end" }
  | { kind: "error"; code: string; message: string };
export type HookPayload =
  | { event: "before_agent_start"; prompt: string | null; sessionId?: string; cwd?: string; promptUnavailable?: boolean }   // omo, gajae forwarders
  | { event: "before_agent_run" | "message_received"; prompt: string | null; sessionKey?: string; sessionId?: string }   // openclaw forwarder
  | Record<string, unknown>;                                                                                                  // raw hook stdin JSON (claude-code, codex, gemini, cursor)
export type CanonicalEvent = { id: string; ts: number; kind: EventKind; source: "mcp" | "otel" | "hook";
  ref: SessionRef; traceId?: string; loadId?: string; skillUri?: SkillUri; toolUseId?: string; text?: string; textDigest?: string;
  textLength?: number;
  // sourceKey identifies the agent record this event was derived from, so a replayed batch stores nothing new;
  // turnKey, callId and spanId join the event to its turn, tool call and OTel span.
  sourceKey?: string; turnKey?: string; callId?: string; spanId?: string;
  data: Record<string, unknown> };
export type Attribution = { sessionId: string | "unattributed"; method: "runtime_id" | "vendor_meta" | "trace_handle" | "window" | "none";
  reason?: "no_session" | "ambiguous" | "stale" };
export type AdoptionState = "loaded" | "exposed_only" | "no_match" | "aborted" | "not_used";
export type Filter = { from?: number; to?: number; runtime?: RuntimeId[]; skill?: SkillUri[]; state?: AdoptionState[]; dow?: number; hour?: number; hourSpan?: number; q?: string;
  // automated sessions (first prompt sent by a harness or the runtime, see store/automation.ts) are excluded unless "include" or "only"
  automated?: "include" | "only" };
// dow: 0-6 with 0 = Sunday (JS getDay semantics, in the requested tz); hour: start hour 0-23; hourSpan: number of hours from `hour` (default 1; a 2 h bucket click sends hourSpan 2; shift-click ranges send the union span)
export type SessionRow = { id: string; runtime: RuntimeId; startedAt: number; endedAt?: number; firstPrompt?: string; skills: SkillUri[]; state: AdoptionState; attribution: Attribution["method"];
  automated?: string };
export type TraceStep = { ts: number; kind: EventKind; summary: string; detail: Record<string, unknown> };
export type FlowDto = { unit: "first_load" | "all_loads"; columns: ["task_type", "skill", "state"];
  nodes: { id: string; column: 0 | 1 | 2; label: string; count: number; other?: boolean }[];
  links: { source: string; target: string; count: number; state: AdoptionState }[]; sessionCount: number };
export type HeatmapDto = { tz: string; weekStart: 0 | 1; bucketHours: 1 | 2 | 4; cells: { dow: number; hour: number; count: number }[]; rowTotals: number[]; colTotals: number[] };
export type SkillWeekDto = { weeks: string[]; rows: { uri: SkillUri; name: string; counts: number[] }[] };
export interface Store {
  // Returns false when the row was already stored (same id or source_key) and nothing was written.
  append(event: CanonicalEvent, attribution: Attribution): boolean;
  // True when an event derived from that agent record is already stored, so a replay can be dropped before anything mutates.
  hasSourceKey(sourceKey: string): boolean;
  openSessions(runtime: RuntimeId, since: number): { id: string; startedAt: number; lastActivityAt: number; ref: SessionRef }[];
  reattribute(eventId: string, sessionId: string, method: Attribution["method"]): void;
  findEventByToolUseId(toolUseId: string): string | undefined;
  upsertSession(ref: SessionRef, startedAt: number): string;
  putLoad(load: { loadId: string; traceId?: string; uri: SkillUri; manifestDigest: string; resources: SkillEntry["resources"] }): void;
  getLoad(loadId: string): { uri: SkillUri; manifestDigest: string; resources: SkillEntry["resources"] } | undefined;
  latestLoad(uri: SkillUri): string | undefined;
  traceSession(traceId: string): string | undefined;
  upsertSkills(entries: SkillEntry[]): void; markRemoved(uris: SkillUri[]): void;
  sessions(f: Filter): SessionRow[]; trace(sessionId: string): TraceStep[];
  flow(f: Filter, unit: "first_load" | "all_loads", top?: number): FlowDto; heatmap(f: Filter, tz: string, weekStart: 0 | 1, bucketHours: 1 | 2 | 4): HeatmapDto; skillWeek(f: Filter): SkillWeekDto;
  // attributionRate is null for a runtime with no MCP events (no data), distinct from 0 (MCP events, none attributed).
  // unattributed counts MCP search/load events with no matched session, limited by f.from/f.to/f.runtime.
  stats(f?: Filter): { attributionRate: Record<RuntimeId, number | null>; abstainRate: number; unusedSkills: SkillUri[]; lastEventTs?: number;
    lastEventByRuntime: Partial<Record<RuntimeId, number>>; ingest: { accepted: number; rejected: number; dropped: number; lastError?: { ts: number; code: string } };
    unattributed?: { searches: number; loads: number }; automatedSessions?: number };
  countIngest(kind: "accepted" | "rejected" | "dropped", code?: string): void;
  addEvalCase(c: { query: string; expectedUri?: SkillUri; fromTraceId?: string }): void; evalCases(): { query: string; expectedUri?: SkillUri }[];
  exportTo(dir: string, opts: { withHistory: boolean }): void; importFrom(dir: string, opts: { merge: boolean }): { added: number; skipped: number };
  retention(days: number): number;
  // Stores the spans the traces ingest kept (INSERT OR IGNORE) and records the batch with the ingest counters inside the
  // same transaction: one `accepted` per new row, `dropped` for the spans the join filter rejected. Returns new rows.
  putSpans(spans: OtelSpanRow[], dropped?: number): number;
  // Workflow specs, flows and step mappings registered by an orchestrator through /api.
  putWorkflowSpec(spec: WorkflowSpec): { row: WorkflowSpecRow; created: boolean };
  workflowSpecs(): WorkflowSpecRow[];
  workflowSpecVersions(name: string): WorkflowSpecRow[];
  workflowSpec(name: string, version?: number): WorkflowSpecRow | undefined;
  createFlow(input: { workspaceId: string; tabId?: string; specId: string; label?: string }): { created: true; flow: FlowRow } | { created: false; conflict: FlowRow };
  getFlow(id: string): FlowRow | undefined;
  flowSteps(flowId: string): FlowStepRow[];
  mapFlowStep(flowId: string, paneId: string, stepId: string): { created: boolean };
  endFlow(flowId: string): { endedMs: number; alreadyEnded: boolean } | undefined;
  // excludeSessions leaves those sessions out of the pane usage, so a filtered report compares against what it shows.
  flowPaneUsage(flowId: string, opts?: { excludeSessions?: readonly string[] }): PaneUsageRow[];
  // Every session flowPaneUsage can read for this flow, so a caller can filter that population before comparing.
  flowSessionIds(flowId: string): string[];
  // Read-API list: registered flows plus the herdr workspaces that have none, newest first, one page at a time.
  listFlows(q: FlowListQuery): FlowListRow[];
  // Automation id per session id for the ids given, automated sessions only (rules in store/automation.ts).
  sessionAutomation(ids: readonly string[]): Record<string, string>;
  close(): void;
  treeSessionData(sessionId: string): TreeSessionData | undefined;
  treeFlowData(flowOrWorkspaceId: string): TreeFlowData | undefined;
  outsideHerdrSessionIds(opts: { from: number; to: number; limit: number }): string[] }
// One row of otel_spans: the whole whitelist the traces ingest may store. No other span attribute is kept.
export type OtelSpanRow = { traceId: string; spanId: string; parentSpanId?: string; name: string; runtime: RuntimeId;
  conversationId?: string; turnKey?: string; callId?: string; startMs?: number; endMs?: number; receivedAt: number };
export type WorkflowSpecRow = { id: string; name: string; version: number; digest: string; createdMs: number; spec: WorkflowSpec };
export type FlowRow = { id: string; workspaceId: string; tabId?: string; label?: string; registeredMs: number; endedMs?: number; spec?: WorkflowSpecRow };
export type FlowStepRow = { paneId: string; stepId: string; registeredMs: number };
// Skills and tools the sessions linked to one pane showed within one flow (window rule in store/workflow.ts).
export type PaneUsageRow = { paneId: string; skills: string[]; tools: string[] };
export type GisoolConfig = { port: number; captureLevel: CaptureLevel; retentionDays: number | null;
  roots: { id: string; path: string }[]; runtimes: Partial<Record<RuntimeId, { enabled: boolean }>> };
export type PackPlanFile = { path: string; before: string | null; after: string; mode: number };
export type PackPlan = { files: PackPlanFile[]; commands: { argv: string[]; env?: Record<string, string>; description: string; undo?: { argv: string[]; description: string } }[];
  notes: string[]; conflicts: { path: string; code: string; detail: string }[] };
export type PackCtx = { home: string; env: NodeJS.ProcessEnv; port: number; token: string; nodePath: string; packageRoot: string; disableRemote: boolean };
export interface RuntimePack { id: RuntimeId; detect(ctx: { home: string; env: NodeJS.ProcessEnv }): Promise<{ installed: boolean; evidence: string[]; remoteGisulRegistered: boolean }>;
  plan(ctx: PackCtx): Promise<PackPlan>;
  doctorChecks(ctx: { home: string; env: NodeJS.ProcessEnv; port: number }): Promise<{ name: string; ok: boolean; detail: string }[]> }
// nodePath = realpath(process.execPath) captured at init; packageRoot = realpath of the installed local/ package; every planned command uses absolute paths
export type CliDeps = { config: GisoolConfig; home: string; gisoolHome: string; env: NodeJS.ProcessEnv; openStore(): Store };
export type ExportImportApi = { runExport(dir: string, opts: { withHistory: boolean }, deps: CliDeps): Promise<number>;
  runImport(dir: string, opts: { dryRun: boolean }, deps: CliDeps): Promise<number> };

export type TurnBasis = "reported" | "span_join" | "inferred_time";
export type TreeEvent = { readonly id: string; readonly ts: number; readonly kind: EventKind; readonly source: CanonicalEvent["source"];
  readonly turnKey: string | null; readonly callId: string | null; readonly spanId: string | null;
  readonly skillUri: string | null; readonly text: string | null; readonly textLength: number | null;
  readonly data: Readonly<Record<string, unknown>> };
export type TreeSessionData = { readonly id: string; readonly runtime: RuntimeId; readonly startedAt: number; readonly endedAt: number | null;
  readonly events: readonly TreeEvent[]; readonly spans: readonly OtelSpanRow[] };
export type AssignedTreeEvent = TreeEvent & { readonly basis: TurnBasis; readonly attribution: "reported" | "single" | "co_active" | "no_skill";
  readonly skills: readonly string[] };
export type SkillSpan = { readonly id: string; readonly skill: string; readonly uri: string | null; readonly name: string;
  readonly startedAt: number; readonly endedAt: number; readonly activation: AssignedTreeEvent; readonly events: readonly AssignedTreeEvent[] };
export type TurnTree = { readonly id: string; readonly startedAt: number; readonly endedAt: number; readonly basis: TurnBasis;
  readonly events: readonly AssignedTreeEvent[]; readonly skillSpans: readonly SkillSpan[] };
export type SessionTree = { readonly id: string; readonly runtime: RuntimeId; readonly startedAt: number; readonly endedAt: number | null;
  readonly turns: readonly TurnTree[]; readonly unassignedEvents: readonly TreeEvent[] };
export type TreeTopologyNode = { readonly id: string; readonly label: string | null; readonly createdMs: number | null; readonly closedMs: number | null };
export type TreePaneLink = { readonly paneId: string; readonly sessionId: string | null; readonly agentSessionValue: string;
  readonly source: string | null; readonly firstSeenMs: number | null; readonly lastSeenMs: number | null };
export type TreeFlowData = { readonly id: string; readonly workspaceId: string; readonly label: string | null; readonly registered: boolean;
  readonly tabs: readonly TreeTopologyNode[]; readonly panes: readonly (TreeTopologyNode & { readonly tabId: string })[];
  readonly links: readonly TreePaneLink[] };
export type FlowTree = { readonly id: string; readonly workspaceId: string; readonly label: string | null; readonly registered: boolean;
  readonly tabs: readonly (TreeTopologyNode & { readonly panes: readonly (TreeTopologyNode & {
    readonly sessions: readonly (TreePaneLink & { readonly basis: "reported" | "inferred"; readonly session: SessionTree | null })[] })[] })[] };

// "Found the skill?" analysis (analysis/finding.ts): descriptive labels over recorded search, load and native-skill events.
// They say where a used skill came from; none of them claims the skill was the right one.
export type FindingLabel = "found_top1" | "found_lower" | "loaded_outside_results" | "native_without_search" | "searched_none_used" | "no_search";
// rank collapses candidates that are identical copies (same SKILL.md digest) into one rank; rawRank is the rank the search reported.
export type FindingCandidate = { readonly uri: SkillUri; readonly name: string; readonly rank: number; readonly rawRank: number; readonly copies: number };
// One skill a turn put to work: a gisool load ("load") or a native skill activation ("native", whose uri is unknown unless reported).
// rankInSearch is the collapsed rank in the latest search before that use, null when no search preceded it or it was not among the candidates.
export type FindingUsedSkill = { readonly uri: SkillUri | null; readonly name: string; readonly via: "load" | "native"; readonly ts: number;
  readonly rankInSearch: number | null };
// A skill a LATER turn of the same session used while this turn searched without surfacing it.
export type FindingMiss = { readonly uri: SkillUri | null; readonly name: string; readonly via: "load" | "native"; readonly turnId: string; readonly ts: number };
export type FindingAbstention = { readonly reason: AbstainReason; readonly hint: string };
// abstained is true when ANY search of the turn abstained; abstentions lists every one of them in search order, so a
// retry that succeeds does not hide the search that surfaced nothing.
export type TurnFinding = { readonly turnId: string; readonly searched: boolean; readonly queries: readonly string[];
  readonly candidates: readonly FindingCandidate[]; readonly loadedSkills: readonly FindingUsedSkill[];
  readonly abstained: boolean; readonly abstentions: readonly FindingAbstention[];
  readonly nativeWithoutSearch: boolean; readonly missedLater: readonly FindingMiss[]; readonly label: FindingLabel };
// meanRank averages rankInSearch over the used skills that carry one; null when none did, which is never the same as 0.
// abstainedSearches counts searches, abstainedTurns counts turns holding at least one of them.
export type FindingAggregate = { readonly turns: number; readonly labels: Readonly<Record<FindingLabel, number>>;
  readonly meanRank: number | null; readonly abstainedSearches: number; readonly abstainedTurns: number };
export type SessionFinding = { readonly sessionId: string; readonly turns: readonly TurnFinding[]; readonly aggregate: FindingAggregate };
export type FlowFinding = { readonly id: string; readonly sessions: readonly SessionFinding[]; readonly aggregate: FindingAggregate };
// Resolves the SKILL.md digest of a skill a turn used, so a load of an identical copy under another uri is recognised.
export type SkillDigestLookup = (used: { readonly uri: SkillUri | null; readonly loadId: string | null }) => string | undefined;

// --- Read APIs (api/flows.ts) ------------------------------------------------------------------------------
// Which sessions a response counted: "exclude" (the default) leaves out the sessions store/automation.ts classifies
// as machine-driven, "include" keeps them, "only" keeps nothing else. Every response says which one it used.
export type AutomatedMode = "exclude" | "include" | "only";
export type FlowSpecRef = { readonly id: string; readonly name: string; readonly version: number };
// One entry of the flows list as the store reads it: a registered flow, or a herdr workspace with no registered flow,
// which acts as an implicit flow. orderMs is the sort and cursor key (registration, else workspace creation, 0 when
// neither was reported); startedMs reports that unknown as null instead.
export type FlowListRow = { readonly id: string; readonly kind: "flow" | "workspace"; readonly workspaceId: string;
  readonly tabId: string | null; readonly label: string | null; readonly orderMs: number;
  readonly startedMs: number | null; readonly endedMs: number | null; readonly spec: FlowSpecRef | null;
  readonly paneIds: readonly string[];
  readonly links: readonly { readonly paneId: string; readonly sessionId: string | null; readonly source: string | null }[] };
// A page of the flows list: newest first, at most `limit` rows, starting after `cursor` when one is given.
export type FlowListQuery = { readonly from?: number; readonly to?: number; readonly limit: number;
  readonly cursor?: { readonly orderMs: number; readonly id: string } };
// id addresses the entry in GET /api/flows/:id: a registered flow by its own id, an implicit workspace as "ws:<id>".
// attribution counts the pane-to-session links behind `sessionIds`: herdr reported them, gisool inferred them from
// cwd and time, or the pane has an agent session gisool has not matched to a session yet (unlinked).
export type FlowListEntry = { readonly id: string; readonly kind: "flow" | "workspace"; readonly workspaceId: string;
  readonly tabId: string | null; readonly label: string | null; readonly registered: boolean;
  readonly spec: FlowSpecRef | null; readonly startedMs: number | null; readonly endedMs: number | null;
  readonly paneIds: readonly string[]; readonly sessionIds: readonly string[];
  readonly counts: { readonly panes: number; readonly sessions: number };
  readonly attribution: { readonly reported: number; readonly inferred: number; readonly unlinked: number } };
export type FlowListDto = { readonly generatedAt: number; readonly from: number | null; readonly to: number | null;
  readonly limit: number; readonly automated: AutomatedMode; readonly flows: readonly FlowListEntry[];
  // The cursor that returns the next page, or null when this page ended the list.
  readonly nextCursor: string | null };
// The API name of TurnFinding.loadedSkills: a turn's skill uses, each one a gisool load or a native activation
// (via "native"), so a natively used skill is never reported as a loaded one.
export type TurnFindingDto = Omit<TurnFinding, "loadedSkills"> & { readonly usedSkills: readonly FindingUsedSkill[] };
export type SessionFindingDto = { readonly sessionId: string; readonly turns: readonly TurnFindingDto[]; readonly aggregate: FindingAggregate };
export type FlowFindingDto = { readonly id: string; readonly sessions: readonly SessionFindingDto[]; readonly aggregate: FindingAggregate };
// A session the automated filter left out of a flow report, with the automation rule that classified it.
export type ExcludedSession = { readonly sessionId: string; readonly reason: string };
// GET /api/flows/:id. `flow` is null for an implicit workspace (nothing was registered, so there is no registration
// time); `comparison` is null unless a flow with a spec is registered.
export type FlowReportDto = { readonly generatedAt: number; readonly id: string; readonly kind: "flow" | "workspace";
  readonly workspaceId: string; readonly label: string | null; readonly registered: boolean;
  readonly flow: { readonly registeredMs: number | null; readonly endedMs: number | null; readonly tabId: string | null } | null;
  readonly spec: FlowSpecRef | null; readonly automated: AutomatedMode; readonly tree: FlowTree;
  readonly finding: FlowFindingDto; readonly usage: FlowUsage; readonly comparison: FlowComparison | null;
  readonly excludedSessions: readonly ExcludedSession[] };
// GET /api/sessions/:id/skill-report. `automated` carries the automation rule id when a harness drove the session.
export type SessionSkillReportDto = { readonly generatedAt: number; readonly sessionId: string; readonly runtime: RuntimeId;
  readonly startedAt: number; readonly endedAt: number | null; readonly automated: string | null;
  readonly tree: SessionTree; readonly finding: SessionFindingDto; readonly usage: SessionUsage };
// GET /api/skills/usage. `skills` covers every session of the range; `sessions` is the detail list `detailLimit`
// bounds, and `truncated` says it was shortened.
export type SkillsUsageDto = { readonly generatedAt: number; readonly from: number; readonly to: number;
  readonly automated: AutomatedMode; readonly detailLimit: number; readonly sessionCount: number;
  readonly truncated: boolean; readonly skills: readonly SkillUsageAggregate[]; readonly sessions: readonly SessionUsage[] };
