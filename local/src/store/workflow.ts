import { randomUUID } from "node:crypto";
import { nameFromUri, parseJson, type StoreCtx } from "./writes.js";
import type { FlowListQuery, FlowListRow, FlowRow, FlowSpecRef, FlowStepRow, PaneUsageRow, Store, WorkflowSpecRow } from "../types.js";
import { specDigest, type WorkflowSpec } from "../workflow/spec.js";

type SpecDbRow = { id: string; name: string; version: number; body_json: string; digest: string; created_ms: number };
type FlowScopeRow = { workspace_id: string | null; tab_id: string | null; registered_ms: number | null; ended_ms: number | null };
type FlowDbRow = {
  id: string; workspace_id: string | null; tab_id: string | null; label: string | null; registered_ms: number | null; ended_ms: number | null;
  spec_id: string | null; spec_name: string | null; spec_version: number | null; spec_digest: string | null; spec_body: string | null; spec_created_ms: number | null;
};

type WorkflowStore = Pick<Store, "putWorkflowSpec" | "workflowSpecs" | "workflowSpecVersions" | "workflowSpec" | "createFlow" | "getFlow"
  | "flowSteps" | "mapFlowStep" | "endFlow" | "flowPaneUsage" | "flowSessionIds" | "listFlows">;

type FlowListDbRow = {
  id: string; kind: "flow" | "workspace"; workspace_id: string; tab_id: string | null; label: string | null;
  order_ms: number; started_ms: number | null; ended_ms: number | null;
  spec_id: string | null; spec_name: string | null; spec_version: number | null;
};

/**
 * Every flow, plus each herdr workspace no flow was registered for, as one list. A workspace with a registered flow
 * is represented by that flow, so one workspace is never listed twice. A flow keeps its own label and falls back to
 * the workspace's; order_ms is the sort and cursor key and stands in 0 for a time herdr never reported.
 */
const FLOW_LIST_ENTRIES = `SELECT f.id AS id, 'flow' AS kind, COALESCE(f.workspace_id, '') AS workspace_id, f.tab_id AS tab_id,
    COALESCE(f.label, w.label) AS label, COALESCE(f.registered_ms, 0) AS order_ms, f.registered_ms AS started_ms, f.ended_ms AS ended_ms,
    s.id AS spec_id, s.name AS spec_name, s.version AS spec_version
  FROM flows f LEFT JOIN workflow_specs s ON s.id = f.spec_id LEFT JOIN herdr_workspaces w ON w.id = f.workspace_id
  UNION ALL
  SELECT w.id, 'workspace', w.id, NULL, w.label, COALESCE(w.created_ms, 0), w.created_ms, w.closed_ms, NULL, NULL, NULL
  FROM herdr_workspaces w WHERE NOT EXISTS (SELECT 1 FROM flows f2 WHERE f2.workspace_id = w.id)`;

const EMPTY_SPEC: WorkflowSpec = { name: "unknown", steps: [] };

function specOf(row: SpecDbRow): WorkflowSpecRow {
  return { id: row.id, name: row.name, version: row.version, digest: row.digest, createdMs: row.created_ms, spec: parseJson<WorkflowSpec>(row.body_json, EMPTY_SPEC) };
}

function flowOf(row: FlowDbRow): FlowRow {
  const spec = row.spec_id !== null && row.spec_name !== null
    ? specOf({ id: row.spec_id, name: row.spec_name, version: row.spec_version ?? 1, body_json: row.spec_body ?? "", digest: row.spec_digest ?? "", created_ms: row.spec_created_ms ?? 0 })
    : undefined;
  return {
    id: row.id, workspaceId: row.workspace_id ?? "", registeredMs: row.registered_ms ?? 0,
    ...(row.tab_id !== null ? { tabId: row.tab_id } : {}),
    ...(row.label !== null ? { label: row.label } : {}),
    ...(row.ended_ms !== null ? { endedMs: row.ended_ms } : {}),
    ...(spec ? { spec } : {}),
  };
}

function skillNameOf(kind: string, skillUri: string | null, data: Record<string, unknown>): string | undefined {
  if (kind === "native_skill" && typeof data.name === "string" && data.name !== "") return data.name;
  const uri = skillUri ?? (typeof data.uri === "string" ? data.uri : undefined);
  return uri === undefined ? undefined : nameFromUri(uri);
}

function toolNameOf(data: Record<string, unknown>): string | undefined {
  const tool = [data.name, data.tool, data.toolName].find((v) => typeof v === "string" && v !== "");
  return typeof tool === "string" ? tool : undefined;
}

const FLOW_COLUMNS = `f.id, f.workspace_id, f.tab_id, f.label, f.registered_ms, f.ended_ms, f.spec_id,
  s.name AS spec_name, s.version AS spec_version, s.digest AS spec_digest, s.body_json AS spec_body, s.created_ms AS spec_created_ms`;

export function createWorkflow(ctx: StoreCtx): WorkflowStore {
  const { db } = ctx;
  const latestOf = db.prepare("SELECT * FROM workflow_specs WHERE name = ? ORDER BY version DESC LIMIT 1");
  const insertSpec = db.prepare("INSERT INTO workflow_specs (id, name, version, body_json, digest, created_ms) VALUES (?, ?, ?, ?, ?, ?)");
  const selectFlow = db.prepare(`SELECT ${FLOW_COLUMNS} FROM flows f LEFT JOIN workflow_specs s ON s.id = f.spec_id WHERE f.id = ?`);
  const selectOpenFlow = db.prepare(`SELECT ${FLOW_COLUMNS} FROM flows f LEFT JOIN workflow_specs s ON s.id = f.spec_id
    WHERE f.workspace_id = ? AND COALESCE(f.tab_id, '') = ? AND f.ended_ms IS NULL ORDER BY f.registered_ms, f.rowid LIMIT 1`);
  const selectFlowScope = db.prepare("SELECT workspace_id, tab_id, registered_ms, ended_ms FROM flows WHERE id = ?");
  // The panes one flow covers: its workspace's panes, narrowed to its tab when it was registered for one - the same
  // scope its report renders - plus every pane an orchestrator mapped to a step, wherever herdr later put it.
  const selectFlowPanes = db.prepare(`SELECT id AS pane_id FROM herdr_panes WHERE workspace_id = ? AND (? IS NULL OR tab_id = ?)
    UNION SELECT pane_id FROM flow_steps WHERE flow_id = ? ORDER BY pane_id`);

  return {
    putWorkflowSpec(spec: WorkflowSpec) {
      const digest = specDigest(spec);
      const latest = latestOf.get(spec.name) as SpecDbRow | undefined;
      if (latest && latest.digest === digest) return { row: specOf(latest), created: false };
      const row: WorkflowSpecRow = { id: randomUUID(), name: spec.name, version: (latest?.version ?? 0) + 1, digest, createdMs: ctx.now(), spec };
      insertSpec.run(row.id, row.name, row.version, JSON.stringify(spec), digest, row.createdMs);
      return { row, created: true };
    },

    workflowSpecs(): WorkflowSpecRow[] {
      const rows = db.prepare(`SELECT s.* FROM workflow_specs s
        JOIN (SELECT name, MAX(version) AS version FROM workflow_specs GROUP BY name) latest
          ON latest.name = s.name AND latest.version = s.version ORDER BY s.name`).all() as SpecDbRow[];
      return rows.map(specOf);
    },

    workflowSpecVersions(name: string): WorkflowSpecRow[] {
      const rows = db.prepare("SELECT * FROM workflow_specs WHERE name = ? ORDER BY version DESC").all(name) as SpecDbRow[];
      return rows.map(specOf);
    },

    workflowSpec(name: string, version?: number): WorkflowSpecRow | undefined {
      const row = version === undefined
        ? (latestOf.get(name) as SpecDbRow | undefined)
        : (db.prepare("SELECT * FROM workflow_specs WHERE name = ? AND version = ?").get(name, version) as SpecDbRow | undefined);
      return row ? specOf(row) : undefined;
    },

    // node:sqlite runs synchronously on the single JS thread, so no second request can insert between the open-flow
    // check and the insert: of two concurrent registrations for one workspace and tab, exactly one creates the flow.
    createFlow(input) {
      const open = selectOpenFlow.get(input.workspaceId, input.tabId ?? "") as FlowDbRow | undefined;
      if (open) return { created: false, conflict: flowOf(open) };
      const id = randomUUID();
      const registeredMs = ctx.now();
      db.prepare("INSERT INTO flows (id, workspace_id, tab_id, spec_id, label, registered_ms) VALUES (?, ?, ?, ?, ?, ?)")
        .run(id, input.workspaceId, input.tabId ?? null, input.specId, input.label ?? null, registeredMs);
      return { created: true, flow: flowOf(selectFlow.get(id) as FlowDbRow) };
    },

    getFlow(id: string): FlowRow | undefined {
      const row = selectFlow.get(id) as FlowDbRow | undefined;
      return row ? flowOf(row) : undefined;
    },

    flowSteps(flowId: string): FlowStepRow[] {
      const rows = db.prepare("SELECT pane_id, step_id, registered_ms FROM flow_steps WHERE flow_id = ? ORDER BY registered_ms, pane_id")
        .all(flowId) as { pane_id: string; step_id: string; registered_ms: number | null }[];
      return rows.map((r) => ({ paneId: r.pane_id, stepId: r.step_id, registeredMs: r.registered_ms ?? 0 }));
    },

    // Re-mapping a pane to another step overwrites the mapping: the orchestrator owns the pane-to-step assignment.
    mapFlowStep(flowId: string, paneId: string, stepId: string): { created: boolean } {
      const existing = db.prepare("SELECT step_id FROM flow_steps WHERE flow_id = ? AND pane_id = ?").get(flowId, paneId) as { step_id: string } | undefined;
      db.prepare(`INSERT INTO flow_steps (flow_id, pane_id, step_id, registered_ms) VALUES (?, ?, ?, ?)
        ON CONFLICT(flow_id, pane_id) DO UPDATE SET step_id = excluded.step_id`).run(flowId, paneId, stepId, ctx.now());
      return { created: existing === undefined };
    },

    /**
     * One page of the flows list, newest first, with the panes and pane-to-session links of each entry. The caller
     * applies its own session filter, so the links are returned as stored (`source` is the herdr link source).
     * Ties on the ordering time are broken by id, which is what the cursor carries, so no entry repeats or is skipped.
     */
    listFlows(q: FlowListQuery): FlowListRow[] {
      const where: string[] = [];
      const params: (string | number)[] = [];
      if (q.from !== undefined) { where.push("order_ms >= ?"); params.push(q.from); }
      if (q.to !== undefined) { where.push("order_ms < ?"); params.push(q.to); }
      if (q.cursor) { where.push("(order_ms < ? OR (order_ms = ? AND id > ?))"); params.push(q.cursor.orderMs, q.cursor.orderMs, q.cursor.id); }
      const limit = Math.max(1, Math.min(1000, Math.floor(q.limit)));
      const rows = db.prepare(`SELECT * FROM (${FLOW_LIST_ENTRIES}) ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
        ORDER BY order_ms DESC, id ASC LIMIT ?`).all(...params, limit) as FlowListDbRow[];
      if (rows.length === 0) return [];
      const workspaceIds = [...new Set(rows.map((r) => r.workspace_id))];
      const paneHoles = workspaceIds.map(() => "?").join(",");
      const panes = db.prepare(`SELECT p.id AS pane_id, p.workspace_id, p.tab_id, p.created_ms FROM herdr_panes p
        WHERE p.workspace_id IN (${paneHoles}) ORDER BY p.created_ms, p.id`).all(...workspaceIds) as
        { pane_id: string; workspace_id: string; tab_id: string | null; created_ms: number | null }[];
      const links = db.prepare(`SELECT ps.pane_id, ps.session_id, ps.source FROM pane_sessions ps
        JOIN herdr_panes p ON p.id = ps.pane_id WHERE p.workspace_id IN (${paneHoles})
        ORDER BY ps.first_seen_ms, ps.agent_session_value`).all(...workspaceIds) as
        { pane_id: string; session_id: string | null; source: string | null }[];
      const flowIds = rows.filter((r) => r.kind === "flow").map((r) => r.id);
      const stepPanes = flowIds.length === 0 ? [] : db.prepare(`SELECT flow_id, pane_id FROM flow_steps
        WHERE flow_id IN (${flowIds.map(() => "?").join(",")}) ORDER BY registered_ms, pane_id`).all(...flowIds) as
        { flow_id: string; pane_id: string }[];
      return rows.map((row) => {
        // A flow registered for one tab covers that tab's panes; a step may also map a pane herdr has not reported yet.
        const paneIds = [...new Set([
          ...panes.filter((p) => p.workspace_id === row.workspace_id && (row.tab_id === null || p.tab_id === row.tab_id)).map((p) => p.pane_id),
          ...stepPanes.filter((s) => s.flow_id === row.id).map((s) => s.pane_id),
        ])];
        const spec: FlowSpecRef | null = row.spec_id !== null && row.spec_name !== null
          ? { id: row.spec_id, name: row.spec_name, version: row.spec_version ?? 1 } : null;
        return { id: row.id, kind: row.kind, workspaceId: row.workspace_id, tabId: row.tab_id, label: row.label,
          orderMs: row.order_ms, startedMs: row.started_ms, endedMs: row.ended_ms, spec, paneIds,
          links: links.filter((l) => paneIds.includes(l.pane_id))
            .map((l) => ({ paneId: l.pane_id, sessionId: l.session_id, source: l.source })) };
      });
    },

    /**
     * Every session that can reach this flow's comparison, which is wider than the tree the report renders: a step
     * can map a pane herdr placed on another tab. The read API classifies this population, so a session it hides
     * cannot credit a step through the comparison.
     */
    flowSessionIds(flowId: string): string[] {
      const flow = selectFlowScope.get(flowId) as FlowScopeRow | undefined;
      if (!flow) return [];
      const panes = selectFlowPanes.all(flow.workspace_id ?? "", flow.tab_id, flow.tab_id, flowId) as { pane_id: string }[];
      if (panes.length === 0) return [];
      const rows = db.prepare(`SELECT DISTINCT session_id FROM pane_sessions
        WHERE pane_id IN (${panes.map(() => "?").join(",")}) AND session_id IS NOT NULL ORDER BY session_id`)
        .all(...panes.map((p) => p.pane_id)) as { session_id: string }[];
      return rows.map((row) => row.session_id);
    },

    endFlow(flowId: string) {
      const row = db.prepare("SELECT ended_ms FROM flows WHERE id = ?").get(flowId) as { ended_ms: number | null } | undefined;
      if (!row) return undefined;
      if (row.ended_ms !== null) return { endedMs: row.ended_ms, alreadyEnded: true };
      const endedMs = ctx.now();
      db.prepare("UPDATE flows SET ended_ms = ? WHERE id = ?").run(endedMs, flowId);
      return { endedMs, alreadyEnded: false };
    },

    /**
     * A skill a session activated before the flow was registered is still in effect for the work inside it, so
     * activations are counted from the session's start, not from the registration. A pane the orchestrator reuses
     * must not inherit finished work, so counting starts after the last flow this pane finished before this one was
     * registered (exclusive, so an event at that end belongs to the earlier flow only). A tool call is a point in
     * time rather than a lasting state, so tool calls count only inside this flow's own window.
     * `excludeSessions` drops named sessions (the read API passes the ones its automated filter left out), so one
     * report never compares against sessions it hid everywhere else.
     */
    flowPaneUsage(flowId: string, opts: { excludeSessions?: readonly string[] } = {}): PaneUsageRow[] {
      const flow = selectFlowScope.get(flowId) as FlowScopeRow | undefined;
      if (!flow) return [];
      const panes = selectFlowPanes.all(flow.workspace_id ?? "", flow.tab_id, flow.tab_id, flowId) as { pane_id: string }[];
      const registeredMs = flow.registered_ms ?? 0;
      const to = flow.ended_ms ?? Number.MAX_SAFE_INTEGER;
      const priorEndOf = db.prepare(`SELECT MAX(f.ended_ms) AS prior_end FROM flows f JOIN flow_steps fs ON fs.flow_id = f.id
        WHERE fs.pane_id = ? AND f.id <> ? AND f.ended_ms IS NOT NULL AND f.ended_ms <= ?`);
      const sessionsOf = db.prepare(`SELECT ps.session_id AS id, s.started_at AS started_at FROM pane_sessions ps
        JOIN sessions s ON s.id = ps.session_id WHERE ps.pane_id = ? ORDER BY s.started_at, ps.session_id`);
      const activations = db.prepare(`SELECT kind, skill_uri, data_json FROM events
        WHERE session_id = ? AND kind IN ('load', 'native_skill') AND ts >= ? AND ts > ? AND ts <= ? ORDER BY ts, rowid`);
      const toolCalls = db.prepare(`SELECT data_json FROM events
        WHERE session_id = ? AND kind = 'tool_call' AND ts >= ? AND ts <= ? ORDER BY ts, rowid`);
      const excluded = new Set(opts.excludeSessions ?? []);
      return panes.map(({ pane_id: paneId }) => {
        const priorEnd = (priorEndOf.get(paneId, flowId, registeredMs) as { prior_end: number | null }).prior_end ?? Number.MIN_SAFE_INTEGER;
        const skills: string[] = [];
        const tools: string[] = [];
        for (const session of sessionsOf.all(paneId) as { id: string; started_at: number }[]) {
          if (excluded.has(session.id)) continue;
          for (const e of activations.all(session.id, session.started_at, priorEnd, to) as { kind: string; skill_uri: string | null; data_json: string }[]) {
            const name = skillNameOf(e.kind, e.skill_uri, parseJson<Record<string, unknown>>(e.data_json, {}));
            if (name !== undefined && !skills.includes(name)) skills.push(name);
          }
          for (const e of toolCalls.all(session.id, registeredMs, to) as { data_json: string }[]) {
            const tool = toolNameOf(parseJson<Record<string, unknown>>(e.data_json, {}));
            if (tool !== undefined && !tools.includes(tool)) tools.push(tool);
          }
        }
        return { paneId, skills, tools };
      });
    },
  };
}
