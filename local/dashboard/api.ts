import type { Attribution, AutomatedMode, Filter, FlowDto, FlowListDto, FlowReportDto, HeatmapDto, SessionRow, SessionSkillReportDto,
  SkillEntry, SkillWeekDto, Store, TraceStep } from "../src/types.js";
import { matchesFilter, serializeFilter } from "./state";

export type Stats = ReturnType<Store["stats"]>;
/** The API may attach the attribution reason for unattributed rows; SessionRow itself does not carry it. */
export type SessionListRow = SessionRow & { attributionReason?: NonNullable<Attribution["reason"]> };
export type LiveState = "connecting" | "live" | "offline" | "fixtures";
export type EvalCaseInput = { query: string; expectedUri?: string; fromTraceId?: string };
/** GET /api/flows takes its own range and page size, not the full session Filter. */
export type FlowsQuery = { from?: number; to?: number; limit?: number; automated?: AutomatedMode };
export const FLOWS_PAGE_LIMIT = 20;
export type EventHandlers = { onSession?: (row: SessionListRow) => void; onState?: (state: LiveState) => void };

export type Api = {
  mode: "http" | "fixtures";
  sessions(filter: Filter): Promise<SessionListRow[]>;
  trace(sessionId: string): Promise<TraceStep[]>;
  flow(filter: Filter, opts?: { unit?: FlowDto["unit"]; top?: number }): Promise<FlowDto>;
  /** Registered herdr flows plus the workspaces without one, newest first. */
  flows(query?: FlowsQuery): Promise<FlowListDto>;
  /** One flow: tree, per-turn finding, per-span usage and the spec comparison. `ws:<id>` addresses a workspace. */
  flowReport(id: string, opts?: FlowsQuery): Promise<FlowReportDto>;
  /** The same finding and usage analysis for one session; rejects with 404 on a daemon that predates it. */
  skillReport(sessionId: string, opts?: { automated?: AutomatedMode }): Promise<SessionSkillReportDto>;
  heatmap(filter: Filter, opts?: { tz?: string; weekStart?: 0 | 1; bucket?: 1 | 2 | 4 }): Promise<HeatmapDto>;
  skillWeek(filter: Filter): Promise<SkillWeekDto>;
  /** The filter limits only the unattributed counts (time range and runtime); the other figures stay global. */
  stats(filter?: Filter): Promise<Stats>;
  skills(): Promise<SkillEntry[]>;
  addEvalCase(input: EvalCaseInput): Promise<void>;
  health(): Promise<{ ok: boolean; version: string }>;
  events(handlers: EventHandlers): () => void;
};

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = "ApiError";
  }
}

function withQuery(path: string, filter: Filter, extra: Record<string, string | number | undefined> = {}): string {
  const parts = [serializeFilter(filter)];
  for (const [key, value] of Object.entries(extra)) {
    if (value !== undefined && value !== "") parts.push(`${key}=${encodeURIComponent(String(value))}`);
  }
  const query = parts.filter(Boolean).join("&");
  return query ? `${path}?${query}` : path;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { credentials: "same-origin", ...init, headers: { Accept: "application/json", ...(init?.headers ?? {}) } });
  if (!res.ok) {
    let code = `http_${res.status}`;
    let message = `${init?.method ?? "GET"} ${path} failed with ${res.status}`;
    try {
      const body = (await res.json()) as { error?: string; message?: string };
      if (body.error) code = body.error;
      if (body.message) message = body.message;
    } catch {
      /* non-JSON error body: keep the status-based message */
    }
    if (res.status === 401) message = "this browser is not signed in to the dashboard. Run `gisool open` in a terminal to open it with a sign-in link.";
    throw new ApiError(res.status, code, message);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

const httpApi: Api = {
  mode: "http",
  sessions: (filter) => request(withQuery("/api/sessions", filter)),
  trace: (sessionId) => request(`/api/sessions/${encodeURIComponent(sessionId)}/trace`),
  flow: (filter, opts = {}) => request(withQuery("/api/flow", filter, { unit: opts.unit, top: opts.top })),
  flows: (query = {}) => request(withQuery("/api/flows", {}, { from: query.from, to: query.to, limit: query.limit, automated: query.automated })),
  flowReport: (id, opts = {}) => request(withQuery(`/api/flows/${encodeURIComponent(id)}`, {}, {
    automated: opts.automated, from: opts.from, to: opts.to, limit: opts.limit,
  })),
  skillReport: (sessionId, opts = {}) =>
    request(withQuery(`/api/sessions/${encodeURIComponent(sessionId)}/skill-report`, {}, { automated: opts.automated })),
  heatmap: (filter, opts = {}) => request(withQuery("/api/heatmap", filter, { tz: opts.tz, weekStart: opts.weekStart, bucket: opts.bucket })),
  skillWeek: (filter) => request(withQuery("/api/skill-week", filter)),
  stats: (filter = {}) => request(withQuery("/api/stats", filter)),
  skills: () => request("/api/skills"),
  addEvalCase: (input) => request("/api/eval-cases", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) }),
  health: () => request("/healthz"),
  events({ onSession, onState }) {
    onState?.("connecting");
    const source = new EventSource("/api/events/stream");
    source.addEventListener("session", (event) => {
      try {
        onSession?.(JSON.parse((event as MessageEvent<string>).data) as SessionListRow);
      } catch {
        /* a malformed frame is dropped; the next frame still arrives */
      }
    });
    source.onopen = () => onState?.("live");
    source.onerror = () => onState?.(source.readyState === EventSource.CLOSED ? "offline" : "connecting");
    return () => source.close();
  },
};

type FixtureData = {
  stats: Stats;
  statsEmpty: Stats;
  skills: SkillEntry[];
  sessions: SessionListRow[];
  sessions12: string[];
  traces: Record<string, TraceStep[]>;
  flow: FlowDto;
  flow12: FlowDto;
  heatmap: HeatmapDto;
  heatmap12: HeatmapDto;
  skillWeek: SkillWeekDto;
  skillWeek12: SkillWeekDto;
};

/** Usage figures (unattributed counts, null attribution rates) live in their own lazily loaded file and override `stats`. */
type UsageFixtureData = { stats: Partial<Stats>; statsEmpty: Partial<Stats> };

export type FixtureVariant = "full" | "twelve" | "empty";

export function fixtureVariant(search: string = typeof location === "undefined" ? "" : location.search): FixtureVariant | undefined {
  const value = new URLSearchParams(search).get("fixtures");
  if (value === null) return undefined;
  if (value === "12") return "twelve";
  if (value === "0" || value === "empty" || value === "none") return "empty";
  return "full";
}

function fixtureApi(variant: FixtureVariant): Api {
  // Loaded on first call so the 43 kB fixture JSON stays out of the default bundle (esbuild splits it into its own chunk).
  let loaded: Promise<FixtureData> | undefined;
  const load = (): Promise<FixtureData> => (loaded ??= import("./dev-fixtures.json").then((m) => m.default as unknown as FixtureData));
  const settle = async <T>(compute: (data: FixtureData) => T): Promise<T> => compute(await load());
  let usage: Promise<UsageFixtureData> | undefined;
  const loadUsage = (): Promise<UsageFixtureData> => (usage ??= import("./dev-fixtures-usage.json").then((m) => m.default as unknown as UsageFixtureData));
  const rowsOf = (data: FixtureData): SessionListRow[] => {
    const twelve = new Set(data.sessions12);
    return variant === "empty" ? [] : variant === "twelve" ? data.sessions.filter((row) => twelve.has(row.id)) : data.sessions;
  };
  return {
    mode: "fixtures",
    sessions: (filter) => settle((data) => rowsOf(data).filter((row) => matchesFilter(row, filter))),
    trace: (sessionId) => settle((data) => data.traces[sessionId] ?? []),
    // The fixture file carries no herdr topology, so the flow APIs answer like a daemon that has never seen herdr.
    flows: (query = {}) =>
      Promise.resolve({
        generatedAt: Date.now(), from: query.from ?? null, to: query.to ?? null, limit: query.limit ?? FLOWS_PAGE_LIMIT,
        automated: query.automated ?? "exclude", flows: [], nextCursor: null,
      }),
    flowReport: (id) => Promise.reject(new ApiError(404, "flow_not_found", `no flow or herdr workspace ${id}`)),
    skillReport: (sessionId) => Promise.reject(new ApiError(404, "session_not_found", `no session ${sessionId}`)),
    flow: (_filter, opts = {}) =>
      settle((data) => {
        const dto = variant === "twelve" ? data.flow12 : data.flow;
        return variant === "empty" ? { ...dto, nodes: [], links: [], sessionCount: 0, unit: opts.unit ?? dto.unit } : { ...dto, unit: opts.unit ?? dto.unit };
      }),
    heatmap: () =>
      settle((data) => {
        const dto = variant === "twelve" ? data.heatmap12 : data.heatmap;
        return variant === "empty" ? { ...dto, cells: [], rowTotals: dto.rowTotals.map(() => 0), colTotals: dto.colTotals.map(() => 0) } : dto;
      }),
    skillWeek: () => settle((data) => (variant === "empty" ? { ...data.skillWeek, rows: [] } : variant === "twelve" ? data.skillWeek12 : data.skillWeek)),
    stats: async () => {
      const [data, extra] = await Promise.all([load(), loadUsage()]);
      return variant === "empty" ? { ...data.statsEmpty, ...extra.statsEmpty } : { ...data.stats, ...extra.stats };
    },
    skills: () => settle((data) => data.skills),
    addEvalCase: () => Promise.resolve(),
    health: () => Promise.resolve({ ok: true, version: "fixtures" }),
    events({ onState }) {
      onState?.("fixtures");
      return () => undefined;
    },
  };
}

const variant = fixtureVariant();
export const api: Api = variant ? fixtureApi(variant) : httpApi;
