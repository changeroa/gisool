import type { AdoptionState, Attribution, Filter, RuntimeId, SessionRow } from "../src/types.js";
import type { LiveState, SessionListRow } from "./api";

// URL state for the dashboard. Routes live in location.hash so the daemon only serves "/":
//   #/sessions?runtime=codex,gemini&state=loaded&q=review
//   #/sessions/<id>?from=...      (trace view keeps the list filter so "back" restores it)
//   #/flow?skill=skill://local/agents/pr-review-ko/SKILL.md
//   #/heatmap?dow=1&hour=9&hourSpan=2
// The query part uses exactly the server's Filter params (from,to epoch ms; runtime,skill,state
// comma lists; dow,hour,hourSpan ints; q), so the same string feeds /api/* calls.

export const RUNTIME_IDS: readonly RuntimeId[] = ["claude-code", "codex", "gemini", "cursor", "omo", "gajae", "openclaw", "unknown"];
export const ADOPTION_STATES: readonly AdoptionState[] = ["loaded", "exposed_only", "no_match", "aborted", "not_used"];
export const FILTER_KEYS = ["from", "to", "runtime", "skill", "state", "dow", "hour", "hourSpan", "q", "automated"] as const satisfies readonly (keyof Filter)[];
export type FilterKey = (typeof FILTER_KEYS)[number];

export type View = "sessions" | "trace" | "flow" | "heatmap";
export type Route = { view: View; sessionId?: string; filter: Filter };
/** One shared SSE subscription: `seq` increments per `session` event, `last` is that event's row. */
export type LiveInfo = { state: LiveState; seq: number; last?: SessionListRow };
/** Props every mounted view receives from main.tsx (trace/flow/heatmap stubs are replaced by todos 15-17). */
export type ViewProps = { route: Route; navigate: (next: Route) => void; live: LiveInfo };

export const RUNTIME_LABEL: Record<RuntimeId, string> = {
  "claude-code": "Claude Code", codex: "Codex", gemini: "Gemini CLI", cursor: "Cursor", omo: "OmO", gajae: "Gajae Code", openclaw: "OpenClaw", unknown: "Unknown",
};
export const RUNTIME_MARK: Record<RuntimeId, string> = {
  "claude-code": "CC", codex: "CX", gemini: "GM", cursor: "CU", omo: "OM", gajae: "GJ", openclaw: "OC", unknown: "??",
};
export const STATE_LABEL: Record<AdoptionState, string> = {
  loaded: "Loaded", exposed_only: "Exposed", no_match: "No match", aborted: "Aborted", not_used: "Not used",
};
export const STATE_TITLE: Record<AdoptionState, string> = {
  loaded: "loaded: a skill was loaded in this session",
  exposed_only: "exposed_only: candidates were shown but none was loaded",
  no_match: "no_match: the search returned no candidate",
  aborted: "aborted: a load started but did not complete",
  not_used: "not_used: the session never searched for a skill",
};
export const ATTRIBUTION_LABEL: Record<Attribution["method"], string> = {
  runtime_id: "runtime id", vendor_meta: "vendor meta", trace_handle: "trace handle", window: "window", none: "unattributed",
};
export const DOW_LABEL = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

const RUNTIME_SET = new Set<string>(RUNTIME_IDS);
const STATE_SET = new Set<string>(ADOPTION_STATES);

function decode(raw: string): string {
  try {
    return decodeURIComponent(raw.replace(/\+/g, " "));
  } catch {
    return raw;
  }
}

/** encodeURIComponent, but keeps ":" and "/" readable so skill URIs stay legible in shared links. */
function encodeItem(value: string): string {
  return encodeURIComponent(value).replace(/%3A/gi, ":").replace(/%2F/gi, "/");
}

function rawPairs(query: string): [string, string][] {
  const q = query.startsWith("?") ? query.slice(1) : query;
  if (!q) return [];
  return q.split("&").filter(Boolean).map((pair) => {
    const i = pair.indexOf("=");
    return i < 0 ? [decode(pair), ""] : [decode(pair.slice(0, i)), pair.slice(i + 1)];
  });
}

function intIn(raw: string, min: number, max: number): number | undefined {
  const text = decode(raw).trim();
  if (!/^-?\d+$/.test(text)) return undefined;
  const n = Number(text);
  return n >= min && n <= max ? n : undefined;
}

function list(raw: string): string[] {
  const seen = new Set<string>();
  for (const item of decode(raw).split(",")) {
    const value = item.trim();
    if (value) seen.add(value);
  }
  return [...seen];
}

/** Parses the query part of a hash route (or a full search string) into a Filter; invalid values are dropped. */
export function parseFilter(input: string | URLSearchParams): Filter {
  const query = typeof input === "string" ? input : input.toString();
  const filter: Filter = {};
  for (const [key, raw] of rawPairs(query)) {
    switch (key) {
      case "from": filter.from = intIn(raw, 0, Number.MAX_SAFE_INTEGER); break;
      case "to": filter.to = intIn(raw, 0, Number.MAX_SAFE_INTEGER); break;
      case "runtime": {
        const runtimes = list(raw).filter((r): r is RuntimeId => RUNTIME_SET.has(r));
        if (runtimes.length) filter.runtime = runtimes;
        break;
      }
      case "skill": {
        const skills = list(raw);
        if (skills.length) filter.skill = skills;
        break;
      }
      case "state": {
        const states = list(raw).filter((s): s is AdoptionState => STATE_SET.has(s));
        if (states.length) filter.state = states;
        break;
      }
      case "dow": filter.dow = intIn(raw, 0, 6); break;
      case "hour": filter.hour = intIn(raw, 0, 23); break;
      case "hourSpan": filter.hourSpan = intIn(raw, 1, 24); break;
      case "q": {
        const q = decode(raw).trim();
        if (q) filter.q = q;
        break;
      }
      case "automated": {
        const value = decode(raw).trim();
        if (value === "include" || value === "only") filter.automated = value;
        break;
      }
      default: break;
    }
  }
  for (const key of FILTER_KEYS) if (filter[key] === undefined) delete filter[key];
  return filter;
}

/** Serializes a Filter to a query string without the leading "?"; keys follow FILTER_KEYS order. Empty filter -> "". */
export function serializeFilter(filter: Filter): string {
  const parts: string[] = [];
  for (const key of FILTER_KEYS) {
    const value = filter[key];
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      if (value.length) parts.push(`${key}=${value.map(encodeItem).join(",")}`);
    } else if (typeof value === "number") {
      if (Number.isFinite(value)) parts.push(`${key}=${value}`);
    } else if (value.trim()) {
      parts.push(`${key}=${encodeItem(value.trim())}`);
    }
  }
  return parts.join("&");
}

export function isEmptyFilter(filter: Filter): boolean {
  return FILTER_KEYS.every((key) => filter[key] === undefined);
}

export function withoutFilterKey(filter: Filter, key: FilterKey): Filter {
  const next: Filter = { ...filter };
  delete next[key];
  // hourSpan only means something next to hour.
  if (key === "hour") delete next.hourSpan;
  return next;
}

export function parseHash(hash: string): Route {
  const h = hash.startsWith("#") ? hash.slice(1) : hash;
  const qi = h.indexOf("?");
  const path = (qi >= 0 ? h.slice(0, qi) : h).replace(/^\/+|\/+$/g, "");
  const filter = parseFilter(qi >= 0 ? h.slice(qi + 1) : "");
  const segments = path ? path.split("/").map(decode) : [];
  switch (segments[0]) {
    case "flow": return { view: "flow", filter };
    case "heatmap": return { view: "heatmap", filter };
    case "sessions":
      return segments[1] ? { view: "trace", sessionId: segments[1], filter } : { view: "sessions", filter };
    default:
      return { view: "sessions", filter };
  }
}

export function buildHash(route: Route): string {
  const path = route.view === "trace"
    ? `/sessions/${encodeURIComponent(route.sessionId ?? "")}`
    : `/${route.view}`;
  const query = serializeFilter(route.filter);
  return `#${path}${query ? `?${query}` : ""}`;
}

export function skillName(uri: string): string {
  // skill://local/<rootId>/<dir>/SKILL.md -> <dir> (the last directory segment)
  const segments = uri.replace(/\/SKILL\.md$/i, "").split("/").filter(Boolean);
  return segments[segments.length - 1] ?? uri;
}

/** Client-side Filter predicate for one SessionRow (fixtures mode and live upserts); dow/hour use local time. */
export function matchesFilter(row: SessionRow, filter: Filter): boolean {
  if (row.automated !== undefined && filter.automated === undefined) return false;
  if (filter.automated === "only" && row.automated === undefined) return false;
  if (filter.from !== undefined && row.startedAt < filter.from) return false;
  if (filter.to !== undefined && row.startedAt > filter.to) return false;
  if (filter.runtime && !filter.runtime.includes(row.runtime)) return false;
  if (filter.state && !filter.state.includes(row.state)) return false;
  if (filter.skill && !filter.skill.some((uri) => row.skills.includes(uri))) return false;
  const started = new Date(row.startedAt);
  if (filter.dow !== undefined && started.getDay() !== filter.dow) return false;
  if (filter.hour !== undefined) {
    const span = filter.hourSpan ?? 1;
    const hour = started.getHours();
    if (hour < filter.hour || hour >= filter.hour + span) return false;
  }
  if (filter.q) {
    const needle = filter.q.toLowerCase();
    const haystack = [row.firstPrompt ?? "", row.id, ...row.skills.map(skillName)].join("\n").toLowerCase();
    if (!haystack.includes(needle)) return false;
  }
  return true;
}
