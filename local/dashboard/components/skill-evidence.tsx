import type { SkillSpanUsage } from "../../src/analysis/usage.js";
import type { AssignedTreeEvent, TurnFindingDto } from "../../src/types.js";

/** A later use remains navigable even when its turn starts folded. */
function openTurn(id: string): void {
  const target = document.getElementById(`turn-${id}`);
  if (!(target instanceof HTMLDetailsElement)) return;
  target.open = true;
  target.querySelector("summary")?.focus();
}

export function FindingEvidence({ finding }: { finding: TurnFindingDto }) {
  return (
    <details class="evidence" data-evidence="finding">
      <summary>Inspect finding evidence <span class="tag">reported events</span></summary>
      <div class="evidence__body">
        <p>Search recorded: <strong data-searched={finding.searched}>{finding.searched ? "yes" : "no"}</strong></p>
        <ol aria-label="Search queries">{finding.queries.map((query, i) => <li key={i}><q>{query || "query not captured"}</q></li>)}</ol>
        <h3>Candidates across searches</h3>
        <p class="dim">Latest ranks per candidate; rank groups identical copies.</p>
        {finding.candidates.length === 0 ? <p>No candidates recorded.</p> : (
          <ul aria-label="Search candidates">{finding.candidates.map((candidate) => (
            <li key={candidate.uri} data-candidate={candidate.uri} data-rank={candidate.rank} data-raw-rank={candidate.rawRank} data-copies={candidate.copies}>
              <strong>{candidate.name}</strong> - rank {candidate.rank}, raw rank {candidate.rawRank}, copies {candidate.copies}
              <code>{candidate.uri}</code>
            </li>
          ))}</ul>
        )}
        <h3>Loaded and natively used skills</h3>
        {finding.usedSkills.length === 0 ? <p>No skill use recorded.</p> : (
          <ul aria-label="Used skills">{finding.usedSkills.map((skill, i) => (
            <li key={i} data-used-skill={skill.name} data-rank={skill.rankInSearch ?? "not_in_results"} data-via={skill.via}>
              <strong>{skill.name}</strong> - {skill.via === "load" ? "loaded" : "native use"}; {skill.rankInSearch === null ? "not in results (or no preceding search)" : `rank ${skill.rankInSearch} in preceding search`}
              {skill.uri && <code>{skill.uri}</code>}
            </li>
          ))}</ul>
        )}
        <p>Native use without preceding search: <strong data-native-without-search={finding.nativeWithoutSearch}>{finding.nativeWithoutSearch ? "yes" : "no"}</strong></p>
        <h3>Abstentions</h3>
        {finding.abstentions.length === 0 ? <p>No abstention recorded.</p> : (
          <ul>{finding.abstentions.map((abstention, i) => <li key={i} data-abstention={abstention.reason}>{abstention.reason}{abstention.hint && ` - ${abstention.hint}`}</li>)}</ul>
        )}
        <h3>Used later, absent from these searches</h3>
        {finding.missedLater.length === 0 ? <p>No later missed skill recorded.</p> : (
          <ul>{finding.missedLater.map((skill, i) => (
            <li key={i} data-missed-skill={skill.name}>
              <a href={`#turn-${skill.turnId}`} onClick={(event) => { event.preventDefault(); openTurn(skill.turnId); }}>{skill.name} - open later turn</a>
              {skill.uri && <code>{skill.uri}</code>}
            </li>
          ))}</ul>
        )}
      </div>
    </details>
  );
}

const CORRECTION_LABEL = { correction: "looks like a correction", no_correction: "no correction words matched", unknown: "unknown" } as const;
const CORRECTION_REASON = { no_next_prompt: "no next prompt observed", text_not_captured: "next prompt text not captured" } as const;

export function UsageEvidence({ events, usage }: { events: readonly AssignedTreeEvent[]; usage: SkillSpanUsage }) {
  const correction = usage.nextPromptCorrection;
  return (
    <details class="evidence" data-evidence="usage">
      <summary>Inspect use evidence <span class="tag">reported / heuristic</span></summary>
      <div class="evidence__body">
        <p data-correction={correction.status} data-basis={correction.label} data-correction-reason={correction.reason ?? "none"}>
          Next-prompt correction: <strong>{CORRECTION_LABEL[correction.status]}</strong> <span class="tag">{correction.label}</span>
          {correction.reason && ` - ${CORRECTION_REASON[correction.reason]}`}
          {correction.matched.length > 0 && ` - matched: ${correction.matched.join(", ")}`}
        </p>
        <h3>Supporting reads</h3>
        {usage.supportingReads.length === 0 ? <p>No supporting read recorded.</p> : (
          <ul>{usage.supportingReads.map((read) => {
            const event = events.find((item) => item.id === read.eventId);
            const path = typeof event?.data.uri === "string" ? event.data.uri : typeof event?.data.path === "string" ? event.data.path : null;
            return (
              <li key={read.eventId} data-read={read.eventId} data-basis={read.label}>
                <span class="tag">{read.label}</span> {read.kind === "read_file" ? "resource read" : "tool argument path"}
                <code>{path ?? event?.text ?? "file path not captured"}</code>
                {read.uri && <code>Skill: {read.uri}</code>}
                <span>Event: <code>{read.eventId}</code></span>
              </li>
            );
          })}</ul>
        )}
      </div>
    </details>
  );
}
