import type { SkillUri } from "../types.js";
import type { FtsHit } from "./fts.js";
import type { LexicalHit } from "./lexical.js";

export const RRF_K = 60;
// Written by `node local/bench/search.mjs` from calibrate(); `--check` asserts it is current.
export const DEFAULT_THRESHOLD = 0;

export type Fused = { uri: SkillUri; score: number; rrf: number; anchor: 0 | 1 | 2; lexScore: number; matched: string[] };

const MAX_RRF = 2 / (RRF_K + 1);
const round4 = (n: number) => Math.round(n * 1e4) / 1e4;

export function fuse(lexical: LexicalHit[], fts: FtsHit[]): Fused[] {
  const byUri = new Map<SkillUri, Fused>();
  const get = (uri: SkillUri) => {
    let f = byUri.get(uri);
    if (!f) byUri.set(uri, f = { uri, score: 0, rrf: 0, anchor: 0, lexScore: 0, matched: [] });
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
    // Normalize against the best possible RRF (rank 1 in both lists); anchors pin to 1.
    f.score = f.anchor ? 1 : round4(Math.min(1, f.rrf / MAX_RRF));
  }
  return fused.sort((a, b) => b.anchor - a.anchor || b.rrf - a.rrf || b.lexScore - a.lexScore || (a.uri < b.uri ? -1 : a.uri > b.uri ? 1 : 0));
}

/** Smallest threshold that makes every negative abstain: just above the best negative score, or 0 when none hit. */
export function calibrate(negativeBestScores: number[], margin = 0.01): number {
  const hits = negativeBestScores.filter(s => s > 0);
  return hits.length ? round4(Math.min(1, Math.max(...hits) + margin)) : 0;
}
