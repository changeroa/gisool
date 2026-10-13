import type { Candidate, SkillUri } from "../../src/types.js";

// Candidates panel for one search step (todo 15). The store's trace() attaches `chosen: boolean` to each
// candidate next to the step-level `chosen: SkillUri[]`; both are accepted so either source marks the row.
export type CandidateLike = Candidate & { chosen?: boolean };

export type CandidatesProps = { candidates: readonly CandidateLike[]; chosen?: readonly SkillUri[] };

export function orderCandidates<T extends CandidateLike>(candidates: readonly T[]): T[] {
  return [...candidates].sort((a, b) => b.score - a.score || a.rank - b.rank);
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

export function Candidates({ candidates, chosen }: CandidatesProps) {
  if (!candidates.length) return <p class="cands__none">No candidates were returned.</p>;
  const picked = chosenUris(candidates, chosen);
  return (
    <ol class="cands" aria-label="Search candidates">
      {orderCandidates(candidates).map((candidate) => {
        const isChosen = picked.has(candidate.uri);
        return (
          <li
            key={candidate.uri}
            class={isChosen ? "cand cand--chosen" : "cand"}
            data-uri={candidate.uri}
            data-score={formatScore(candidate.score)}
            data-chosen={isChosen ? "true" : "false"}
          >
            <span class="cand__rank" aria-label={`rank ${candidate.rank}`}>{candidate.rank}</span>
            <span class="cand__name" title={candidate.uri}>{candidate.name}</span>
            <span class="cand__inv" title={INVOCATION_TITLE[candidate.invocation] ?? candidate.invocation}>
              {INVOCATION_LABEL[candidate.invocation] ?? candidate.invocation}
            </span>
            <span class="cand__bar" role="img" aria-label={`score ${formatScore(candidate.score)}`}>
              <span class="cand__fill" style={{ width: scoreWidth(candidate.score) }} />
            </span>
            <span class="cand__score">{formatScore(candidate.score)}</span>
            <span class="cand__pick">{isChosen ? <CheckIcon /> : null}</span>
            <span class="cand__desc">
              {candidate.description}
              {candidate.matched?.length ? <span class="cand__matched"> {"\u00b7"} matched {candidate.matched.join(", ")}</span> : null}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
