import type { Express, Request, Response } from "express";
import { aggregateFindings, analyzeSession, loadedDigests } from "../analysis/finding.js";
import { flowTree, sessionTree } from "../analysis/tree.js";
import { aggregateUsage, rangeUsage, sessionUsage } from "../analysis/usage.js";
import type { AutomatedMode, ExcludedSession, FlowListEntry, FlowListRow, FlowTree, SessionFindingDto, SessionTree,
  SessionFinding, Store, TurnFinding } from "../types.js";
import { compareFlow } from "../workflow/compare.js";
import { deny } from "./security.js";
import { scopeFlowTree } from "../store/execution.js";

/**
 * Read APIs over the analysis modules: the flows list, one flow report, one session's skill report and skill usage
 * over a time range. Nothing is computed in the background: every response is assembled from stored rows on read,
 * carries `generatedAt`, and reports an unknown as null rather than 0.
 */
export type FlowRouteDeps = { store: Store; log: (msg: string) => void };

/** A herdr workspace with no registered flow is addressed as `ws:<workspaceId>`, a registered flow by its own id. */
export const WORKSPACE_PREFIX = "ws:";
const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 20;
const MAX_DETAIL = 100;
const DEFAULT_DETAIL = 20;
const DAY_MS = 86_400_000;
const DEFAULT_RANGE_DAYS = 7;
// /api/skills/usage analyses every session of its range, so the range itself is what bounds the work.
const MAX_RANGE_DAYS = 366;

class BadQuery extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

function handle(log: (msg: string) => void, fn: (req: Request, res: Response) => void) {
  return (req: Request, res: Response) => {
    try {
      fn(req, res);
    } catch (error) {
      if (error instanceof BadQuery) return deny(res, 400, error.code, { message: error.message });
      log(`${req.method} ${req.path} failed: ${(error as Error).stack ?? String(error)}`);
      deny(res, 500, "internal_error");
    }
  };
}

function one(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value.map(String).join(",") : String(value);
}

function intOf(q: Request["query"], key: string, range?: [number, number]): number | undefined {
  const raw = one(q[key]);
  if (raw === undefined || raw === "") return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || (range && (n < range[0] || n > range[1]))) {
    throw new BadQuery("bad_filter", `${key} must be an integer${range ? ` in ${range[0]}..${range[1]}` : ""}`);
  }
  return n;
}

function automatedOf(q: Request["query"]): AutomatedMode {
  const raw = one(q.automated);
  if (raw === undefined || raw === "") return "exclude";
  if (raw !== "include" && raw !== "only") throw new BadQuery("bad_filter", "automated must be include or only");
  return raw;
}

/** from/to are milliseconds, half-open [from, to), as everywhere else in the API. */
function rangeOf(q: Request["query"], now: number): { from: number; to: number } {
  const to = intOf(q, "to") ?? now;
  const from = intOf(q, "from") ?? to - DEFAULT_RANGE_DAYS * DAY_MS;
  if (from > to) throw new BadQuery("bad_filter", "from must not be after to");
  if (to - from > MAX_RANGE_DAYS * DAY_MS) throw new BadQuery("bad_filter", `the range must not exceed ${MAX_RANGE_DAYS} days`);
  return { from, to };
}

/** Opaque to callers, and tied to the sort key: the ordering time plus the id that breaks its ties. */
function encodeCursor(row: { orderMs: number; id: string }): string {
  return Buffer.from(`${row.orderMs}:${row.id}`, "utf8").toString("base64url");
}

function decodeCursor(raw: string | undefined): { orderMs: number; id: string } | undefined {
  if (raw === undefined || raw === "") return undefined;
  const text = Buffer.from(raw, "base64url").toString("utf8");
  const cut = text.indexOf(":");
  const orderMs = cut > 0 ? Number(text.slice(0, cut)) : Number.NaN;
  const id = cut > 0 ? text.slice(cut + 1) : "";
  if (!Number.isInteger(orderMs) || id === "") throw new BadQuery("bad_cursor", "cursor is not one this endpoint issued");
  return { orderMs, id };
}

function keepSession(sessionId: string, automation: Record<string, string>, mode: AutomatedMode): boolean {
  if (mode === "include") return true;
  const automated = automation[sessionId] !== undefined;
  return mode === "only" ? automated : !automated;
}

function entryOf(row: FlowListRow, automation: Record<string, string>, mode: AutomatedMode): FlowListEntry {
  const links = row.links.filter((link) => link.sessionId === null || keepSession(link.sessionId, automation, mode));
  const sessionIds = [...new Set(links.flatMap((link) => (link.sessionId === null ? [] : [link.sessionId])))];
  let reported = 0;
  let inferred = 0;
  let unlinked = 0;
  for (const link of links) {
    if (link.sessionId === null || link.source === "unlinked") unlinked += 1;
    else if (link.source === "inferred:cwd_time") inferred += 1;
    else reported += 1;
  }
  return {
    id: row.kind === "workspace" ? `${WORKSPACE_PREFIX}${row.workspaceId}` : row.id,
    kind: row.kind, workspaceId: row.workspaceId, tabId: row.tabId, label: row.label, registered: row.kind === "flow",
    spec: row.spec, startedMs: row.startedMs, endedMs: row.endedMs,
    paneIds: row.paneIds, sessionIds,
    counts: { panes: row.paneIds.length, sessions: sessionIds.length },
    attribution: { reported, inferred, unlinked },
  };
}

/** The finding of one session under the API's names: `loadedSkills` is `usedSkills`, native activations included. */
function findingDto(finding: SessionFinding): SessionFindingDto {
  return {
    sessionId: finding.sessionId,
    turns: finding.turns.map(({ loadedSkills, ...turn }: TurnFinding) => ({ ...turn, usedSkills: loadedSkills })),
    aggregate: finding.aggregate,
  };
}

function sessionIdsOf(tree: FlowTree): string[] {
  return tree.tabs.flatMap((tab) => tab.panes.flatMap((pane) => pane.sessions.flatMap((link) => (link.sessionId === null ? [] : [link.sessionId]))));
}

/** Drops the links to sessions the automated filter excludes; the pane stays, and the report says what was left out. */
function filterTree(tree: FlowTree, automation: Record<string, string>, mode: AutomatedMode): { tree: FlowTree; excluded: Map<string, ExcludedSession> } {
  const excluded = new Map<string, ExcludedSession>();
  const tabs = tree.tabs.map((tab) => ({
    ...tab,
    panes: tab.panes.map((pane) => ({
      ...pane,
      sessions: pane.sessions.filter((link) => {
        if (link.sessionId === null || keepSession(link.sessionId, automation, mode)) return true;
        excluded.set(link.sessionId, { sessionId: link.sessionId, reason: automation[link.sessionId] ?? "not_automated" });
        return false;
      }),
    })),
  }));
  return { tree: { ...tree, tabs }, excluded };
}

function sessionsOf(tree: FlowTree): SessionTree[] {
  const sessions = new Map<string, SessionTree>((tree.sessions ?? []).map((session) => [session.id, session]));
  for (const tab of tree.tabs) {
    for (const pane of tab.panes) {
      for (const link of pane.sessions) if (link.session !== null) sessions.set(link.session.id, link.session);
    }
  }
  return [...sessions.values()];
}

export function registerFlowRoutes(app: Express, deps: FlowRouteDeps): void {
  const { store, log } = deps;

  /**
   * Registered flows and the herdr workspaces without one, newest first. The page is bounded by `limit`, so the
   * optional from/to filter the ordering time rather than capping the work.
   */
  app.get("/api/flows", handle(log, (req, res) => {
    const automated = automatedOf(req.query);
    const limit = intOf(req.query, "limit", [1, MAX_LIMIT]) ?? DEFAULT_LIMIT;
    const from = intOf(req.query, "from");
    const to = intOf(req.query, "to");
    if (from !== undefined && to !== undefined && from > to) throw new BadQuery("bad_filter", "from must not be after to");
    const cursor = decodeCursor(one(req.query.cursor));
    // One row beyond the page says whether a next page exists, without counting the whole list.
    const rows = store.listFlows({ limit: limit + 1, automated, ...(from !== undefined ? { from } : {}), ...(to !== undefined ? { to } : {}), ...(cursor ? { cursor } : {}) });
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    const automation = store.sessionAutomation(page.flatMap((row) => row.links.flatMap((link) => (link.sessionId === null ? [] : [link.sessionId]))));
    res.json({
      generatedAt: Date.now(), from: from ?? null, to: to ?? null, limit, automated,
      flows: page.map((row) => entryOf(row, automation, automated)),
      nextCursor: rows.length > limit && last ? encodeCursor(last) : null,
    });
  }));

  /** One flow: the tree (todo 6), per-turn finding (7), per-span usage (8) and the spec comparison (9). */
  app.get("/api/flows/:id", handle(log, (req, res) => {
    store.reconcileLoads();
    const automated = automatedOf(req.query);
    const ref = String(req.params.id);
    const id = ref.startsWith(WORKSPACE_PREFIX) ? ref.slice(WORKSPACE_PREFIX.length) : ref;
    let full: FlowTree | undefined;
    if (ref === "outside") {
      const to = intOf(req.query, "to") ?? Date.now() + 1;
      const from = intOf(req.query, "from") ?? to - DEFAULT_RANGE_DAYS * DAY_MS;
      if (from > to) throw new BadQuery("bad_filter", "from must not be after to");
      const limit = intOf(req.query, "limit", [1, MAX_LIMIT]) ?? MAX_LIMIT;
      full = { id: "outside", workspaceId: "", label: "outside herdr", registered: false, tabs: [],
        sessions: store.outsideHerdrSessions({ from, to, limit, automated }).flatMap(({ id: sessionId }) => {
          const session = sessionTree(store, sessionId);
          return session ? [session] : [];
        }) };
    } else {
      full = flowTree(store, id);
    }
    if (!full) return deny(res, 404, "flow_not_found", { message: `no flow or herdr workspace ${ref}` });
    // Classify the shared execution population, including explicitly mapped panes on other tabs.
    const comparisonSessionIds = full.registered ? store.flowSessionIds(full.id) : [];
    const automation = store.sessionAutomation([...sessionIdsOf(full), ...comparisonSessionIds]);
    const flow = full.registered ? store.getFlow(full.id) : undefined;
    const overlaps = flow ? sessionsOf(full).map((session) => ({
      sessionId: session.id, startedBefore: session.startedAt < flow.registeredMs,
      continuesAfter: flow.endedMs !== undefined && (session.endedAt === null || session.endedAt > flow.endedMs),
    })).filter((session) => session.startedBefore || session.continuesAfter) : [];
    const scoped = flow ? scopeFlowTree(full, flow.registeredMs, flow.endedMs) : full;
    const { tree, excluded } = filterTree(scoped, automation, automated);
    for (const sessionId of comparisonSessionIds) {
      if (keepSession(sessionId, automation, automated)) continue;
      excluded.set(sessionId, { sessionId, reason: automation[sessionId] ?? "not_automated" });
    }
    const sessions = sessionsOf(tree);
    const digestOf = loadedDigests(store);
    const findings = sessions.map((session) => analyzeSession(session, digestOf));
    const usages = sessions.map((session) => sessionUsage(session));
    const spec = flow?.spec;
    const unattributedLoads = store.reconcileLoads({
      from: flow?.registeredMs ?? (ref === "outside" ? intOf(req.query, "from") ?? Date.now() - DEFAULT_RANGE_DAYS * DAY_MS
        : Math.min(...sessions.map((session) => session.startedAt))),
      // Execution trees include the end timestamp; reconcileLoads uses an exclusive upper bound.
      to: flow?.endedMs !== undefined ? flow.endedMs + 1
        : (ref === "outside" ? intOf(req.query, "to") ?? Date.now() + 1 : Date.now() + 1),
      sessionIds: [...sessions.map((session) => session.id), ...comparisonSessionIds.filter((id) => !excluded.has(id))],
    });
    res.json({
      generatedAt: Date.now(),
      id: ref === "outside" ? "outside" : tree.registered ? tree.id : `${WORKSPACE_PREFIX}${tree.workspaceId}`,
      kind: ref === "outside" ? "outside_herdr" : tree.registered ? "flow" : "workspace",
      workspaceId: tree.workspaceId, label: tree.label, registered: tree.registered,
      flow: flow ? { registeredMs: flow.registeredMs, endedMs: flow.endedMs ?? null, tabId: flow.tabId ?? null } : null,
      spec: spec ? { id: spec.id, name: spec.name, version: spec.version } : null,
      automated, tree,
      executionScope: flow ? { from: flow.registeredMs, to: flow.endedMs ?? null, boundary: "inclusive",
        overlaps: overlaps.filter((session) => keepSession(session.sessionId, automation, automated)),
        label: "Events restricted to this execution; continuing sessions are split by event time" } : null,
      finding: { id: tree.id, sessions: findings.map(findingDto), aggregate: aggregateFindings(findings.flatMap((f) => f.turns)) },
      usage: { id: tree.id, sessions: usages, skills: aggregateUsage(usages.flatMap((u) => u.spans)) },
      comparison: tree.registered ? compareFlow(store, tree.id, { excludeSessions: [...excluded.keys()] }) ?? null : null,
      excludedSessions: [...excluded.values()],
      unattributedLoads,
    });
  }));

  /** The same finding and usage analysis for one session, whether or not herdr knows a pane for it. */
  app.get("/api/sessions/:id/skill-report", handle(log, (req, res) => {
    const automated = automatedOf(req.query);
    const id = String(req.params.id);
    const unattributedLoads = store.reconcileLoads({ sessionIds: [id] });
    const tree = sessionTree(store, id);
    if (!tree) return deny(res, 404, "session_not_found", { message: `no session ${id}` });
    const automation = store.sessionAutomation([id])[id];
    if (!keepSession(id, automation === undefined ? {} : { [id]: automation }, automated)) {
      return deny(res, 404, "automated_excluded", {
        message: automated === "only"
          ? `session ${id} was not automated; drop automated=only to read it`
          : `session ${id} was automated (${automation}); pass automated=include to read it`,
        automated: automation ?? null,
      });
    }
    res.json({
      generatedAt: Date.now(), sessionId: tree.id, runtime: tree.runtime, startedAt: tree.startedAt, endedAt: tree.endedAt,
      automated: automation ?? null, tree,
      finding: findingDto(analyzeSession(tree, loadedDigests(store))), usage: sessionUsage(tree),
      unattributedLoads,
    });
  }));

  /** Per-skill usage over a time range; `sessions` is the detail list `detail` bounds, `skills` covers them all. */
  app.get("/api/skills/usage", handle(log, (req, res) => {
    const automated = automatedOf(req.query);
    const { from, to } = rangeOf(req.query, Date.now());
    const detailLimit = intOf(req.query, "detail", [0, MAX_DETAIL]) ?? DEFAULT_DETAIL;
    const usage = rangeUsage(store, { from, to, detailLimit, ...(automated === "exclude" ? {} : { automated }) });
    res.json({
      generatedAt: Date.now(), from, to, automated, detailLimit,
      sessionCount: usage.sessionCount, truncated: usage.truncated, skills: usage.skills, sessions: usage.sessions,
    });
  }));
}
