import type { Candidate, SkillUri } from "../../src/types.js";
import { termCoverage } from "../../src/search/fusion.js";
import { terms } from "../../src/search/lexical.js";

// Candidates panel for one search step (todo 15). The store's trace() attaches `chosen: boolean` to each
// candidate next to the step-level `chosen: SkillUri[]`; both are accepted so either source marks the row.
export type CandidateLike = Candidate & { chosen?: boolean };

export type CandidatesProps = { candidates: readonly CandidateLike[]; chosen?: readonly SkillUri[]; query?: string };

/** Rank order as the router returned it; the match score is coverage-scaled and need not descend with rank. */
export function orderCandidates<T extends CandidateLike>(candidates: readonly T[]): T[] {
  return [...candidates].sort((a, b) => a.rank - b.rank);
}

/** "3/5 terms": query terms the candidate matched, counted with the router's own term rules; undefined without terms. */
export function coverageLabel(query: string | undefined, matched: readonly string[] | undefined): string | undefined {
  const queryTerms = query ? terms(query) : [];
  if (!queryTerms.length) return undefined;
  const { hit, total } = termCoverage(queryTerms, matched ?? []);
  return `${hit}/${total} ${total === 1 ? "term" : "terms"}`;
}

/** Root id of skill://local/<rootId>/<dir>/SKILL.md, or undefined for a URI of another shape. */
export function rootOf(uri: string): string | undefined {
  const match = /^skill:\/\/local\/([^/]+)\//.exec(uri);
  return match ? decodeURIComponent(match[1]!) : undefined;
}

/** URIs whose name appears more than once in the list, mapped to their root hint. */
export function rootHints(candidates: readonly CandidateLike[]): Map<SkillUri, string> {
  const counts = new Map<string, number>();
  for (const c of candidates) counts.set(c.name, (counts.get(c.name) ?? 0) + 1);
  const hints = new Map<SkillUri, string>();
  for (const c of candidates) {
    const root = (counts.get(c.name) ?? 0) > 1 ? rootOf(c.uri) : undefined;
    if (root) hints.set(c.uri, root);
  }
  return hints;
}

export function chosenUris(candidates: readonly CandidateLike[], chosen: readonly SkillUri[] | undefined): Set<SkillUri> {
  const set = new Set<SkillUri>(chosen ?? []);
  for (const candidate of candidates) if (candidate.chosen) set.add(candidate.uri);
  return set;
}

export function formatScore(score: number): string {
  return Number.isFinite(score) ? score.toFixed(2) : "-";
}

export function scoreWidth(score: number): string {
  const clamped = Number.isFinite(score) ? Math.min(1, Math.max(0, score)) : 0;
  return `${Math.round(clamped * 100)}%`;
}

export const INVOCATION_LABEL: Record<Candidate["invocation"], string> = { automatic: "auto", explicit: "explicit" };
export const INVOCATION_TITLE: Record<Candidate["invocation"], string> = {
  automatic: "automatic: eligible for automatic routing",
  explicit: "explicit: only loads when the skill is named",
};

function CheckIcon() {
  // Lucide "check"
  return (
    <svg class="cand__check" viewBox="0 0 24 24" width="16" height="16" role="img" aria-label="loaded after this search" focusable="false">
      <path d="M20 6 9 17l-5-5" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  );
}

export function Candidates({ candidates, chosen, query }: CandidatesProps) {
  if (!candidates.length) return <p class="cands__none">No candidates were returned.</p>;
  const picked = chosenUris(candidates, chosen);
  const roots = rootHints(candidates);
  return (
    <>
    <p class="cands__legend">match = rank score {"\u00d7"} share of query terms matched</p>
    <ol class="cands" aria-label="Search candidates">
      {orderCandidates(candidates).map((candidate) => {
        const isChosen = picked.has(candidate.uri);
        const root = roots.get(candidate.uri);
        const coverage = coverageLabel(query, candidate.matched);
        return (
          <li
            key={candidate.uri}
            class={isChosen ? "cand cand--chosen" : "cand"}
            data-uri={candidate.uri}
            data-score={formatScore(candidate.score)}
            data-chosen={isChosen ? "true" : "false"}
          >
            <span class="cand__rank" aria-label={`rank ${candidate.rank}`}>{candidate.rank}</span>
            <span class="cand__name" title={candidate.uri}>
              <span class="cand__nm">{candidate.name}</span>
              {root ? <span class="cand__root" data-root={root}>{root}</span> : null}
            </span>
            <span class="cand__inv" title={INVOCATION_TITLE[candidate.invocation] ?? candidate.invocation}>
              {INVOCATION_LABEL[candidate.invocation] ?? candidate.invocation}
            </span>
            <span class="cand__bar" role="img" title="match" aria-label={`match ${formatScore(candidate.score)}${coverage ? `, ${coverage}` : ""}`}>
              <span class="cand__fill" style={{ width: scoreWidth(candidate.score) }} />
            </span>
            <span class="cand__score">{formatScore(candidate.score)}</span>
            <span class="cand__cov">{coverage ?? ""}</span>
            <span class="cand__pick">{isChosen ? <CheckIcon /> : null}</span>
            <span class="cand__desc">
              {candidate.description}
              {candidate.matched?.length ? <span class="cand__matched"> {"\u00b7"} matched {candidate.matched.join(", ")}</span> : null}
            </span>
          </li>
        );
      })}
    </ol>
    </>
  );
}
