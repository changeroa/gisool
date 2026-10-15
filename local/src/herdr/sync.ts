import { z } from "zod";
import type { Db } from "../store/db.js";
import { createHerdrClient, type HerdrClient } from "./client.js";

const subscriptions = [
  "workspace.created", "workspace.renamed", "workspace.closed",
  "tab.created", "tab.renamed", "tab.closed",
  "pane.created", "pane.updated", "pane.moved", "pane.closed", "pane.exited", "pane.agent_detected",
] as const;
const workspaceSchema = z.object({ workspace_id: z.string(), label: z.string().nullish(), created_ms: z.number().nullish() });
const tabSchema = z.object({ tab_id: z.string(), workspace_id: z.string(), label: z.string().nullish(), created_ms: z.number().nullish() });
const paneSchema = z.object({
  pane_id: z.string(), workspace_id: z.string(), tab_id: z.string(),
  label: z.string().nullish(), title: z.string().nullish(), cwd: z.string().nullish(),
  created_ms: z.number().nullish(), agent: z.string().nullish(),
  agent_session: z.object({ agent: z.string(), source: z.string(), value: z.string(), kind: z.string() }).nullish().catch(null),
});
const snapshotSchema = z.object({
  type: z.literal("session_snapshot"),
  snapshot: z.object({ workspaces: z.array(workspaceSchema), tabs: z.array(tabSchema), panes: z.array(paneSchema) }),
});
const closedSchema = z.object({ workspace_id: z.string().optional(), tab_id: z.string().optional(), pane_id: z.string().optional() });

export function startHerdrSync(db: Db, opts: { readonly env?: NodeJS.ProcessEnv; readonly log: (message: string) => void }) {
  let stopped = false;
  let revision = 0;
  let connection = 0;
  let ready = false;
  let running: Promise<void> | undefined;
  let again = false;
  const upsertWorkspace = db.prepare(`INSERT INTO herdr_workspaces (id, label, created_ms) VALUES (?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET label = excluded.label, closed_ms = NULL`);
  const upsertTab = db.prepare(`INSERT INTO herdr_tabs (id, workspace_id, label, created_ms) VALUES (?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET workspace_id = excluded.workspace_id, label = excluded.label, closed_ms = NULL`);
  const upsertPane = db.prepare(`INSERT INTO herdr_panes (id, workspace_id, tab_id, label, cwd, created_ms) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET workspace_id = excluded.workspace_id, tab_id = excluded.tab_id,
      label = excluded.label, cwd = excluded.cwd, closed_ms = NULL`);
  const upsertReported = db.prepare(`INSERT INTO pane_sessions
    (pane_id, agent, source, agent_session_value, first_seen_ms, last_seen_ms) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(pane_id, agent_session_value) DO UPDATE SET agent = excluded.agent, source = excluded.source, last_seen_ms = excluded.last_seen_ms`);
  const linkReported = db.prepare(`UPDATE pane_sessions SET session_id = (
    SELECT id FROM sessions WHERE runtime_session_id = pane_sessions.agent_session_value
      OR conversation_id = pane_sessions.agent_session_value ORDER BY started_at, id LIMIT 1)
    WHERE session_id IS NULL AND source LIKE 'herdr:%'`);
  // Only panes without a usable reported identity are eligible for cwd inference.
  const infer = db.prepare(`INSERT INTO pane_sessions
    (pane_id, agent, source, agent_session_value, session_id, first_seen_ms, last_seen_ms)
    SELECT p.id, ?, 'inferred:cwd_time', s.id, s.id, ?, ? FROM herdr_panes p JOIN sessions s ON s.cwd = p.cwd
    WHERE p.id = ? AND p.cwd <> '' AND s.started_at >= p.created_ms AND s.started_at <= COALESCE(p.closed_ms, ?)
    ON CONFLICT(pane_id, agent_session_value) DO UPDATE SET last_seen_ms = excluded.last_seen_ms`);
  // Latest snapshot is retained only to retry linking when ingest creates sessions later.
  let panes: z.infer<typeof paneSchema>[] = [];
  const usable = (pane: z.infer<typeof paneSchema>) => pane.agent_session?.kind === "id" && pane.agent_session.value.trim() !== "";
  const linkSessions = () => {
    if (stopped) return;
    linkReported.run();
    const now = Date.now();
    for (const pane of panes) {
      if (!usable(pane) && pane.cwd) infer.run(pane.agent ?? null, now, now, pane.pane_id, now);
    }
  };
  const applySnapshot = (snapshot: z.infer<typeof snapshotSchema>["snapshot"]) => {
    const now = Date.now();
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const w of snapshot.workspaces) upsertWorkspace.run(w.workspace_id, w.label ?? null, w.created_ms ?? now);
      for (const t of snapshot.tabs) upsertTab.run(t.tab_id, t.workspace_id, t.label ?? null, t.created_ms ?? now);
      for (const p of snapshot.panes) {
        upsertPane.run(p.pane_id, p.workspace_id, p.tab_id, p.label ?? p.title ?? null, p.cwd ?? null, p.created_ms ?? now);
        if (usable(p) && p.agent_session) {
          const source = p.agent_session.source.startsWith("herdr:") ? p.agent_session.source : `herdr:${p.agent_session.source}`;
          upsertReported.run(p.pane_id, p.agent_session.agent, source, p.agent_session.value, now, now);
        }
      }
      // A full snapshot is authoritative: recover closes lost during an outage.
      for (const [table, ids] of [
        ["herdr_workspaces", snapshot.workspaces.map((w) => w.workspace_id)],
        ["herdr_tabs", snapshot.tabs.map((t) => t.tab_id)],
        ["herdr_panes", snapshot.panes.map((p) => p.pane_id)],
      ] as const) {
        const live = new Set(ids);
        const close = db.prepare(`UPDATE ${table} SET closed_ms = ? WHERE id = ? AND closed_ms IS NULL`);
        for (const row of db.prepare(`SELECT id FROM ${table} WHERE closed_ms IS NULL`).all()) {
          if (typeof row.id === "string" && !live.has(row.id)) close.run(now, row.id);
        }
      }
      panes = snapshot.panes;
      linkSessions();
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  };
  const reconcile = (): Promise<void> => {
    if (stopped || !ready) return Promise.resolve();
    if (running) {
      again = true;
      return running;
    }
    const generation = connection;
    running = (async () => {
      do {
        again = false;
        const before = revision;
        const snapshot = snapshotSchema.parse(await client.request("session.snapshot"));
        if (stopped || generation !== connection) return;
        // Do not resurrect a pane from a response overtaken by a close/update event.
        if (before !== revision) again = true;
        else applySnapshot(snapshot.snapshot);
      } while (again && !stopped);
    })().finally(() => { running = undefined; });
    return running;
  };
  const refresh = () => {
    void reconcile().catch((error: unknown) => {
      if (!stopped) opts.log(`herdr reconcile failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  };
  const client: HerdrClient = createHerdrClient({
    ...opts,
    onDisconnect() {
      ready = false;
      connection += 1;
    },
    async onConnect(active) {
      ready = false;
      connection += 1;
      if (running) await running.catch(() => undefined);
      z.object({ type: z.literal("pong") }).parse(await active.request("ping"));
      z.object({ type: z.literal("subscription_started") }).parse(await active.request("events.subscribe", {
        subscriptions: subscriptions.map((type) => ({ type })),
      }));
      ready = true;
      await reconcile();
    },
    onEvent(event, data) {
      if (stopped) return;
      revision += 1;
      const parsed = closedSchema.safeParse(data);
      if (parsed.success) {
        const { workspace_id: workspace, tab_id: tab, pane_id: pane } = parsed.data;
        const now = Date.now();
        switch (event) {
          case "workspace_closed":
            if (workspace) {
              db.prepare("UPDATE herdr_workspaces SET closed_ms = ? WHERE id = ?").run(now, workspace);
              db.prepare("UPDATE herdr_tabs SET closed_ms = ? WHERE workspace_id = ?").run(now, workspace);
              db.prepare("UPDATE herdr_panes SET closed_ms = ? WHERE workspace_id = ?").run(now, workspace);
            }
            break;
          case "tab_closed":
            if (tab) {
              db.prepare("UPDATE herdr_tabs SET closed_ms = ? WHERE id = ?").run(now, tab);
              db.prepare("UPDATE herdr_panes SET closed_ms = ? WHERE tab_id = ?").run(now, tab);
            }
            break;
          case "pane_closed":
          case "pane_exited":
            if (pane) db.prepare("UPDATE herdr_panes SET closed_ms = ? WHERE id = ?").run(now, pane);
            break;
        }
      }
      refresh();
    },
  });
  const interval = setInterval(refresh, 30_000);
  interval.unref();
  return {
    reconcile,
    linkSessions,
    close() {
      stopped = true;
      clearInterval(interval);
      client.close();
    },
  };
}
