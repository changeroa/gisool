import { randomUUID } from "node:crypto";
import type { Db } from "./db.js";
import { toolCallReferencesUri, URI_WINDOW_MS } from "../ingest/attribution.js";
import type { Attribution, CanonicalEvent, GisoolConfig, OtelSpanRow, RuntimeId, SessionRef, SkillEntry, SkillUri, Store } from "../types.js";

/**
 * Optional wiring for createStore. `createStore(db)` alone serves ingest and queries;
 * export/import need `gisoolHome` (where config.json lives) and `home` (for "~" rewriting);
 * `config.retentionDays === null` makes retention() a no-op.
 */
export type StoreOptions = {
  config?: GisoolConfig;
  home?: string;
  gisoolHome?: string;
  /** Default IANA tz for Filter.dow/hour in sessions()/flow(); a Filter object may also carry an extra `tz` property. */
  tz?: string;
  now?: () => number;
};

export type StoreCtx = { db: Db; opts: StoreOptions; now: () => number };

export function parseJson<T>(text: unknown, fallback: T): T {
  if (typeof text !== "string" || text === "") return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

export function nameFromUri(uri: string): string {
  const parts = uri.split("/").filter(Boolean);
  const last = parts[parts.length - 1];
  return (last === "SKILL.md" ? parts[parts.length - 2] : last) ?? uri;
}

export function storeError(code: string, message = code): Error {
  return Object.assign(new Error(message), { code });
}

const DAY_MS = 86_400_000;

type SessionDbRow = {
  id: string; runtime: string; runtime_session_id: string | null; conversation_id: string | null;
  client_name: string | null; cwd: string | null; started_at: number; ended_at: number | null; first_prompt: string | null;
};

function refFromRow(row: SessionDbRow): SessionRef {
  const ref: SessionRef = { runtime: row.runtime as RuntimeId };
  if (row.runtime_session_id !== null) ref.runtimeSessionId = row.runtime_session_id;
  if (row.conversation_id !== null) ref.conversationId = row.conversation_id;
  if (row.client_name !== null) ref.clientName = row.client_name;
  if (row.cwd !== null) ref.cwd = row.cwd;
  return ref;
}

function getMeta(db: Db, key: string): string | undefined {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string | null } | undefined;
  return row?.value ?? undefined;
}

function setMeta(db: Db, key: string, value: string): void {
  db.prepare("INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
}

export function readIngestCounters(db: Db): ReturnType<Store["stats"]>["ingest"] {
  const num = (k: string) => Number(getMeta(db, `ingest.${k}`) ?? 0);
  const lastError = parseJson<{ ts: number; code: string } | undefined>(getMeta(db, "ingest.lastError"), undefined);
  return { accepted: num("accepted"), rejected: num("rejected"), dropped: num("dropped"), ...(lastError ? { lastError } : {}) };
}

export function readAliasesOverrides(db: Db): Record<string, string[]> {
  return parseJson<Record<string, string[]>>(getMeta(db, "aliases_overrides"), {});
}

export function writeAliasesOverrides(db: Db, value: Record<string, string[]>): void {
  setMeta(db, "aliases_overrides", JSON.stringify(value));
}

type Writes = Pick<Store, "append" | "hasSourceKey" | "openSessions" | "reattribute" | "findEventByToolUseId" | "upsertSession" | "putLoad" | "getLoad"
  | "latestLoad" | "traceSession" | "upsertSkills" | "markRemoved" | "countIngest" | "addEvalCase" | "evalCases" | "retention" | "putSpans" | "reconcileLoads">;

export function createWrites(ctx: StoreCtx): Writes {
  const { db } = ctx;

  const insertEvent = db.prepare(`INSERT OR IGNORE INTO events
    (id, ts, kind, source, session_id, attribution_method, attribution_reason, runtime, trace_id, load_id, skill_uri, tool_use_id, text, text_digest, text_length, data_json,
     source_key, turn_key, call_id, span_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const selectSourceKey = db.prepare("SELECT 1 AS hit FROM events WHERE source_key = ?");
  const insertSpan = db.prepare(`INSERT OR IGNORE INTO otel_spans
    (trace_id, span_id, parent_span_id, name, runtime, conversation_id, turn_key, call_id, start_ms, end_ms, received_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  // One statement per counter: a Codex trace batch drops thousands of spans, which countIngest would commit one by one.
  // The bound amount is cast to INTEGER so the counter stays the plain integer string countIngest writes, not "793.0".
  const addIngestCount = db.prepare(`INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + CAST(? AS INTEGER) AS TEXT)`);
  const setFirstPrompt = db.prepare("UPDATE sessions SET first_prompt = ? WHERE id = ? AND first_prompt IS NULL");
  const setEnded = db.prepare("UPDATE sessions SET ended_at = MAX(COALESCE(ended_at, 0), ?) WHERE id = ?");
  type LoadRow = {
    id: string; ts: number; runtime: RuntimeId; skill_uri: string | null; data_json: string;
    session_id: string; attribution_method: string; attribution_reason: string | null;
  };
  type ToolRow = { session_id: string; text: string | null; gisoolMcp: number | null };
  const pending = `e.source = 'mcp' AND e.kind = 'load' AND e.session_id = 'unattributed' AND e.attribution_reason = 'ambiguous'`;
  const recoverable = `e.source = 'mcp' AND e.kind = 'load' AND ((${pending})
    OR (e.attribution_method = 'trace_handle' AND json_extract(e.data_json, '$.attributionBasis') = 'tool_call_uri'))`;
  const pendingInRange = db.prepare(`SELECT e.* FROM events e INDEXED BY events_pending_load_ts WHERE ${pending} AND e.ts >= ? AND e.ts < ?`);
  const pendingInSessions = db.prepare(`SELECT DISTINCT e.* FROM json_each(?) s
    CROSS JOIN load_candidates c ON c.session_id = s.value AND c.ts >= ? AND c.ts < ?
    CROSS JOIN events e ON e.id = c.load_id WHERE ${pending}`);
  const pendingBatch = db.prepare(`SELECT e.* FROM events e INDEXED BY events_pending_load_ts
    WHERE ${pending} AND e.ts >= ? AND e.ts < ? AND (e.ts, e.rowid) > (?, ?)
    ORDER BY e.ts, e.rowid LIMIT ?`);
  const pendingSessionBatch = db.prepare(`SELECT DISTINCT e.rowid, e.* FROM json_each(?) s
    CROSS JOIN load_candidates c ON c.session_id = s.value AND c.ts >= ? AND c.ts < ?
    CROSS JOIN events e ON e.id = c.load_id
    WHERE ${pending} AND (e.ts, e.rowid) > (?, ?) ORDER BY e.ts, e.rowid LIMIT ?`);
  const repairCursor = db.prepare("SELECT rowid, ts, source, kind FROM events WHERE id = ?");
  const eventById = db.prepare(`SELECT *, json_extract(data_json, '$.gisoolMcp') AS gisoolMcp,
    json_extract(data_json, '$.success') AS success FROM events WHERE id = ?`);
  const loadById = db.prepare(`SELECT e.* FROM events e WHERE e.id = ? AND ${recoverable}`);
  const loadsForTool = db.prepare(`SELECT e.* FROM events e INDEXED BY events_reconcile_load_uri
    WHERE ${recoverable} AND e.runtime = ? AND e.skill_uri = ? AND e.ts BETWEEN ? AND ?
      AND EXISTS (SELECT 1 FROM load_candidates c WHERE c.load_id = e.id AND c.session_id = ?)`);
  const toolUris = db.prepare(`SELECT DISTINCT value FROM json_tree(CASE WHEN json_valid(?) THEN ? ELSE '{}' END)
    WHERE type = 'text' AND value LIKE 'skill://%'`);
  const loadCandidates = db.prepare("SELECT session_id FROM load_candidates WHERE load_id = ? ORDER BY session_id");
  const toolsForCandidate = db.prepare(`SELECT session_id, text, json_extract(data_json, '$.gisoolMcp') AS gisoolMcp
    FROM events INDEXED BY events_uri_tools WHERE source = 'otel' AND kind = 'tool_call'
      AND runtime = ? AND session_id = ? AND ts BETWEEN ? AND ? AND session_id != 'unattributed'
      AND json_extract(data_json, '$.success') IS NOT 0`);
  const updateLoad = db.prepare(`UPDATE events SET session_id = ?, attribution_method = ?, attribution_reason = ?, data_json = ?
    WHERE id = ? AND (session_id IS NOT ? OR attribution_method IS NOT ? OR attribution_reason IS NOT ? OR data_json IS NOT ?)`);

  function sessionSideEffects(sessionId: string, kind: string, ts: number, text: string | null): void {
    if (sessionId === "unattributed") return;
    if (kind === "prompt" && text !== null) setFirstPrompt.run(text, sessionId);
    if (kind === "session_end") setEnded.run(ts, sessionId);
  }

  return {
    reconcileLoads(opts = {}) {
      const from = opts.from ?? Number.MIN_SAFE_INTEGER;
      const to = opts.to ?? Number.MAX_SAFE_INTEGER;
      let loads: LoadRow[];
      if (opts.eventId !== undefined) {
        const event = eventById.get(opts.eventId) as
          (LoadRow & { source: string; kind: string; text: string | null; gisoolMcp: number | null; success: number | null }) | undefined;
        if (!event) return { count: 0, uris: [] };
        if (event.kind === "load") {
          const load = loadById.get(event.id) as LoadRow | undefined;
          loads = load ? [load] : [];
        } else {
          if (event.source !== "otel" || event.kind !== "tool_call" || event.session_id === "unattributed" || event.success === 0) {
            return { count: 0, uris: [] };
          }
          // Extract only from captured text. Metadata capture cannot create evidence from discarded arguments.
          const uris = toolUris.all(event.text, event.text) as { value: string }[];
          loads = uris.filter(({ value }) => toolCallReferencesUri(event.text, value, event.gisoolMcp === 1))
            .flatMap(({ value }) => loadsForTool.all(event.runtime, value, event.ts - URI_WINDOW_MS,
              event.ts + URI_WINDOW_MS, event.session_id) as LoadRow[]);
        }
      } else if (opts.limit !== undefined) {
        const cursor = opts.after === undefined ? { ts: from, rowid: 0 }
          : repairCursor.get(opts.after) as { ts: number; rowid: number; source: string; kind: string } | undefined;
        if (!cursor || cursor.ts < from || cursor.ts >= to
          || ("source" in cursor && (cursor.source !== "mcp" || cursor.kind !== "load"))) {
          throw storeError("invalid_repair_cursor", "repair cursor must identify an MCP load in the requested time range");
        }
        loads = (opts.sessionIds === undefined
          ? pendingBatch.all(Math.max(from, cursor.ts), to, cursor.ts, cursor.rowid, opts.limit)
          : pendingSessionBatch.all(JSON.stringify(opts.sessionIds), Math.max(from, cursor.ts), to,
            cursor.ts, cursor.rowid, opts.limit)) as LoadRow[];
      } else {
        loads = (opts.sessionIds === undefined ? pendingInRange.all(from, to)
          : pendingInSessions.all(JSON.stringify(opts.sessionIds), from, to)) as LoadRow[];
      }
      let count = 0;
      let repaired = 0;
      const uris = new Set<string>();
      if (!opts.readOnly && loads.length > 0) db.exec("SAVEPOINT reconcile_loads");
      try {
        for (const selected of loads) {
          // A repair CLI can run beside ingest. Read retained proof inside the transaction, not from the earlier batch.
          const load = opts.limit === undefined || opts.readOnly ? selected : loadById.get(selected.id) as LoadRow | undefined;
          if (!load) continue;
          const uri = load.skill_uri;
          if (uri === null) continue;
          let sessionId: string | undefined = load.session_id === "unattributed" ? undefined : load.session_id;
          if (!opts.readOnly) {
            const data = parseJson<Record<string, unknown>>(load.data_json, {});
            const candidates = (loadCandidates.all(load.id) as { session_id: string }[]).map((row) => row.session_id);
            if (!Array.isArray(data.attributionCandidates)) data.attributionCandidates = candidates;
            // Minimal durable proof: candidate session ids that actually matched this load's URI/window.
            // Expired text cannot erase that proof; later evidence for another candidate still retracts uniqueness.
            const matches = new Set(Array.isArray(data.attributionMatches)
              ? data.attributionMatches.filter((id): id is string => typeof id === "string" && candidates.includes(id))
              : data.attributionBasis === "tool_call_uri" && sessionId !== undefined ? [sessionId] : []);
            for (const candidate of candidates) {
              const tools = toolsForCandidate.all(load.runtime, candidate, load.ts - URI_WINDOW_MS, load.ts + URI_WINDOW_MS) as ToolRow[];
              if (tools.some((tool) => toolCallReferencesUri(tool.text, uri, tool.gisoolMcp === 1))) matches.add(candidate);
            }
            if (matches.size > 0) data.attributionMatches = [...matches].sort();
            sessionId = matches.size === 1 ? matches.values().next().value : undefined;
            if (sessionId !== undefined) data.attributionBasis = "tool_call_uri";
            else delete data.attributionBasis;
            const nextId = sessionId ?? "unattributed";
            const method = sessionId === undefined ? "none" : "trace_handle";
            const reason = sessionId === undefined ? "ambiguous" : null;
            const json = JSON.stringify(data);
            updateLoad.run(nextId, method, reason, json, load.id, nextId, method, reason, json);
          }
          if (sessionId !== undefined) {
            if (load.session_id === "unattributed") repaired += 1;
            continue;
          }
          count += 1;
          uris.add(uri);
        }
        if (!opts.readOnly && loads.length > 0) db.exec("RELEASE reconcile_loads");
      } catch (error) {
        if (!opts.readOnly && loads.length > 0) db.exec("ROLLBACK TO reconcile_loads; RELEASE reconcile_loads");
        throw error;
      }
      return { count, uris: [...uris].sort(), ...(opts.limit === undefined ? {} : {
        examined: loads.length, repaired, next: loads.length === opts.limit ? loads.at(-1)!.id : null,
      }) };
    },

    append(event: CanonicalEvent, attribution: Attribution): boolean {
      const text = event.text ?? null;
      const result = insertEvent.run(event.id, event.ts, event.kind, event.source, attribution.sessionId, attribution.method, attribution.reason ?? null,
        event.ref.runtime, event.traceId ?? null, event.loadId ?? null, event.skillUri ?? null, event.toolUseId ?? null, text,
        event.textDigest ?? null, event.textLength ?? null, JSON.stringify(event.data ?? {}),
        event.sourceKey ?? null, event.turnKey ?? null, event.callId ?? null, event.spanId ?? null);
      const inserted = Number(result.changes) > 0;
      // A record the agent re-sent must not reopen its session or replace the first prompt it already set.
      if (inserted) sessionSideEffects(attribution.sessionId, event.kind, event.ts, text);
      return inserted;
    },

    hasSourceKey(sourceKey: string): boolean {
      return selectSourceKey.get(sourceKey) !== undefined;
    },

    openSessions(runtime: RuntimeId, since: number) {
      const rows = db.prepare(`SELECT s.*, MAX(s.started_at, COALESCE(MAX(e.ts), s.started_at)) AS last_activity
        FROM sessions s LEFT JOIN events e ON e.session_id = s.id
        WHERE s.runtime = ? AND s.ended_at IS NULL GROUP BY s.id HAVING last_activity >= ? ORDER BY last_activity DESC`)
        .all(runtime, since) as (SessionDbRow & { last_activity: number })[];
      return rows.map((r) => ({ id: r.id, startedAt: r.started_at, lastActivityAt: r.last_activity, ref: refFromRow(r) }));
    },

    reattribute(eventId: string, sessionId: string, method: Attribution["method"]): void {
      db.prepare("UPDATE events SET session_id = ?, attribution_method = ?, attribution_reason = NULL WHERE id = ?").run(sessionId, method, eventId);
      const ev = db.prepare("SELECT kind, ts, text FROM events WHERE id = ?").get(eventId) as { kind: string; ts: number; text: string | null } | undefined;
      if (ev) sessionSideEffects(sessionId, ev.kind, ev.ts, ev.text);
    },

    findEventByToolUseId(toolUseId: string): string | undefined {
      const row = db.prepare("SELECT id FROM events WHERE tool_use_id = ? ORDER BY ts DESC, rowid DESC LIMIT 1").get(toolUseId) as { id: string } | undefined;
      return row?.id;
    },

    upsertSession(ref: SessionRef, startedAt: number): string {
      // A runtime can name one session differently per channel (Codex OTel sends only conversation.id while its MCP _meta sends
      // sessionId and threadId), so any key of the ref matches either id column.
      const keys = [ref.runtimeSessionId, ref.conversationId].filter((k): k is string => k !== undefined);
      if (keys.length > 0) {
        const marks = keys.map(() => "?").join(", ");
        const existing = db.prepare(`SELECT * FROM sessions WHERE runtime = ? AND (runtime_session_id IN (${marks}) OR conversation_id IN (${marks}))
          ORDER BY started_at LIMIT 1`).get(ref.runtime, ...keys, ...keys) as SessionDbRow | undefined;
        if (existing) {
          db.prepare(`UPDATE sessions SET started_at = MIN(started_at, ?), conversation_id = COALESCE(conversation_id, ?),
            runtime_session_id = COALESCE(runtime_session_id, ?), client_name = COALESCE(client_name, ?), cwd = COALESCE(cwd, ?) WHERE id = ?`)
            .run(startedAt, ref.conversationId ?? null, ref.runtimeSessionId ?? null, ref.clientName ?? null, ref.cwd ?? null, existing.id);
          return existing.id;
        }
      }
      const id = randomUUID();
      db.prepare("INSERT INTO sessions (id, runtime, runtime_session_id, conversation_id, client_name, cwd, started_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(id, ref.runtime, ref.runtimeSessionId ?? null, ref.conversationId ?? null, ref.clientName ?? null, ref.cwd ?? null, startedAt);
      return id;
    },

    putLoad(load) {
      db.prepare(`INSERT OR REPLACE INTO loads (load_id, trace_id, uri, manifest_digest, resources_json, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(load.loadId, load.traceId ?? null, load.uri, load.manifestDigest, JSON.stringify(load.resources), ctx.now());
    },

    getLoad(loadId: string) {
      const row = db.prepare("SELECT uri, manifest_digest, resources_json FROM loads WHERE load_id = ?").get(loadId) as
        { uri: string; manifest_digest: string; resources_json: string } | undefined;
      if (!row) return undefined;
      return { uri: row.uri, manifestDigest: row.manifest_digest, resources: parseJson<SkillEntry["resources"]>(row.resources_json, []) };
    },

    latestLoad(uri: SkillUri): string | undefined {
      const row = db.prepare("SELECT load_id FROM loads WHERE uri = ? ORDER BY created_at DESC, rowid DESC LIMIT 1").get(uri) as { load_id: string } | undefined;
      return row?.load_id;
    },

    traceSession(traceId: string): string | undefined {
      const row = db.prepare("SELECT session_id FROM events WHERE trace_id = ? AND session_id != 'unattributed' ORDER BY ts, rowid LIMIT 1").get(traceId) as { session_id: string } | undefined;
      return row?.session_id;
    },

    upsertSkills(entries: SkillEntry[]): void {
      const stmt = db.prepare(`INSERT INTO skills (uri, root_id, name, description, tags_json, when_to_use, examples_json, aliases_ko_json, group_id, group_stage,
          invocation, body_head, digest, manifest_digest, resources_json, mtime_ms, removed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
        ON CONFLICT(uri) DO UPDATE SET root_id = excluded.root_id, name = excluded.name, description = excluded.description, tags_json = excluded.tags_json,
          when_to_use = excluded.when_to_use, examples_json = excluded.examples_json, aliases_ko_json = excluded.aliases_ko_json, group_id = excluded.group_id,
          group_stage = excluded.group_stage, invocation = excluded.invocation, body_head = excluded.body_head, digest = excluded.digest,
          manifest_digest = excluded.manifest_digest, resources_json = excluded.resources_json, mtime_ms = excluded.mtime_ms, removed_at = NULL`);
      db.exec("BEGIN");
      try {
        for (const e of entries) {
          stmt.run(e.uri, e.rootId, e.name, e.description, JSON.stringify(e.tags), e.whenToUse ?? null, JSON.stringify(e.examples), JSON.stringify(e.aliasesKo),
            e.group?.id ?? null, e.group?.stage ?? null, e.invocation, e.bodyHead, e.digest, e.manifestDigest, JSON.stringify(e.resources), e.mtimeMs);
        }
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },

    markRemoved(uris: SkillUri[]): void {
      const stmt = db.prepare("UPDATE skills SET removed_at = ? WHERE uri = ? AND removed_at IS NULL");
      const ts = ctx.now();
      for (const uri of uris) stmt.run(ts, uri);
    },

    countIngest(kind: "accepted" | "rejected" | "dropped", code?: string): void {
      db.prepare(`INSERT INTO meta(key, value) VALUES (?, '1') ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT)`).run(`ingest.${kind}`);
      if (kind !== "accepted" && code !== undefined) setMeta(db, "ingest.lastError", JSON.stringify({ ts: ctx.now(), code }));
    },

    addEvalCase(c: { query: string; expectedUri?: SkillUri; fromTraceId?: string }): void {
      db.prepare("INSERT INTO eval_cases (id, query, expected_uri, from_trace_id, created_at) VALUES (?, ?, ?, ?, ?)")
        .run(randomUUID(), c.query, c.expectedUri ?? null, c.fromTraceId ?? null, ctx.now());
    },

    evalCases() {
      const rows = db.prepare("SELECT query, expected_uri FROM eval_cases ORDER BY created_at, rowid").all() as { query: string; expected_uri: string | null }[];
      return rows.map((r) => (r.expected_uri === null ? { query: r.query } : { query: r.query, expectedUri: r.expected_uri }));
    },

    putSpans(spans: OtelSpanRow[], dropped = 0): number {
      if (spans.length === 0 && dropped === 0) return 0;
      let inserted = 0;
      db.exec("BEGIN IMMEDIATE");
      try {
        for (const s of spans) {
          const result = insertSpan.run(s.traceId, s.spanId, s.parentSpanId ?? null, s.name, s.runtime, s.conversationId ?? null,
            s.turnKey ?? null, s.callId ?? null, s.startMs ?? null, s.endMs ?? null, s.receivedAt);
          inserted += Number(result.changes);
        }
        if (inserted > 0) addIngestCount.run("ingest.accepted", String(inserted), inserted);
        // No error code: a span the join filter rejected is the normal case for a trace batch, not a failure to report.
        if (dropped > 0) addIngestCount.run("ingest.dropped", String(dropped), dropped);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      return inserted;
    },

    retention(days: number): number {
      if (ctx.opts.config && ctx.opts.config.retentionDays === null) return 0;
      const cutoff = ctx.now() - days * DAY_MS;
      const result = db.prepare("UPDATE events SET text = NULL WHERE ts < ? AND text IS NOT NULL").run(cutoff);
      db.prepare("UPDATE sessions SET first_prompt = NULL WHERE started_at < ? AND first_prompt IS NOT NULL").run(cutoff);
      return Number(result.changes);
    },
  };
}
