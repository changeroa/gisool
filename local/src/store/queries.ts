import { existsSync, readFileSync } from "node:fs";
import { automationOf, NO_ACTIVITY } from "./automation.js";
import { nameFromUri, parseJson, readIngestCounters, storeError, type StoreCtx } from "./writes.js";
import type { AdoptionState, Attribution, Candidate, EventKind, Filter, FlowDto, HeatmapDto, RuntimeId, SessionRow, SkillUri, SkillWeekDto, Store, TraceStep } from "../types.js";

const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;
const RUNTIMES: RuntimeId[] = ["claude-code", "codex", "gemini", "cursor", "omo", "gajae", "openclaw", "unknown"];

export type TaskTypeRule = { taskType: string; anyTags?: string[]; anyGroup?: string[]; anyNameKeywords?: string[]; anyPromptKeywords?: string[] };

let rulesCache: TaskTypeRule[] | undefined;

/** tsc does not copy JSON into dist, so the rules are read beside the compiled module first, then from src/store. */
export function taskTypeRules(): TaskTypeRule[] {
  if (rulesCache) return rulesCache;
  const candidates = [new URL("./task-types.json", import.meta.url), new URL("../../src/store/task-types.json", import.meta.url)];
  const found = candidates.find((u) => existsSync(u));
  if (!found) throw storeError("task_types_missing", "task-types.json not found next to the store module or in src/store");
  rulesCache = JSON.parse(readFileSync(found, "utf8")) as TaskTypeRule[];
  return rulesCache;
}

type SkillMeta = { uri: SkillUri; name: string; tags: string[]; groupId?: string };

function tokens(s: string): string[] {
  return s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

function keywordInText(keyword: string, text: string): boolean {
  const k = keyword.toLowerCase();
  if (/^[\x20-\x7e]+$/.test(k)) {
    const escaped = k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(^|[^a-z0-9])${escaped}($|[^a-z0-9])`).test(text);
  }
  return text.includes(k);
}

function skillMatches(rule: TaskTypeRule, skill: SkillMeta): boolean {
  const tags = skill.tags.map((t) => t.toLowerCase());
  if (rule.anyTags?.some((t) => tags.includes(t.toLowerCase()))) return true;
  if (skill.groupId && rule.anyGroup?.some((g) => g.toLowerCase() === skill.groupId!.toLowerCase())) return true;
  const nameTokens = tokens(skill.name);
  const name = skill.name.toLowerCase();
  return rule.anyNameKeywords?.some((k) => nameTokens.includes(k.toLowerCase()) || (/[-_ ]/.test(k) && name.includes(k.toLowerCase()))) ?? false;
}

export function classifyTaskType(skill: SkillMeta | undefined, prompt: string | undefined, rules = taskTypeRules()): string {
  if (skill) {
    const hit = rules.find((r) => skillMatches(r, skill));
    if (hit) return hit.taskType;
    if (skill.groupId) return skill.groupId;
  }
  if (prompt) {
    const text = prompt.toLowerCase();
    const hit = rules.find((r) => r.anyPromptKeywords?.some((k) => keywordInText(k, text)));
    if (hit) return hit.taskType;
  }
  return "unclassified";
}

type EvRow = { id: string; ts: number; kind: EventKind; session_id: string; attribution_method: Attribution["method"]; attribution_reason: string | null;
  runtime: string; trace_id: string | null; load_id: string | null; skill_uri: string | null; text: string | null; text_length: number | null; data_json: string;
  tool_use_id: string | null; turn_key: string | null; call_id: string | null };

/** Sums the buckets a runtime reports without double counting: Codex counts cached tokens inside inputTokens, Claude Code does not. */
function llmTokens(data: Record<string, unknown>): number {
  const n = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);
  if (typeof data.totalTokens === "number") return data.totalTokens;
  const base = n(data.inputTokens) + n(data.outputTokens);
  return data.inputIncludesCache === true ? base : base + n(data.cacheReadTokens) + n(data.cacheCreationTokens);
}

type SessionInfo = {
  id: string; runtime: RuntimeId; startedAt: number; endedAt?: number; firstPrompt?: string; events: EvRow[];
  loaded: SkillUri[]; exposed: SkillUri[]; firstTop?: SkillUri; state: AdoptionState; attribution: Attribution["method"]; texts: string[];
  automated?: string;
};

const fmtCache = new Map<string, Intl.DateTimeFormat>();
const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export function localDowHour(ts: number, tz: string): { dow: number; hour: number } {
  let fmt = fmtCache.get(tz);
  if (!fmt) {
    try {
      fmt = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", hour: "numeric", hourCycle: "h23" });
    } catch {
      throw storeError("invalid_tz", `unknown time zone: ${tz}`);
    }
    fmtCache.set(tz, fmt);
  }
  let dow = 0;
  let hour = 0;
  for (const p of fmt.formatToParts(ts)) {
    if (p.type === "weekday") dow = WEEKDAYS[p.value] ?? 0;
    else if (p.type === "hour") hour = Number(p.value) % 24;
  }
  return { dow, hour };
}

function candidatesOf(data: Record<string, unknown>): Candidate[] {
  return Array.isArray(data.candidates) ? (data.candidates as Candidate[]) : [];
}

/** Adoption precedence: loaded > exposed_only > no_match > aborted (error after a search) > not_used. */
export function adoptionState(events: { kind: EventKind; data: Record<string, unknown> }[]): AdoptionState {
  if (events.some((e) => e.kind === "load")) return "loaded";
  const searches = events.filter((e) => e.kind === "search");
  if (searches.some((e) => candidatesOf(e.data).length >= 1)) return "exposed_only";
  if (searches.some((e) => e.data.abstained !== undefined && e.data.abstained !== null)) return "no_match";
  const firstSearch = events.findIndex((e) => e.kind === "search");
  if (firstSearch >= 0 && events.slice(firstSearch + 1).some((e) => e.kind === "error")) return "aborted";
  return "not_used";
}

function isoWeekStart(ts: number): number {
  const d = new Date(ts);
  const mondayOffset = (d.getUTCDay() + 6) % 7;
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - mondayOffset * DAY_MS;
}

function isoWeekLabel(weekStart: number): string {
  const thursday = new Date(weekStart + 3 * DAY_MS);
  const year = thursday.getUTCFullYear();
  const week1 = isoWeekStart(Date.UTC(year, 0, 4));
  const week = 1 + Math.round((weekStart - week1) / WEEK_MS);
  return `${year}-W${String(week).padStart(2, "0")}`;
}

function shortDigest(d: unknown): string {
  const s = typeof d === "string" ? d : "";
  return s.replace(/^sha256[:-]/, "").slice(0, 12);
}

type Queries = Pick<Store, "sessions" | "trace" | "flow" | "heatmap" | "skillWeek" | "stats">;

export function createQueries(ctx: StoreCtx): Queries {
  const { db } = ctx;
  const defaultTz = () => ctx.opts.tz ?? Intl.DateTimeFormat().resolvedOptions().timeZone;

  function skillMeta(): Map<SkillUri, SkillMeta> {
    const rows = db.prepare("SELECT uri, name, tags_json, group_id FROM skills").all() as { uri: string; name: string; tags_json: string; group_id: string | null }[];
    return new Map(rows.map((r) => [r.uri, { uri: r.uri, name: r.name, tags: parseJson<string[]>(r.tags_json, []), ...(r.group_id ? { groupId: r.group_id } : {}) }]));
  }

  function metaFor(skills: Map<SkillUri, SkillMeta>, uri: SkillUri): SkillMeta {
    return skills.get(uri) ?? { uri, name: nameFromUri(uri), tags: [] };
  }

  function loadSessions(f: Filter, ignoreCellFilter = false): SessionInfo[] {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (f.from !== undefined) { where.push("started_at >= ?"); params.push(f.from); }
    if (f.to !== undefined) { where.push("started_at < ?"); params.push(f.to); }
    if (f.runtime && f.runtime.length > 0) { where.push(`runtime IN (${f.runtime.map(() => "?").join(",")})`); params.push(...f.runtime); }
    const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const rows = db.prepare(`SELECT id, runtime, started_at, ended_at, first_prompt FROM sessions ${clause}`).all(...params) as
      { id: string; runtime: string; started_at: number; ended_at: number | null; first_prompt: string | null }[];
    // Model calls and tool runs say nothing about adoption state and outnumber every other kind, so sessions are built without them.
    const events = db.prepare(`SELECT * FROM events WHERE session_id IN (SELECT id FROM sessions ${clause}) AND kind NOT IN ('llm_call', 'tool_call')
      ORDER BY ts, rowid`).all(...params) as EvRow[];
    const bySession = new Map<string, EvRow[]>();
    for (const e of events) {
      const list = bySession.get(e.session_id);
      if (list) list.push(e); else bySession.set(e.session_id, [e]);
    }
    const tz = (f as Filter & { tz?: string }).tz ?? defaultTz();
    const out: SessionInfo[] = [];
    for (const r of rows) {
      const evs = bySession.get(r.id) ?? [];
      const parsed = evs.map((e) => ({ kind: e.kind, data: parseJson<Record<string, unknown>>(e.data_json, {}) }));
      const loaded: SkillUri[] = [];
      const exposed: SkillUri[] = [];
      let firstTop: SkillUri | undefined;
      const texts: string[] = [];
      evs.forEach((e, i) => {
        const data = parsed[i]!.data;
        if (e.kind === "load") {
          const uri = e.skill_uri ?? (typeof data.uri === "string" ? data.uri : undefined);
          if (uri && !loaded.includes(uri)) loaded.push(uri);
        } else if (e.kind === "search") {
          const cands = [...candidatesOf(data)].sort((a, b) => a.rank - b.rank);
          if (firstTop === undefined && cands[0]) firstTop = cands[0].uri;
          for (const c of cands) if (!exposed.includes(c.uri)) exposed.push(c.uri);
          if (typeof data.query === "string") texts.push(data.query);
        } else if (e.kind === "prompt" && e.text) texts.push(e.text);
      });
      const attributed = evs.find((e) => e.attribution_method !== "none");
      const info: SessionInfo = {
        id: r.id, runtime: r.runtime as RuntimeId, startedAt: r.started_at, events: evs, loaded, exposed, state: adoptionState(parsed),
        attribution: attributed?.attribution_method ?? "none", texts,
        ...(r.ended_at !== null ? { endedAt: r.ended_at } : {}),
        ...(r.first_prompt !== null ? { firstPrompt: r.first_prompt } : {}),
        ...(firstTop !== undefined ? { firstTop } : {}),
      };
      // A session with no prompt and no skill activity (e.g. a thread the Codex daemon reopened) tells nothing about usage.
      const idle = loaded.length === 0 && exposed.length === 0
        && !evs.some((e) => e.kind === "prompt" || e.kind === "native_skill" || e.kind === "read_file");
      const automated = automationOf(info.firstPrompt) ?? (idle ? NO_ACTIVITY : undefined);
      if (automated !== undefined) info.automated = automated;
      if (f.automated === undefined && automated !== undefined) continue;
      if (f.automated === "only" && automated === undefined) continue;
      if (f.state && f.state.length > 0 && !f.state.includes(info.state)) continue;
      if (f.skill && f.skill.length > 0 && !f.skill.some((u) => loaded.includes(u) || exposed.includes(u))) continue;
      if (f.q) {
        const q = f.q.toLowerCase();
        if (![info.firstPrompt ?? "", ...texts].some((t) => t.toLowerCase().includes(q))) continue;
      }
      if (!ignoreCellFilter && (f.dow !== undefined || f.hour !== undefined)) {
        const local = localDowHour(r.started_at, tz);
        if (f.dow !== undefined && local.dow !== f.dow) continue;
        if (f.hour !== undefined) {
          const span = f.hourSpan ?? 1;
          if (local.hour < f.hour || local.hour >= f.hour + span) continue;
        }
      }
      out.push(info);
    }
    return out;
  }

  function sessionSkills(s: SessionInfo): SkillUri[] {
    if (s.loaded.length > 0) return s.loaded;
    return s.firstTop ? [s.firstTop] : [];
  }

  return {
    sessions(f: Filter): SessionRow[] {
      return loadSessions(f)
        .sort((a, b) => b.startedAt - a.startedAt)
        .map((s) => ({
          id: s.id, runtime: s.runtime, startedAt: s.startedAt, skills: sessionSkills(s), state: s.state, attribution: s.attribution,
          ...(s.endedAt !== undefined ? { endedAt: s.endedAt } : {}),
          ...(s.firstPrompt !== undefined ? { firstPrompt: s.firstPrompt } : {}),
          ...(s.automated !== undefined ? { automated: s.automated } : {}),
        }));
    },

    trace(sessionId: string): TraceStep[] {
      const evs = db.prepare("SELECT * FROM events WHERE session_id = ? ORDER BY ts, rowid").all(sessionId) as EvRow[];
      const skills = skillMeta();
      const loadsByTrace = new Map<string, { ts: number; uri: SkillUri }[]>();
      for (const e of evs) {
        if (e.kind !== "load" || !e.trace_id || !e.skill_uri) continue;
        const list = loadsByTrace.get(e.trace_id) ?? [];
        list.push({ ts: e.ts, uri: e.skill_uri });
        loadsByTrace.set(e.trace_id, list);
      }
      const loadRow = db.prepare("SELECT uri, manifest_digest FROM loads WHERE load_id = ?");
      return evs.map((e): TraceStep => {
        const data = parseJson<Record<string, unknown>>(e.data_json, {});
        switch (e.kind) {
          case "prompt": {
            const textLength = e.text_length ?? e.text?.length;
            const summary = e.text ? e.text.slice(0, 200) : `(prompt not captured${textLength !== undefined ? `, ${textLength} chars` : ""})`;
            return { ts: e.ts, kind: e.kind, summary, detail: { kind: "prompt", ...(e.text !== null ? { text: e.text } : {}), ...(textLength !== undefined ? { textLength } : {}) } };
          }
          case "search": {
            const traceId = e.trace_id ?? (typeof data.traceId === "string" ? data.traceId : "");
            const later = (loadsByTrace.get(traceId) ?? []).filter((l) => l.ts >= e.ts).map((l) => l.uri);
            const cands = candidatesOf(data).map((c) => ({ ...c, chosen: later.includes(c.uri) }));
            const chosen = cands.filter((c) => c.chosen).map((c) => c.uri);
            const query = typeof data.query === "string" ? data.query : "";
            const abstained = data.abstained as { reason: string } | undefined;
            const summary = abstained
              ? `search "${query}" abstained (${abstained.reason}) in ${Number(data.elapsedMs ?? 0)} ms`
              : `search "${query}" -> ${cands.length} candidates in ${Number(data.elapsedMs ?? 0)} ms`;
            return { ts: e.ts, kind: e.kind, summary, detail: { ...data, kind: "search", traceId, chosen, candidates: cands } };
          }
          case "load": {
            const loadId = e.load_id ?? (typeof data.loadId === "string" ? data.loadId : "");
            const stored = loadId ? (loadRow.get(loadId) as { uri: string; manifest_digest: string } | undefined) : undefined;
            const uri = e.skill_uri ?? stored?.uri ?? (typeof data.uri === "string" ? data.uri : "");
            const manifestDigest = typeof data.manifestDigest === "string" ? data.manifestDigest : stored?.manifest_digest ?? "";
            return { ts: e.ts, kind: e.kind, summary: `load ${metaFor(skills, uri).name} (${uri}) @${shortDigest(manifestDigest)}`,
              detail: { kind: "load", uri, loadId, manifestDigest } };
          }
          case "read_file": {
            const uri = typeof data.uri === "string" ? data.uri : "";
            const bytes = Number(data.bytes ?? data.size ?? 0);
            const skillUri = e.skill_uri ?? (typeof data.skillUri === "string" ? data.skillUri : "");
            return { ts: e.ts, kind: e.kind, summary: `read ${uri} (${bytes} bytes)`, detail: { kind: "read_file", skillUri, uri, bytes } };
          }
          case "native_skill": {
            const name = typeof data.name === "string" ? data.name : e.skill_uri ? nameFromUri(e.skill_uri) : "unknown";
            const via = typeof data.via === "string" ? data.via : "tool";
            return { ts: e.ts, kind: e.kind, summary: `native skill ${name} via ${via}`, detail: { kind: "native_skill", name, via } };
          }
          case "llm_call": {
            const model = typeof data.model === "string" ? data.model : "unknown";
            return { ts: e.ts, kind: e.kind, summary: `model call: ${model}, ${llmTokens(data)} tokens`,
              detail: { ...data, kind: "llm_call", inputIncludesCache: data.inputIncludesCache === true } };
          }
          case "tool_call": {
            const toolName = typeof data.toolName === "string" ? data.toolName : "unknown";
            const durationMs = typeof data.durationMs === "number" ? data.durationMs : undefined;
            const outcome = data.success === true ? "ok" : data.success === false ? "failed" : "unknown";
            return { ts: e.ts, kind: e.kind, summary: `tool: ${toolName} (${durationMs ?? "?"} ms, ${outcome})`,
              detail: { ...data, kind: "tool_call", toolName,
                ...(e.tool_use_id !== null ? { toolUseId: e.tool_use_id } : {}), ...(e.call_id !== null ? { callId: e.call_id } : {}),
                ...(e.text !== null ? { args: e.text } : {}), ...(e.text_length !== null ? { argsLength: e.text_length } : {}) } };
          }
          case "error": {
            const code = typeof data.code === "string" ? data.code : "error";
            const message = typeof data.message === "string" ? data.message : e.text ?? "";
            return { ts: e.ts, kind: e.kind, summary: `error ${code}${message ? `: ${message.slice(0, 200)}` : ""}`, detail: { kind: "error", code, message } };
          }
          default:
            return { ts: e.ts, kind: e.kind, summary: e.kind === "session_start" ? "session started" : "session ended", detail: { kind: e.kind } };
        }
      });
    },

    flow(f: Filter, unit: "first_load" | "all_loads", top = 7): FlowDto {
      const limit = Math.min(15, Math.max(1, Math.floor(top)));
      const sessions = loadSessions(f);
      const skills = skillMeta();
      type Path = { session: string; task: string; skill: string; state: AdoptionState };
      const paths: Path[] = [];
      for (const s of sessions) {
        const primary = s.loaded[0] ?? s.firstTop;
        const task = classifyTaskType(primary ? metaFor(skills, primary) : undefined, s.firstPrompt ?? s.texts[0]);
        const skillList = unit === "all_loads" && s.loaded.length > 0 ? s.loaded : primary ? [primary] : ["(none)"];
        for (const sk of skillList) paths.push({ session: s.id, task, skill: sk, state: s.state });
      }

      const OTHER = "__other__";
      const otherMembers: [Set<string>, Set<string>, Set<string>] = [new Set(), new Set(), new Set()];
      const keep = (values: string[], column: 0 | 1 | 2): Map<string, string> => {
        const sessionsBy = new Map<string, Set<string>>();
        paths.forEach((p, i) => {
          const v = values[i]!;
          const set = sessionsBy.get(v) ?? new Set<string>();
          set.add(p.session);
          sessionsBy.set(v, set);
        });
        const ranked = [...sessionsBy.entries()].sort((a, b) => b[1].size - a[1].size || a[0].localeCompare(b[0]));
        const map = new Map<string, string>();
        ranked.forEach(([v], i) => {
          if (i < limit) map.set(v, v);
          else { map.set(v, OTHER); otherMembers[column].add(v); }
        });
        return map;
      };
      const taskMap = keep(paths.map((p) => p.task), 0);
      const skillMap = keep(paths.map((p) => p.skill), 1);
      const stateMap = keep(paths.map((p) => p.state), 2);
      const mapped = paths.map((p) => ({ session: p.session, state: p.state, task: taskMap.get(p.task)!, skill: skillMap.get(p.skill)!, stateNode: stateMap.get(p.state)! }));

      const countLinks = () => {
        const left = new Map<string, Set<string>>();
        const right = new Map<string, Set<string>>();
        const add = (m: Map<string, Set<string>>, k: string, s: string) => { const set = m.get(k) ?? new Set<string>(); set.add(s); m.set(k, set); };
        for (const p of mapped) {
          add(left, `${p.task}\u0000${p.skill}\u0000${p.state}`, p.session);
          add(right, `${p.skill}\u0000${p.stateNode}\u0000${p.state}`, p.session);
        }
        return { left, right };
      };
      const before = countLinks();
      for (const p of mapped) {
        if (p.skill === OTHER) continue;
        const weakLeft = (before.left.get(`${p.task}\u0000${p.skill}\u0000${p.state}`)?.size ?? 0) < 2;
        const weakRight = (before.right.get(`${p.skill}\u0000${p.stateNode}\u0000${p.state}`)?.size ?? 0) < 2;
        if (weakLeft || weakRight) { otherMembers[1].add(p.skill); p.skill = OTHER; }
      }
      const after = countLinks();

      const nodeId = (column: 0 | 1 | 2, v: string) => `${["t", "s", "a"][column]}:${v}`;
      const nodeSessions = new Map<string, { column: 0 | 1 | 2; value: string; sessions: Set<string> }>();
      const touch = (column: 0 | 1 | 2, v: string, s: string) => {
        const id = nodeId(column, v);
        const n = nodeSessions.get(id) ?? { column, value: v, sessions: new Set<string>() };
        n.sessions.add(s);
        nodeSessions.set(id, n);
      };
      for (const p of mapped) { touch(0, p.task, p.session); touch(1, p.skill, p.session); touch(2, p.stateNode, p.session); }
      const label = (column: 0 | 1 | 2, v: string) =>
        v === OTHER ? `Other (${otherMembers[column].size})` : column === 1 ? (v === "(none)" ? "(no skill)" : metaFor(skills, v).name) : v;
      const nodes: FlowDto["nodes"] = [...nodeSessions.entries()]
        .sort((a, b) => a[1].column - b[1].column || Number(a[1].value === OTHER) - Number(b[1].value === OTHER) || b[1].sessions.size - a[1].sessions.size)
        .map(([id, n]) => ({ id, column: n.column, label: label(n.column, n.value), count: n.sessions.size, ...(n.value === OTHER ? { other: true } : {}) }));
      const links: FlowDto["links"] = [];
      for (const [k, set] of after.left) {
        const [task, skill, state] = k.split("\u0000") as [string, string, AdoptionState];
        links.push({ source: nodeId(0, task), target: nodeId(1, skill), count: set.size, state });
      }
      for (const [k, set] of after.right) {
        const [skill, stateNode, state] = k.split("\u0000") as [string, string, AdoptionState];
        links.push({ source: nodeId(1, skill), target: nodeId(2, stateNode), count: set.size, state });
      }
      links.sort((a, b) => b.count - a.count);
      return { unit, columns: ["task_type", "skill", "state"], nodes, links, sessionCount: sessions.length };
    },

    heatmap(f: Filter, tz: string, weekStart: 0 | 1, bucketHours: 1 | 2 | 4): HeatmapDto {
      const buckets = 24 / bucketHours;
      const grid = Array.from({ length: 7 }, () => new Array<number>(buckets).fill(0));
      for (const s of loadSessions(f, true)) {
        const { dow, hour } = localDowHour(s.startedAt, tz);
        grid[dow]![Math.floor(hour / bucketHours)]! += 1;
      }
      const cells: HeatmapDto["cells"] = [];
      for (let i = 0; i < 7; i++) {
        const dow = (weekStart + i) % 7;
        for (let b = 0; b < buckets; b++) cells.push({ dow, hour: b * bucketHours, count: grid[dow]![b]! });
      }
      const rowTotals = grid.map((row) => row.reduce((a, n) => a + n, 0));
      const colTotals = Array.from({ length: buckets }, (_, b) => grid.reduce((a, row) => a + row[b]!, 0));
      return { tz, weekStart, bucketHours, cells, rowTotals, colTotals };
    },

    skillWeek(f: Filter): SkillWeekDto {
      const lastWeek = isoWeekStart(f.to !== undefined ? f.to - 1 : ctx.now());
      const starts = Array.from({ length: 8 }, (_, i) => lastWeek - (7 - i) * WEEK_MS);
      const from = starts[0]!;
      const to = lastWeek + WEEK_MS;
      const where = ["kind = 'load'", "skill_uri IS NOT NULL", "ts >= ?", "ts < ?"];
      const params: (string | number)[] = [from, to];
      if (f.runtime && f.runtime.length > 0) { where.push(`runtime IN (${f.runtime.map(() => "?").join(",")})`); params.push(...f.runtime); }
      if (f.skill && f.skill.length > 0) { where.push(`skill_uri IN (${f.skill.map(() => "?").join(",")})`); params.push(...f.skill); }
      const rows = db.prepare(`SELECT skill_uri, ts FROM events WHERE ${where.join(" AND ")}`).all(...params) as { skill_uri: string; ts: number }[];
      const skills = skillMeta();
      const counts = new Map<string, number[]>();
      for (const r of rows) {
        const idx = Math.floor((r.ts - from) / WEEK_MS);
        const arr = counts.get(r.skill_uri) ?? new Array<number>(8).fill(0);
        arr[idx]! += 1;
        counts.set(r.skill_uri, arr);
      }
      const out = [...counts.entries()]
        .map(([uri, c]) => ({ uri, name: metaFor(skills, uri).name, counts: c }))
        .sort((a, b) => b.counts.reduce((x, y) => x + y, 0) - a.counts.reduce((x, y) => x + y, 0) || a.name.localeCompare(b.name));
      return { weeks: starts.map(isoWeekLabel), rows: out };
    },

    stats(f: Filter = {}) {
      const attributionRate = Object.fromEntries(RUNTIMES.map((r) => [r, null])) as Record<RuntimeId, number | null>;
      const mcp = db.prepare(`SELECT runtime, COUNT(*) AS total, SUM(CASE WHEN session_id != 'unattributed' THEN 1 ELSE 0 END) AS attributed
        FROM events WHERE source = 'mcp' GROUP BY runtime`).all() as { runtime: RuntimeId; total: number; attributed: number }[];
      for (const r of mcp) attributionRate[r.runtime] = r.total > 0 ? r.attributed / r.total : null;
      const where = ["source = 'mcp'", "session_id = 'unattributed'", "kind IN ('search', 'load')"];
      const params: (string | number)[] = [];
      if (f.from !== undefined) { where.push("ts >= ?"); params.push(f.from); }
      if (f.to !== undefined) { where.push("ts < ?"); params.push(f.to); }
      if (f.runtime && f.runtime.length > 0) { where.push(`runtime IN (${f.runtime.map(() => "?").join(",")})`); params.push(...f.runtime); }
      const orphan = db.prepare(`SELECT kind, COUNT(*) AS n FROM events WHERE ${where.join(" AND ")} GROUP BY kind`).all(...params) as { kind: EventKind; n: number }[];
      const unattributed = { searches: orphan.find((o) => o.kind === "search")?.n ?? 0, loads: orphan.find((o) => o.kind === "load")?.n ?? 0 };
      const automatedSessions = loadSessions({ ...f, automated: "only" }).length;
      const searches = db.prepare("SELECT data_json FROM events WHERE kind = 'search'").all() as { data_json: string }[];
      const abstained = searches.filter((s) => parseJson<Record<string, unknown>>(s.data_json, {}).abstained).length;
      const cutoff = ctx.now() - 56 * DAY_MS;
      const unused = db.prepare(`SELECT uri FROM skills WHERE removed_at IS NULL AND uri NOT IN
        (SELECT skill_uri FROM events WHERE kind = 'load' AND skill_uri IS NOT NULL AND ts >= ?) ORDER BY name`).all(cutoff) as { uri: string }[];
      const last = db.prepare("SELECT MAX(ts) AS ts FROM events").get() as { ts: number | null };
      const byRuntime = db.prepare("SELECT runtime, MAX(ts) AS ts FROM events GROUP BY runtime").all() as { runtime: RuntimeId; ts: number }[];
      return {
        attributionRate,
        abstainRate: searches.length > 0 ? abstained / searches.length : 0,
        unusedSkills: unused.map((u) => u.uri),
        ...(last.ts !== null ? { lastEventTs: last.ts } : {}),
        lastEventByRuntime: Object.fromEntries(byRuntime.map((r) => [r.runtime, r.ts])) as Partial<Record<RuntimeId, number>>,
        ingest: readIngestCounters(db),
        unattributed,
        automatedSessions,
      };
    },
  };
}

