import type { Db } from "./db.js";
import type { AssignedTreeEvent, ExecutionEventScope, SessionTree, TreePaneLink } from "../types.js";
import { assembleSession } from "../analysis/tree.js";
import { parseJson } from "./writes.js";

export type Execution = {
  readonly id: string; readonly workspace_id: string; readonly tab_id: string | null;
  readonly registered_ms: number | null; readonly ended_ms: number | null;
};

/** Local recording cuts resolve equal timestamps, not the runtime's unrecorded causal order. */
export function executionEventScope(db: Db, flow: Execution, warningSessionIds: readonly string[] = [], includeSpanCut = true): ExecutionEventScope {
  const from = flow.registered_ms ?? 0;
  const to = flow.ended_ms;
  const candidates = executionCandidates(db, flow);
  const sessionIds = JSON.stringify([...new Set(candidates.links.flatMap((link) => link.sessionId === null ? [] : [link.sessionId]))]);
  const candidateIds = JSON.stringify([...new Set([...candidates.links.flatMap((link) => link.sessionId === null ? [] : [link.sessionId]),
    ...warningSessionIds])]);
  const cut = db.prepare(`SELECT start_event_ids_json, end_event_ids_json, end_sessions_json, end_spans_json,
    start_order_domain, start_order, end_order_domain, end_order FROM flows WHERE id = ?`).get(flow.id) as
    { start_event_ids_json: string | null; end_event_ids_json: string | null; end_sessions_json: string | null; end_spans_json: string | null;
      start_order_domain: string | null; start_order: number | null; end_order_domain: string | null; end_order: number | null };
  const startPath = cut.start_order_domain === null ? null : `$."${cut.start_order_domain}"`;
  const endPath = cut.end_order_domain === null ? null : `$."${cut.end_order_domain}"`;
  const startOrder = cut.start_order;
  const rows = db.prepare(`WITH execution_events AS (
    SELECT e.id, e.session_id, e.ts, e.rowid AS recording_order, e.recording_orders_json FROM events e
      WHERE e.session_id IN (SELECT value FROM json_each(?)) AND e.ts BETWEEN ? AND ?
    UNION
    SELECT e.id, e.session_id, e.ts, e.rowid AS recording_order, e.recording_orders_json FROM load_candidates c
      CROSS JOIN events e ON e.id = c.load_id
      WHERE c.session_id IN (SELECT value FROM json_each(?)) AND c.ts BETWEEN ? AND ?
        AND e.kind = 'load' AND e.source = 'mcp'
    ) SELECT id, session_id, ts, json_extract(recording_orders_json, ?) AS start_position,
      json_extract(recording_orders_json, ?) AS end_position FROM execution_events
    ORDER BY ts, recording_order`).all(sessionIds, from, to ?? Number.MAX_SAFE_INTEGER,
      candidateIds, from, to ?? Number.MAX_SAFE_INTEGER, startPath, endPath) as
      { id: string; session_id: string; ts: number; start_position: number | null; end_position: number | null }[];
  const legacyEnds = new Set(parseJson<string[]>(cut.end_event_ids_json, []));
  const owned = rows.filter((row) =>
    (row.ts > from || (cut.start_order !== null && row.start_position !== null && row.start_position > cut.start_order)) &&
    (to === null || row.ts < to || (cut.end_order !== null
      ? row.end_position !== null && row.end_position <= cut.end_order : legacyEnds.has(row.id))));
  let unavailable = cut.start_order === null || (to !== null && cut.end_order === null) ||
    rows.some((row) => (row.ts === from && row.start_position === null) || (row.ts === to && row.end_position === null));
  const spanCut = includeSpanCut && to !== null && cut.end_order !== null
    ? executionBoundarySpans(db, { sessionIds, from, at: to, path: endPath, position: cut.end_order }) : null;
  if (spanCut?.unavailable) unavailable = true;
  const sessionEnds = cut.end_sessions_json === null ? null : parseJson<Record<string, number | null>>(cut.end_sessions_json, {});
  if (sessionEnds !== null && to !== null && cut.end_order !== null) {
    const ends = db.prepare(`SELECT id, json_extract(end_orders_json, ?) AS position FROM sessions
      WHERE id IN (SELECT value FROM json_each(?)) AND ended_at = ?`).all(endPath, sessionIds, to) as
      { id: string; position: number | null }[];
    for (const end of ends) {
      if (Object.hasOwn(sessionEnds, end.id)) continue;
      if (end.position === null) unavailable = true;
      else if (end.position <= cut.end_order) sessionEnds[end.id] = to;
    }
  }
  const activity = new Map<string, { first: number; last: number }>();
  for (const row of owned) {
    const times = activity.get(row.session_id);
    if (times) times.last = row.ts;
    else activity.set(row.session_id, { first: row.ts, last: row.ts });
  }
  const links = candidates.links.flatMap(({ startedAt, ...link }) => {
    if (link.sessionId === null) return [link];
    const times = activity.get(link.sessionId);
    if (!times && !(to === null && startedAt !== null && startedAt > from)) return [];
    if (startedAt === null) return [];
    // Reconciliation can refresh link observations; activity bounds must not drift with those updates.
    return [{ ...link, firstSeenMs: Math.max(from, Math.min(startedAt, times?.first ?? startedAt)),
      lastSeenMs: Math.min(to ?? Number.MAX_SAFE_INTEGER, Math.max(startedAt, times?.last ?? startedAt)) }];
  });
  return { from, to, paneIds: candidates.paneIds, links, eventIds: owned.map((row) => row.id),
    priorEventIds: startOrder === null ? parseJson<string[]>(cut.start_event_ids_json, []) :
      rows.filter((row) => row.ts === from && row.start_position !== null && row.start_position <= startOrder).map((row) => row.id),
    sessionEnds,
    spanKeys: spanCut?.keys ?? (cut.end_spans_json === null ? null :
      parseJson<string[][]>(cut.end_spans_json, []).map((key) => JSON.stringify(key))),
    boundary: unavailable ? "order_unavailable" : "recorded" };
}

/** Derive possible membership before reading events; activity refines it, never defines its query population. */
export function executionCandidates(db: Db, flow: Execution): { paneIds: string[]; links: (TreePaneLink & { startedAt: number | null })[] } {
  const from = flow.registered_ms ?? 0;
  const to = flow.ended_ms ?? Number.MAX_SAFE_INTEGER;
  const paneIds = (db.prepare(`SELECT id, created_ms FROM herdr_panes
    WHERE workspace_id = ? AND (? IS NULL OR tab_id = ?)
      AND COALESCE(created_ms, ?) <= ? AND COALESCE(closed_ms, ?) >= ?
    UNION SELECT fs.pane_id, p.created_ms FROM flow_steps fs LEFT JOIN herdr_panes p ON p.id = fs.pane_id
      WHERE fs.flow_id = ? ORDER BY created_ms, id`)
    .all(flow.workspace_id, flow.tab_id, flow.tab_id, from, to, to, from, flow.id) as { id: string }[]).map((p) => p.id);
  if (!paneIds.length) return { paneIds, links: [] };
  const links = db.prepare(`SELECT ps.pane_id AS paneId, ps.session_id AS sessionId, s.started_at AS startedAt,
      ps.agent_session_value AS agentSessionValue, ps.source,
      MIN(MAX(COALESCE(ps.first_seen_ms, ?), ?), ?) AS firstSeenMs,
      MAX(MIN(COALESCE(ps.last_seen_ms, ?), ?), ?) AS lastSeenMs
    FROM pane_sessions ps LEFT JOIN sessions s ON s.id = ps.session_id
    WHERE ps.pane_id IN (SELECT value FROM json_each(?)) AND (
      ps.session_id IS NOT NULL OR ps.first_seen_ms BETWEEN ? AND ?)
    ORDER BY ps.first_seen_ms, ps.agent_session_value`)
    .all(from, from, to, to, to, from, JSON.stringify(paneIds), from, to) as (TreePaneLink & { startedAt: number | null })[];
  return { paneIds, links };
}

/** Resolve the persisted scalar against eventual members, never snapshot unrelated historical spans. */
function executionBoundarySpans(db: Db, cut: { sessionIds: string; from: number; at: number; path: string | null; position: number }) {
  // An endpoint span can link to an interior event, not only an event at the endpoint.
  const rows = db.prepare(`WITH session AS (
    SELECT id, runtime, runtime_session_id, conversation_id FROM sessions WHERE id IN (SELECT value FROM json_each(?))
  ), matched AS (
    SELECT o.trace_id, o.span_id FROM session s CROSS JOIN otel_spans o
      WHERE o.conversation_id IN (s.runtime_session_id, s.conversation_id) AND o.runtime = s.runtime
    UNION
    SELECT o.trace_id, o.span_id FROM session s JOIN events e ON e.session_id = s.id AND e.ts BETWEEN ? AND ? CROSS JOIN otel_spans o
      WHERE o.call_id = e.call_id AND o.runtime = s.runtime
        AND (o.conversation_id IS NULL OR o.conversation_id IN (s.runtime_session_id, s.conversation_id))
    UNION
    SELECT o.trace_id, o.span_id FROM session s JOIN events e ON e.session_id = s.id AND e.ts BETWEEN ? AND ? CROSS JOIN otel_spans o
      WHERE o.trace_id = json_extract(e.data_json, '$.otelTraceId') AND o.span_id = e.span_id AND o.runtime = s.runtime
        AND (o.conversation_id IS NULL OR o.conversation_id IN (s.runtime_session_id, s.conversation_id))
  ) SELECT o.trace_id, o.span_id, json_extract(o.recording_orders_json, ?) AS position
    FROM matched m JOIN otel_spans o ON o.trace_id = m.trace_id AND o.span_id = m.span_id
    WHERE o.start_ms IS NULL OR o.start_ms = ? ORDER BY o.trace_id, o.span_id`)
    .all(cut.sessionIds, cut.from, cut.at, cut.from, cut.at, cut.path, cut.at) as { trace_id: string; span_id: string; position: number | null }[];
  return { keys: rows.filter((row) => row.position !== null && row.position <= cut.position)
    .map((row) => JSON.stringify([row.trace_id, row.span_id])), unavailable: rows.some((row) => row.position === null) };
}

/** Keep turn identity from the full assembly, but never carry observations across execution boundaries. */
export function scopeSession(session: SessionTree, scope: ExecutionEventScope): SessionTree {
  const { from, to } = scope;
  const end = to ?? Number.MAX_SAFE_INTEGER;
  const owned = new Set(scope.eventIds);
  const inside = (event: { readonly id: string }) => owned.has(event.id);
  const turns = session.turns.flatMap((turn, index) => {
    const events = turn.events.filter(inside);
    if (!events.length) return [];
    const original = new Map(events.map((e) => [e.id, e]));
    const endedAt = Math.min(end, session.turns[index + 1]?.startedAt ?? session.endedAt ?? (to ?? turn.endedAt));
    const startedAt = Math.max(from, turn.startedAt);
    // Reassemble activations from in-window events: the same skill may be activated again in a continuing turn.
    // An internal boundary preserves identity when the real prompt preceded registration; it never leaves here.
    const scoped = assembleSession({ id: session.id, runtime: session.runtime, startedAt, endedAt, spans: [],
      events: [{ id: `execution-boundary:${turn.id}`, ts: startedAt, kind: "prompt", source: "hook",
        turnKey: turn.id, callId: null, spanId: null, skillUri: null, text: null, textLength: null, data: {} },
      ...events.map((e) => ({ ...e, turnKey: turn.id }))] }).turns[0];
    if (!scoped) return [];
    const restore = (event: AssignedTreeEvent): AssignedTreeEvent => {
      const source = original.get(event.id);
      return source ? { ...event, turnKey: source.turnKey, basis: source.basis } : event;
    };
    return [{ ...scoped, basis: turn.basis, events: scoped.events.filter((e) => original.has(e.id)).map(restore),
      skillSpans: scoped.skillSpans.map((span) => ({ ...span, activation: restore(span.activation), events: span.events.map(restore) })) }];
  });
  // An execution end clips analysis, never observed lifecycle. A later session end must not rewrite A.
  const endedAt = session.endedAt !== null && (session.endedAt < end ||
    (session.endedAt === end && scope.sessionEnds?.[session.id] === end)) ? session.endedAt : null;
  return { ...session, endedAt,
    executionWindow: { from, to }, turns, unassignedEvents: session.unassignedEvents.filter(inside) };
}
