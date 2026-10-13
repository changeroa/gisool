import type { SkillUri } from "../types.js";
import type { FtsHit } from "./fts.js";
import type { LexicalHit } from "./lexical.js";

export const RRF_K = 60;
// Written by `node local/bench/search.mjs` from calibrate(); `--check` asserts it is current.
export const DEFAULT_THRESHOLD = 0;

export type Fused = { uri: SkillUri; score: number; rrf: number; anchor: 0 | 1 | 2; lexScore: number; matched: string[]; coverage: number };

const MAX_RRF = 2 / (RRF_K + 1);
const round4 = (n: number) => Math.round(n * 1e4) / 1e4;

/** Query terms (from lexical `terms()`) that a candidate's matched list covers; the dashboard shows the same count. */
export function termCoverage(queryTerms: readonly string[], matched: readonly string[]): { hit: number; total: number } {
  const set = new Set(matched.map(m => m.normalize("NFKC").toLowerCase()));
  return { hit: queryTerms.filter(t => set.has(t)).length, total: queryTerms.length };
}

/**
 * Fuse both channels by reciprocal rank. Order uses raw RRF; the displayed score is the rank score scaled by the
 * share of query terms the candidate matched, so a top rank on a weak match no longer reads as 1.00.
 * Without `queryTerms` (or for a stopword-only query) coverage is 1 and the score stays rank-only.
 */
export function fuse(lexical: LexicalHit[], fts: FtsHit[], queryTerms: readonly string[] = []): Fused[] {
  const byUri = new Map<SkillUri, Fused>();
  const get = (uri: SkillUri) => {
    let f = byUri.get(uri);
    if (!f) byUri.set(uri, f = { uri, score: 0, rrf: 0, anchor: 0, lexScore: 0, matched: [], coverage: 1 });
    return f;
  };
  lexical.forEach((hit, i) => {
    const f = get(hit.uri);
    f.rrf += 1 / (RRF_K + i + 1);
    f.anchor = hit.anchor;
    f.lexScore = hit.score;
    f.matched.push(...hit.matched);
  });
  for (const hit of fts) {
    const f = get(hit.uri);
    f.rrf += 1 / (RRF_K + hit.rank);
    f.matched.push(...hit.matched);
  }
  const fused = [...byUri.values()];
  for (const f of fused) {
    f.matched = [...new Set(f.matched)];
    const { hit, total } = termCoverage(queryTerms, f.matched);
    f.coverage = total ? hit / total : 1;
    // Normalize against the best possible RRF (rank 1 in both lists), scale by term coverage; anchors pin to 1.
    f.score = f.anchor ? 1 : round4(Math.min(1, f.rrf / MAX_RRF) * f.coverage);
  }
  return fused.sort((a, b) => b.anchor - a.anchor || b.rrf - a.rrf || b.lexScore - a.lexScore || (a.uri < b.uri ? -1 : a.uri > b.uri ? 1 : 0));
}

/** Smallest threshold that makes every negative abstain: just above the best negative score, or 0 when none hit. */
export function calibrate(negativeBestScores: number[], margin = 0.01): number {
  const hits = negativeBestScores.filter(s => s > 0);
  return hits.length ? round4(Math.min(1, Math.max(...hits) + margin)) : 0;
}
