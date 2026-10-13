import type { Attribution, Filter, FlowDto, HeatmapDto, SessionRow, SkillEntry, SkillWeekDto, Store, TraceStep } from "../src/types.js";
import fixtureJson from "./dev-fixtures.json";
import { matchesFilter, serializeFilter } from "./state";

export type Stats = ReturnType<Store["stats"]>;
/** The API may attach the attribution reason for unattributed rows; SessionRow itself does not carry it. */
export type SessionListRow = SessionRow & { attributionReason?: NonNullable<Attribution["reason"]> };
export type LiveState = "connecting" | "live" | "offline" | "fixtures";
export type EvalCaseInput = { query: string; expectedUri?: string; fromTraceId?: string };
export type EventHandlers = { onSession?: (row: SessionListRow) => void; onState?: (state: LiveState) => void };

export type Api = {
  mode: "http" | "fixtures";
  sessions(filter: Filter): Promise<SessionListRow[]>;
  trace(sessionId: string): Promise<TraceStep[]>;
  flow(filter: Filter, opts?: { unit?: FlowDto["unit"]; top?: number }): Promise<FlowDto>;
  heatmap(filter: Filter, opts?: { tz?: string; weekStart?: 0 | 1; bucket?: 1 | 2 | 4 }): Promise<HeatmapDto>;
  skillWeek(filter: Filter): Promise<SkillWeekDto>;
  stats(): Promise<Stats>;
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
  heatmap: (filter, opts = {}) => request(withQuery("/api/heatmap", filter, { tz: opts.tz, weekStart: opts.weekStart, bucket: opts.bucket })),
  skillWeek: (filter) => request(withQuery("/api/skill-week", filter)),
  stats: () => request("/api/stats"),
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

export type FixtureVariant = "full" | "twelve" | "empty";

export function fixtureVariant(search: string = typeof location === "undefined" ? "" : location.search): FixtureVariant | undefined {
  const value = new URLSearchParams(search).get("fixtures");
  if (value === null) return undefined;
  if (value === "12") return "twelve";
  if (value === "0" || value === "empty" || value === "none") return "empty";
  return "full";
}

function fixtureApi(variant: FixtureVariant): Api {
  const data = fixtureJson as unknown as FixtureData;
  const twelve = new Set(data.sessions12);
  const rows = variant === "empty" ? [] : variant === "twelve" ? data.sessions.filter((row) => twelve.has(row.id)) : data.sessions;
  const stats = variant === "empty" ? data.statsEmpty : data.stats;
  const settle = <T>(value: T): Promise<T> => new Promise((resolve) => setTimeout(() => resolve(value), 0));
  return {
    mode: "fixtures",
    sessions: (filter) => settle(rows.filter((row) => matchesFilter(row, filter))),
    trace: (sessionId) => settle(data.traces[sessionId] ?? []),
    flow: (_filter, opts = {}) => {
      const dto = variant === "twelve" ? data.flow12 : data.flow;
      return settle(variant === "empty" ? { ...dto, nodes: [], links: [], sessionCount: 0, unit: opts.unit ?? dto.unit } : { ...dto, unit: opts.unit ?? dto.unit });
    },
    heatmap: () => {
      const dto = variant === "twelve" ? data.heatmap12 : data.heatmap;
      return settle(variant === "empty" ? { ...dto, cells: [], rowTotals: dto.rowTotals.map(() => 0), colTotals: dto.colTotals.map(() => 0) } : dto);
    },
    skillWeek: () => settle(variant === "empty" ? { ...data.skillWeek, rows: [] } : variant === "twelve" ? data.skillWeek12 : data.skillWeek),
    stats: () => settle(stats),
    skills: () => settle(data.skills),
    addEvalCase: () => settle(undefined),
    health: () => settle({ ok: true, version: "fixtures" }),
    events({ onState }) {
      onState?.("fixtures");
      return () => undefined;
    },
  };
}

const variant = fixtureVariant();
export const api: Api = variant ? fixtureApi(variant) : httpApi;
