import type { DatabaseSync, StatementSync } from "node:sqlite";
import type { SkillEntry, SkillUri } from "../types.js";
import { isStopword, normalize, stem, words } from "./lexical.js";

export const FTS_MIN_CHARS = 3;
const length = (s: string) => Array.from(s).length;

export function ftsTokens(query: string): string[] {
  const text = normalize(query);
  if (length(text) < FTS_MIN_CHARS) return [];
  const tokens = new Set<string>();
  for (const word of words(text)) {
    if (isStopword(word)) continue;
    for (const t of [word, stem(word)]) if (length(t) >= FTS_MIN_CHARS) tokens.add(t);
  }
  tokens.add(text);
  return [...tokens];
}

export const ftsMatchExpression = (tokens: string[]) => tokens.map(t => `"${t.replace(/"/g, '""')}"`).join(" OR ");

export type FtsHit = { uri: SkillUri; rank: number; bm25: number; matched: string[] };

export class FtsIndex {
  private readonly insertStmt: StatementSync;
  private readonly deleteStmt: StatementSync;
  private readonly searchStmt: StatementSync;
  private readonly texts = new Map<SkillUri, string>();

  constructor(private readonly db: DatabaseSync) {
    this.insertStmt = db.prepare("INSERT INTO skills_fts(uri, name, description, when_to_use, examples, aliases_ko, body_head) VALUES (?, ?, ?, ?, ?, ?, ?)");
    this.deleteStmt = db.prepare("DELETE FROM skills_fts WHERE uri = ?");
    // bm25 weights follow column order: uri, name, description, when_to_use, examples, aliases_ko, body_head.
    this.searchStmt = db.prepare("SELECT uri, bm25(skills_fts, 0, 8, 2, 3, 5, 6, 1) AS score FROM skills_fts WHERE skills_fts MATCH ? ORDER BY score LIMIT ?");
  }

  clear(): void {
    this.db.exec("DELETE FROM skills_fts");
    this.texts.clear();
  }

  remove(uris: SkillUri[]): void {
    for (const uri of uris) { this.deleteStmt.run(uri); this.texts.delete(uri); }
  }

  upsert(entries: SkillEntry[]): void {
    for (const e of entries) {
      this.deleteStmt.run(e.uri);
      const fields = [e.name, e.description, e.whenToUse ?? "", e.examples.join("\n"), e.aliasesKo.join("\n"), e.bodyHead] as const;
      this.insertStmt.run(e.uri, ...fields);
      this.texts.set(e.uri, normalize(fields.join(" ")));
    }
  }

  search(query: string, limit = 50): FtsHit[] {
    const tokens = ftsTokens(query);
    if (!tokens.length) return [];
    const rows = this.searchStmt.all(ftsMatchExpression(tokens), limit) as { uri: string; score: number }[];
    return rows.map((row, i) => {
      const text = this.texts.get(row.uri) ?? "";
      return { uri: row.uri, rank: i + 1, bm25: row.score, matched: tokens.filter(t => text.includes(t)) };
    });
  }
}
