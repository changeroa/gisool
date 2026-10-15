import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { GisoolStartupError } from "../version.js";

export type Db = DatabaseSync;

export const SCHEMA_VERSION = 3;

/** migrations[i] upgrades user_version i -> i + 1. */
function migrations(): string[] {
  return [
    readFileSync(new URL("./schema.sql", import.meta.url), "utf8"),
    readFileSync(new URL("./migrations/002_tracing.sql", import.meta.url), "utf8"),
    readFileSync(new URL("./migrations/003_tracing_indexes.sql", import.meta.url), "utf8"),
  ];
}

function userVersion(db: DatabaseSync): number {
  const row = db.prepare("PRAGMA user_version").get() as { user_version: number } | undefined;
  return row?.user_version ?? 0;
}

export function openDb(path: string): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db);
  mergeSplitSessions(db);
  return db;
}

/**
 * Folds sessions that one runtime recorded twice under different id columns (before upsertSession matched either column,
 * Codex OTel rows carried only conversation_id while its MCP rows carried runtime_session_id) into the earliest row.
 * Idempotent: a database without such pairs is left unchanged.
 */
export function mergeSplitSessions(db: DatabaseSync): number {
  const pairs = db.prepare(`SELECT d.id AS dup, (
      SELECT k.id FROM sessions k WHERE k.runtime = d.runtime AND k.id <> d.id
        AND (k.runtime_session_id IN (d.runtime_session_id, d.conversation_id) OR k.conversation_id IN (d.runtime_session_id, d.conversation_id))
        AND (k.started_at < d.started_at OR (k.started_at = d.started_at AND k.id < d.id))
      ORDER BY k.started_at, k.id LIMIT 1) AS keep
    FROM sessions d WHERE COALESCE(d.runtime_session_id, d.conversation_id) IS NOT NULL`).all() as { dup: string; keep: string | null }[];
  const merges = pairs.filter((p): p is { dup: string; keep: string } => p.keep !== null);
  if (merges.length === 0) return 0;
  // Resolve chains (c -> b -> a) to their root so every duplicate lands on the earliest row.
  const parent = new Map(merges.map((m) => [m.dup, m.keep]));
  const root = (id: string): string => (parent.has(id) ? root(parent.get(id)!) : id);
  db.exec("BEGIN IMMEDIATE");
  try {
    const moveEvents = db.prepare("UPDATE events SET session_id = ? WHERE session_id = ?");
    const absorb = db.prepare(`UPDATE sessions SET
        runtime_session_id = COALESCE(runtime_session_id, (SELECT runtime_session_id FROM sessions WHERE id = ?)),
        conversation_id = COALESCE(conversation_id, (SELECT conversation_id FROM sessions WHERE id = ?)),
        client_name = COALESCE(client_name, (SELECT client_name FROM sessions WHERE id = ?)),
        cwd = COALESCE(cwd, (SELECT cwd FROM sessions WHERE id = ?)),
        first_prompt = COALESCE(first_prompt, (SELECT first_prompt FROM sessions WHERE id = ?)),
        ended_at = MAX(COALESCE(ended_at, 0), COALESCE((SELECT ended_at FROM sessions WHERE id = ?), 0))
      WHERE id = ?`);
    const drop = db.prepare("DELETE FROM sessions WHERE id = ?");
    for (const { dup } of merges) {
      const keep = root(dup);
      moveEvents.run(keep, dup);
      absorb.run(dup, dup, dup, dup, dup, dup, keep);
      drop.run(dup);
    }
    db.exec("UPDATE sessions SET ended_at = NULL WHERE ended_at = 0");
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return merges.length;
}

export function migrate(db: DatabaseSync): void {
  const steps = migrations();
  let version = userVersion(db);
  while (version < steps.length) {
    const sql = steps[version]!;
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(sql);
      db.exec(`PRAGMA user_version = ${version + 1}`);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    version = userVersion(db);
  }
}

/**
 * Proves FTS5 with the trigram tokenizer works and matches Korean substrings.
 * Uses a TEMP table on the given connection (or a fresh in-memory DB) and drops it afterwards.
 */
export function selfCheck(db?: Pick<DatabaseSync, "exec" | "prepare">): void {
  const conn = db ?? new DatabaseSync(":memory:");
  let ok = false;
  let detail = "";
  try {
    conn.exec("DROP TABLE IF EXISTS temp.gisool_selfcheck");
    conn.exec("CREATE VIRTUAL TABLE temp.gisool_selfcheck USING fts5(body, tokenize = 'trigram')");
    conn.prepare("INSERT INTO temp.gisool_selfcheck(body) VALUES (?)").run("커밋 메시지 작성해줘");
    const row = conn.prepare("SELECT count(*) AS n FROM temp.gisool_selfcheck WHERE gisool_selfcheck MATCH ?").get('"메시지"') as { n: number } | undefined;
    ok = (row?.n ?? 0) === 1;
    if (!ok) detail = "trigram match for '메시지' returned no rows";
  } catch (error) {
    detail = error instanceof Error ? error.message : String(error);
  } finally {
    try {
      conn.exec("DROP TABLE IF EXISTS temp.gisool_selfcheck");
    } catch {
      // Cleanup failure is irrelevant once the outcome is known; the original failure is reported below.
    }
    if (!db) (conn as DatabaseSync).close();
  }
  if (!ok) throw new GisoolStartupError("fts5_trigram_unavailable", detail);
}
