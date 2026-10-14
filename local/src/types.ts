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
  readResource(uri: SkillUri): Promise<{ text: string; digest: string; size: number }>;
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
export type EventKind = "session_start" | "prompt" | "search" | "load" | "read_file" | "native_skill" | "session_end" | "error";
export type SessionRef = { runtime: RuntimeId; runtimeSessionId?: string; conversationId?: string; clientName?: string; cwd?: string };
// session upsert key = (runtime, runtimeSessionId ?? conversationId); Codex MCP _meta.threadId maps to conversationId
export type SearchEventData = { query: string; mode: SearchMode; candidates: Candidate[]; abstained?: { reason: AbstainReason; hint: string }; elapsedMs: number; total: number };
export type TraceStepDetail =
  | { kind: "prompt"; text?: string; textLength?: number }
  | ({ kind: "search"; traceId: string; chosen: SkillUri[] } & SearchEventData)
  | { kind: "load"; uri: SkillUri; loadId: string; manifestDigest: string }
  | { kind: "read_file"; skillUri: SkillUri; uri: SkillUri; bytes: number }
  | { kind: "native_skill"; name: string; via: "tool" | "otel" | "file_read" | "expansion" }
  | { kind: "session_start" | "session_end" }
  | { kind: "error"; code: string; message: string };
export type HookPayload =
  | { event: "before_agent_start"; prompt: string | null; sessionId?: string; cwd?: string; promptUnavailable?: boolean }   // omo, gajae forwarders
  | { event: "before_agent_run" | "message_received"; prompt: string | null; sessionKey?: string; sessionId?: string }   // openclaw forwarder
  | Record<string, unknown>;                                                                                                  // raw hook stdin JSON (claude-code, codex, gemini, cursor)
export type CanonicalEvent = { id: string; ts: number; kind: EventKind; source: "mcp" | "otel" | "hook";
  ref: SessionRef; traceId?: string; loadId?: string; skillUri?: SkillUri; toolUseId?: string; text?: string; textDigest?: string;
  textLength?: number; data: Record<string, unknown> };
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
  append(event: CanonicalEvent, attribution: Attribution): void;
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
  retention(days: number): number; close(): void }
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
