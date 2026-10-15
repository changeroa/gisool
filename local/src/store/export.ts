import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { DEFAULT_ROOTS, expandHome } from "../config.js";
import { parseJson, readAliasesOverrides, storeError, writeAliasesOverrides, type StoreCtx } from "./writes.js";
import type { Store } from "../types.js";

export const EXPORT_FILE = "gisool-export.json";
export const HISTORY_FILE = "history.db";
/**
 * Tables that export --with-history carries, in foreign-key order, each with the columns identifying a row.
 * A table or column missing on either side (importing a v1 history.db into a v2 store) is simply not copied.
 */
const HISTORY_TABLES: Record<string, string[]> = {
  sessions: ["id"],
  events: ["id"],
  loads: ["load_id"],
  otel_spans: ["trace_id", "span_id"],
  herdr_workspaces: ["id"],
  herdr_tabs: ["id"],
  herdr_panes: ["id"],
  pane_sessions: ["pane_id", "agent_session_value"],
  workflow_specs: ["id"],
  flows: ["id"],
  flow_steps: ["flow_id", "pane_id"],
};
const HISTORY_VERSIONS = [1, 2];

type ExportedEvalCase = { query: string; expectedUri?: string; fromTraceId?: string };
export type ExportDoc = { version: 1; config: Record<string, unknown>; roots: { id: string; path: string }[]; evalCases: ExportedEvalCase[];
  aliasesOverrides: Record<string, string[]> };

export type ImportDetails = {
  evalCases: { added: number; skipped: number };
  roots: { added: string[]; skipped: string[] };
  configKeys: { added: string[]; kept: string[] };
  aliases: { added: string[]; skipped: string[] };
  history: { tables: Record<string, number>; skipped: number } | null;
};
export type ImportResult = { added: number; skipped: number; details: ImportDetails };

function tildify(path: string, home: string): string {
  const h = home.replace(/\/+$/, "");
  if (path === h) return "~";
  if (path.startsWith(h + "/")) return "~/" + path.slice(h.length + 1);
  return path;
}

function readConfigFile(gisoolHome: string | undefined): Record<string, unknown> | undefined {
  if (!gisoolHome) return undefined;
  const p = join(gisoolHome, "config.json");
  return existsSync(p) ? parseJson<Record<string, unknown>>(readFileSync(p, "utf8"), {}) : undefined;
}

type Portable = Pick<Store, "exportTo"> & { importFrom(dir: string, opts: { merge: boolean }): ImportResult };

export function createPortable(ctx: StoreCtx): Portable {
  const { db } = ctx;
  const home = () => ctx.opts.home ?? homedir();

  function existingEvalKeys(): Set<string> {
    const rows = db.prepare("SELECT query, expected_uri FROM eval_cases").all() as { query: string; expected_uri: string | null }[];
    return new Set(rows.map((r) => JSON.stringify([r.query, r.expected_uri])));
  }

  function columnsOf(schema: "main" | "hist", table: string): string[] {
    return (db.prepare(`PRAGMA ${schema}.table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
  }

  function historyShape(): { table: string; key: string[]; columns: string[] }[] {
    const shape: { table: string; key: string[]; columns: string[] }[] = [];
    for (const [table, key] of Object.entries(HISTORY_TABLES)) {
      const mine = new Set(columnsOf("main", table));
      const columns = columnsOf("hist", table).filter((c) => mine.has(c));
      if (key.every((k) => columns.includes(k))) shape.push({ table, key, columns });
    }
    return shape;
  }

  const keyIn = (table: string, key: string[]) =>
    `${key.length === 1 ? key[0]! : `(${key.join(", ")})`} IN (SELECT ${key.join(", ")} FROM main.${table})`;

  function historyPlan(): { tables: Record<string, number>; skipped: number } {
    const tables: Record<string, number> = {};
    let skipped = 0;
    for (const { table, key } of historyShape()) {
      const row = db.prepare(`SELECT SUM(CASE WHEN ${keyIn(table, key)} THEN 0 ELSE 1 END) AS fresh, COUNT(*) AS total FROM hist.${table}`).get() as
        { fresh: number | null; total: number };
      tables[table] = row.fresh ?? 0;
      skipped += row.total - (row.fresh ?? 0);
    }
    return { tables, skipped };
  }

  function copyHistory(): void {
    for (const { table, key, columns } of historyShape()) {
      const cols = columns.join(", ");
      db.prepare(`INSERT INTO main.${table} (${cols}) SELECT ${cols} FROM hist.${table} WHERE NOT ${keyIn(table, key)}`).run();
    }
  }

  return {
    exportTo(dir: string, opts: { withHistory: boolean }): void {
      mkdirSync(dir, { recursive: true });
      const raw = readConfigFile(ctx.opts.gisoolHome);
      const source: Record<string, unknown> = raw ?? (ctx.opts.config ? { ...ctx.opts.config } : {});
      const { token: _token, roots: rawRoots, ...config } = source;
      void _token;
      const roots = (Array.isArray(rawRoots) ? (rawRoots as { id: string; path: string }[]) : [])
        .map((r) => ({ id: r.id, path: tildify(r.path, home()) }));
      const evalRows = db.prepare("SELECT query, expected_uri, from_trace_id FROM eval_cases ORDER BY created_at, rowid").all() as
        { query: string; expected_uri: string | null; from_trace_id: string | null }[];
      const doc: ExportDoc = {
        version: 1,
        config,
        roots,
        evalCases: evalRows.map((r) => ({ query: r.query, ...(r.expected_uri !== null ? { expectedUri: r.expected_uri } : {}),
          ...(r.from_trace_id !== null ? { fromTraceId: r.from_trace_id } : {}) })),
        aliasesOverrides: readAliasesOverrides(db),
      };
      const out = join(dir, EXPORT_FILE);
      writeFileSync(out, JSON.stringify(doc, null, 2) + "\n", { mode: 0o600 });
      chmodSync(out, 0o600);
      const history = join(dir, HISTORY_FILE);
      rmSync(history, { force: true });
      if (opts.withHistory) {
        db.prepare("VACUUM INTO ?").run(resolve(history));
        chmodSync(history, 0o600);
      }
    },

    importFrom(dir: string, opts: { merge: boolean }): ImportResult {
      const file = join(dir, EXPORT_FILE);
      if (!existsSync(file)) throw storeError("no_export_found", `no ${EXPORT_FILE} in ${dir}`);
      const doc = parseJson<Partial<ExportDoc> & { version?: unknown }>(readFileSync(file, "utf8"), {});
      if (doc.version !== 1) throw storeError("unsupported_export_version", `unsupported export version: ${String(doc.version)}`);
      const apply = opts.merge;

      const evalKeys = existingEvalKeys();
      const evalToAdd: ExportedEvalCase[] = [];
      let evalSkipped = 0;
      for (const c of doc.evalCases ?? []) {
        const key = JSON.stringify([c.query, c.expectedUri ?? null]);
        if (evalKeys.has(key)) evalSkipped++;
        else { evalKeys.add(key); evalToAdd.push(c); }
      }

      const currentAliases = readAliasesOverrides(db);
      const aliasAdded = Object.keys(doc.aliasesOverrides ?? {}).filter((k) => !(k in currentAliases));
      const aliasSkipped = Object.keys(doc.aliasesOverrides ?? {}).filter((k) => k in currentAliases);

      const gisoolHome = ctx.opts.gisoolHome;
      const existingRaw = readConfigFile(gisoolHome);
      const configBase: Record<string, unknown> = existingRaw ?? {};
      const existingRoots = (Array.isArray(configBase.roots) ? configBase.roots : existingRaw ? [] : DEFAULT_ROOTS) as { id: string; path: string }[];
      const rootsAdded: { id: string; path: string }[] = [];
      const rootsSkipped: string[] = [];
      const configAdded: string[] = [];
      const configKept: string[] = [];
      if (gisoolHome) {
        const knownPaths = new Set(existingRoots.map((r) => expandHome(r.path, home())));
        const knownIds = new Set(existingRoots.map((r) => r.id));
        for (const r of doc.roots ?? []) {
          const expanded = expandHome(r.path, home());
          if (knownIds.has(r.id) || knownPaths.has(expanded)) rootsSkipped.push(r.id);
          else { rootsAdded.push({ id: r.id, path: tildify(expanded, home()) }); knownIds.add(r.id); knownPaths.add(expanded); }
        }
        for (const k of Object.keys(doc.config ?? {})) {
          if (k === "token" || k === "roots") continue;
          if (k in configBase) configKept.push(k); else configAdded.push(k);
        }
      }

      const historyPath = join(dir, HISTORY_FILE);
      let history: ImportDetails["history"] = null;
      const hasHistory = existsSync(historyPath);
      if (hasHistory) {
        db.prepare("ATTACH DATABASE ? AS hist").run(resolve(historyPath));
        try {
          const version = (db.prepare("PRAGMA hist.user_version").get() as { user_version: number }).user_version;
          if (!HISTORY_VERSIONS.includes(version)) throw storeError("unsupported_history_version", `history.db user_version ${version}`);
          history = historyPlan();
          if (apply) {
            db.exec("BEGIN IMMEDIATE");
            try {
              copyHistory();
              db.exec("COMMIT");
            } catch (error) {
              db.exec("ROLLBACK");
              throw error;
            }
          }
        } finally {
          db.exec("DETACH DATABASE hist");
        }
      }

      if (apply) {
        const insert = db.prepare("INSERT INTO eval_cases (id, query, expected_uri, from_trace_id, created_at) VALUES (lower(hex(randomblob(16))), ?, ?, ?, ?)");
        db.exec("BEGIN IMMEDIATE");
        try {
          for (const c of evalToAdd) insert.run(c.query, c.expectedUri ?? null, c.fromTraceId ?? null, ctx.now());
          if (aliasAdded.length > 0) {
            const next = { ...currentAliases };
            for (const k of aliasAdded) next[k] = doc.aliasesOverrides![k]!;
            writeAliasesOverrides(db, next);
          }
          db.exec("COMMIT");
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
        if (gisoolHome && (rootsAdded.length > 0 || configAdded.length > 0)) {
          const next: Record<string, unknown> = { ...configBase };
          for (const k of configAdded) next[k] = doc.config![k];
          next.roots = [...existingRoots, ...rootsAdded];
          mkdirSync(gisoolHome, { recursive: true, mode: 0o700 });
          const p = join(gisoolHome, "config.json");
          writeFileSync(p, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
          chmodSync(p, 0o600);
        }
      }

      const historyAdded = history ? Object.values(history.tables).reduce((sum, n) => sum + n, 0) : 0;
      return {
        added: evalToAdd.length + rootsAdded.length + configAdded.length + aliasAdded.length + historyAdded,
        skipped: evalSkipped + rootsSkipped.length + configKept.length + aliasSkipped.length + (history?.skipped ?? 0),
        details: {
          evalCases: { added: evalToAdd.length, skipped: evalSkipped },
          roots: { added: rootsAdded.map((r) => r.id), skipped: rootsSkipped },
          configKeys: { added: configAdded, kept: configKept },
          aliases: { added: aliasAdded, skipped: aliasSkipped },
          history,
        },
      };
    },
  };
}
