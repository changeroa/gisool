import type { Db } from "./db.js";
import type { AssignedTreeEvent, ExecutionEventScope, SessionTree, TreePaneLink } from "../types.js";
import { assembleSession } from "../analysis/tree.js";
import { parseJson } from "./writes.js";

export type Execution = {
  readonly id: string; readonly workspace_id: string; readonly tab_id: string | null;
  readonly registered_ms: number | null; readonly ended_ms: number | null;
};

/** Local recording cuts resolve equal timestamps, not the runtime's unrecorded causal order. */
export function executionEventScope(db: Db, flow: Execution): ExecutionEventScope {
  const from = flow.registered_ms ?? 0;
  const to = flow.ended_ms;
  const cut = db.prepare("SELECT start_event_ids_json, end_event_ids_json, end_sessions_json, end_spans_json FROM flows WHERE id = ?").get(flow.id) as
    { start_event_ids_json: string | null; end_event_ids_json: string | null; end_sessions_json: string | null; end_spans_json: string | null };
  const rows = db.prepare(`SELECT id FROM events WHERE ts >= ? AND (? IS NULL OR ts <= ?)
    AND (ts > ? OR (? IS NOT NULL AND id NOT IN (SELECT value FROM json_each(?))))
    AND (? IS NULL OR ts < ? OR (? IS NOT NULL AND id IN (SELECT value FROM json_each(?))))
    ORDER BY ts, rowid`).all(from, to, to, from, cut.start_event_ids_json, cut.start_event_ids_json,
      to, to, cut.end_event_ids_json, cut.end_event_ids_json) as { id: string }[];
  return { from, to, eventIds: rows.map((row) => row.id),
    priorEventIds: cut.start_event_ids_json === null ? [] : parseJson<string[]>(cut.start_event_ids_json, []),
    sessionEnds: cut.end_sessions_json === null ? null : parseJson<Record<string, number | null>>(cut.end_sessions_json, {}),
    spanKeys: cut.end_spans_json === null ? null : parseJson<string[][]>(cut.end_spans_json, []).map((key) => JSON.stringify(key)),
    boundary: cut.start_event_ids_json === null || (to !== null && cut.end_event_ids_json === null)
      ? "order_unavailable" : "recorded" };
}

/** Membership is activity in the execution, not the lifetime of a pane or an unclosed session. */
export function executionMembers(db: Db, flow: Execution): { paneIds: string[]; links: TreePaneLink[] } {
  const from = flow.registered_ms ?? 0;
  const to = flow.ended_ms ?? Number.MAX_SAFE_INTEGER;
  const eventIds = JSON.stringify(executionEventScope(db, flow).eventIds);
  const paneIds = (db.prepare(`SELECT id, created_ms FROM herdr_panes
    WHERE workspace_id = ? AND (? IS NULL OR tab_id = ?)
      AND COALESCE(created_ms, ?) <= ? AND COALESCE(closed_ms, ?) >= ?
    UNION SELECT fs.pane_id, p.created_ms FROM flow_steps fs LEFT JOIN herdr_panes p ON p.id = fs.pane_id
      WHERE fs.flow_id = ? ORDER BY created_ms, id`)
    .all(flow.workspace_id, flow.tab_id, flow.tab_id, from, to, to, from, flow.id) as { id: string }[]).map((p) => p.id);
  if (!paneIds.length) return { paneIds, links: [] };
  const links = db.prepare(`SELECT ps.pane_id AS paneId, ps.session_id AS sessionId,
      ps.agent_session_value AS agentSessionValue, ps.source,
      MIN(MAX(COALESCE(ps.first_seen_ms, ?), ?), ?) AS firstSeenMs,
      MAX(MIN(COALESCE(ps.last_seen_ms, ?), ?), ?) AS lastSeenMs
    FROM pane_sessions ps LEFT JOIN sessions s ON s.id = ps.session_id
    WHERE ps.pane_id IN (${paneIds.map(() => "?").join(",")}) AND (
      (ps.session_id IS NULL AND ps.first_seen_ms BETWEEN ? AND ?)
      OR (s.started_at > ? AND s.started_at < ? AND ?)
      OR EXISTS (SELECT 1 FROM events e WHERE e.session_id = s.id AND e.id IN (SELECT value FROM json_each(?))))
    ORDER BY ps.first_seen_ms, ps.agent_session_value`)
    .all(from, from, to, to, to, from, ...paneIds, from, to, from, to, flow.ended_ms === null ? 1 : 0, eventIds) as TreePaneLink[];
  const activity = db.prepare(`SELECT s.started_at, MIN(e.ts) AS first, MAX(e.ts) AS last FROM sessions s
    LEFT JOIN events e ON e.session_id = s.id AND e.id IN (SELECT value FROM json_each(?)) WHERE s.id = ? GROUP BY s.id`);
  return { paneIds, links: links.map((link) => {
    if (link.sessionId === null) return link;
    const row = activity.get(eventIds, link.sessionId) as { started_at: number; first: number | null; last: number | null };
    // Reconciliation refreshes observation times even for historical links. Event bounds do not drift with it.
    return { ...link, firstSeenMs: Math.max(from, Math.min(row.started_at, row.first ?? row.started_at)),
      lastSeenMs: Math.min(to, Math.max(row.started_at, row.last ?? row.started_at)) };
  }) };
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
