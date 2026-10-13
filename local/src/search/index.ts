import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { DatabaseSync } from "node:sqlite";
import type { AbstainReason, CatalogDelta, SearchIndex, SearchMode, SearchOutcome, SkillEntry, SkillUri } from "../types.js";
import { FtsIndex } from "./fts.js";
import { DEFAULT_THRESHOLD, fuse } from "./fusion.js";
import { ABSTAIN_HINTS } from "./guidance.js";
import { buildLexical, normalize, terms } from "./lexical.js";

export { DEFAULT_THRESHOLD, RRF_K, calibrate, fuse, termCoverage } from "./fusion.js";
export { SEARCH_TOOL_GUIDANCE, ABSTAIN_HINTS } from "./guidance.js";
export { normalize, terms } from "./lexical.js";
export { ftsTokens } from "./fts.js";

export function createSearchIndex(db: DatabaseSync): SearchIndex {
  const entries = new Map<SkillUri, SkillEntry>();
  const fts = new FtsIndex(db);
  let lexical = buildLexical([]);
  const thresholdStmt = db.prepare("SELECT value FROM meta WHERE key = 'search_threshold'");

  const threshold = () => {
    const row = thresholdStmt.get() as { value: string | null } | undefined;
    const value = row?.value == null ? NaN : Number(row.value);
    return Number.isFinite(value) ? value : DEFAULT_THRESHOLD;
  };

  const transaction = (fn: () => void) => {
    db.exec("BEGIN");
    try { fn(); db.exec("COMMIT"); } catch (error) { db.exec("ROLLBACK"); throw error; }
  };

  return {
    rebuild(list) {
      transaction(() => { fts.clear(); fts.upsert(list); });
      entries.clear();
      for (const e of list) entries.set(e.uri, e);
      lexical = buildLexical([...entries.values()]);
    },

    apply(delta: CatalogDelta) {
      const upserts = [...delta.added, ...delta.changed];
      transaction(() => { fts.remove(delta.removed); fts.upsert(upserts); });
      for (const uri of delta.removed) entries.delete(uri);
      for (const e of upserts) entries.set(e.uri, e);
      lexical = buildLexical([...entries.values()]);
    },

    search(query: string, opts: { mode: SearchMode; limit: number }): SearchOutcome {
      const started = performance.now();
      const base = { traceId: randomUUID(), query, mode: opts.mode };
      const done = (candidates: SearchOutcome["candidates"], reason?: AbstainReason): SearchOutcome => ({
        ...base, candidates, ...(reason ? { abstained: { reason, hint: ABSTAIN_HINTS[reason] } } : {}),
        elapsedMs: performance.now() - started,
      });

      const text = normalize(query ?? "");
      if (!text) return done([], "empty_query");
      const fused = fuse(lexical.search(text), fts.search(text), terms(text)).filter(f => entries.has(f.uri));
      if (!fused.length) return done([], "no_overlap");
      const allowed = opts.mode === "automatic" ? fused.filter(f => entries.get(f.uri)!.invocation === "automatic") : fused;
      if (!allowed.length) return done([], "explicit_only");
      if (allowed[0]!.score < threshold()) return done([], "below_threshold");
      const limit = Math.max(1, Math.floor(opts.limit));
      return done(allowed.slice(0, limit).map((f, i) => {
        const e = entries.get(f.uri)!;
        return { uri: e.uri, name: e.name, description: e.description, score: f.score, rank: i + 1, invocation: e.invocation, digest: e.digest, matched: f.matched };
      }));
    },
  };
}
