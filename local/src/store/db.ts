import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { GisoolStartupError } from "../version.js";

export type Db = DatabaseSync;

export const SCHEMA_VERSION = 1;

/** migrations[i] upgrades user_version i -> i + 1. */
function migrations(): string[] {
  return [readFileSync(new URL("./schema.sql", import.meta.url), "utf8")];
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
  return db;
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
