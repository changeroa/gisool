import type { AssignedTreeEvent, FindingAbstention, FindingAggregate, FindingCandidate, FindingLabel, FindingMiss, FindingUsedSkill,
  FlowFinding, SessionFinding, SessionTree, SkillDigestLookup, Store, TurnFinding, TurnTree } from "../types.js";
import { flowTree, sessionTree } from "./tree.js";

/** The fields of a stored search candidate this analysis reads. `digest` is the SKILL.md digest the search index
 * recorded with the candidate (types.ts Candidate), so identical copies are detected without a catalog lookup;
 * a load event carries only `manifestDigest` (a digest over the resource manifest), which is a different value. */
type SearchCandidate = { readonly uri: string; readonly name: string; readonly rank: number; readonly digest: string };
type CandidateGroup = { readonly rank: number; readonly members: readonly SearchCandidate[] };
type TurnSearch = { readonly query: string; readonly abstained: FindingAbstention | null; readonly groups: readonly CandidateGroup[] };
type UsedRef = { readonly uri: string | null; readonly name: string; readonly via: "load" | "native"; readonly loadId: string | null;
  readonly digest: string | null };

const LABELS: readonly FindingLabel[] = ["found_top1", "found_lower", "loaded_outside_results", "native_without_search",
  "searched_none_used", "no_search"];

const str = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null);
const dirOf = (uri: string): string => uri.split("/").at(-2) ?? "";

function candidateOf(value: unknown): SearchCandidate | null {
  if (typeof value !== "object" || value === null) return null;
  const row = value as Record<string, unknown>;
  const uri = str(row.uri);
  if (uri === null || typeof row.rank !== "number") return null;
  return { uri, name: str(row.name) ?? dirOf(uri), rank: row.rank, digest: str(row.digest) ?? "" };
}

function abstainedOf(value: unknown): FindingAbstention | null {
  if (typeof value !== "object" || value === null) return null;
  const row = value as Record<string, unknown>;
  const reason = str(row.reason);
  return reason === null ? null : { reason: reason as FindingAbstention["reason"], hint: str(row.hint) ?? "" };
}

/** R1 of the duplicate research: candidates whose SKILL.md digest is identical are copies of one skill and share one
 * rank, so a distinct skill behind two copies is rank 2, not rank 3. Candidates without a digest stand alone. */
function collapse(candidates: readonly SearchCandidate[]): CandidateGroup[] {
  const byDigest = new Map<string, SearchCandidate[]>();
  const groups: SearchCandidate[][] = [];
  for (const candidate of [...candidates].sort((a, b) => a.rank - b.rank || a.uri.localeCompare(b.uri))) {
    const known = candidate.digest === "" ? undefined : byDigest.get(candidate.digest);
    if (known) {
      known.push(candidate);
      continue;
    }
    const group = [candidate];
    if (candidate.digest !== "") byDigest.set(candidate.digest, group);
    groups.push(group);
  }
  return groups.map((members, i) => ({ rank: i + 1, members }));
}

function searchOf(event: AssignedTreeEvent): TurnSearch {
  const raw = Array.isArray(event.data.candidates) ? event.data.candidates : [];
  return { query: str(event.data.query) ?? event.text ?? "", abstained: abstainedOf(event.data.abstained),
    groups: collapse(raw.flatMap((value) => candidateOf(value) ?? [])) };
}

function usedSkillOf(event: AssignedTreeEvent, digestOf?: SkillDigestLookup): UsedRef | null {
  if (event.kind !== "load" && event.kind !== "native_skill") return null;
  const uri = event.skillUri ?? str(event.data.uri) ?? str(event.data.skillUri);
  const name = str(event.data.name) ?? (uri === null ? "" : dirOf(uri));
  const loadId = str(event.data.loadId);
  return { uri, name, via: event.kind === "load" ? "load" : "native", loadId, digest: digestOf?.({ uri, loadId }) ?? null };
}

const matchesUri = (candidate: SearchCandidate, used: { uri: string | null }): boolean => used.uri !== null && candidate.uri === used.uri;
const matchesName = (candidate: SearchCandidate, used: { name: string }): boolean =>
  used.name !== "" && (candidate.name === used.name || dirOf(candidate.uri) === used.name);
/** missedLater asks whether a search surfaced a skill at all, which todo 7 words as its uri or its name; this is
 * deliberately looser than the identity a rank needs. */
const matches = (candidate: SearchCandidate, used: { uri: string | null; name: string }): boolean =>
  matchesUri(candidate, used) || matchesName(candidate, used);

/** A rank belongs to the skill the search actually returned: the same uri, or a candidate with the same SKILL.md
 * digest, which R1 defines as a copy of that skill. A shared name is never proof of identity, so a known uri the
 * search did not return stays unranked even when a same-named variant was a candidate. A native activation reports
 * only a name, so it takes a rank when every candidate carrying that name is one collapsed skill. */
function rankIn(search: TurnSearch | null, used: UsedRef): number | null {
  if (search === null) return null;
  const byUri = search.groups.find((group) => group.members.some((member) => matchesUri(member, used)));
  if (byUri) return byUri.rank;
  const byDigest = used.digest === null ? undefined
    : search.groups.find((group) => group.members.some((member) => member.digest === used.digest));
  if (byDigest) return byDigest.rank;
  if (used.uri !== null) return null;
  const named = search.groups.filter((group) => group.members.some((member) => matchesName(member, used)));
  return named.length === 1 ? named[0].rank : null;
}

/** Label precedence: the strongest evidence of where the used skills came from wins, so a turn that used a native
 * skill before searching and then loaded the top hit reads as found_top1 while `nativeWithoutSearch` stays true. */
function labelOf(searched: boolean, used: readonly FindingUsedSkill[], nativeWithoutSearch: boolean): FindingLabel {
  if (used.some((skill) => skill.rankInSearch === 1)) return "found_top1";
  if (used.some((skill) => skill.rankInSearch !== null)) return "found_lower";
  if (nativeWithoutSearch) return "native_without_search";
  if (used.length > 0) return "loaded_outside_results";
  return searched ? "searched_none_used" : "no_search";
}

/** Reads one turn in event order: a search updates what the next use can be ranked against, so a turn with several
 * searches ranks each load against the latest search before it. `later` holds the turns after this one in the session.
 */
export function analyzeTurn(turn: TurnTree, later: readonly TurnTree[] = [], digestOf?: SkillDigestLookup): TurnFinding {
  const searches: TurnSearch[] = [];
  const used: FindingUsedSkill[] = [];
  const abstentions: FindingAbstention[] = [];
  let latest: TurnSearch | null = null;
  let nativeWithoutSearch = false;
  for (const event of turn.events) {
    if (event.kind === "search") {
      latest = searchOf(event);
      searches.push(latest);
      if (latest.abstained !== null) abstentions.push(latest.abstained);
      continue;
    }
    const skill = usedSkillOf(event, digestOf);
    if (skill === null) continue;
    if (skill.via === "native" && latest === null) nativeWithoutSearch = true;
    used.push({ uri: skill.uri, name: skill.name, via: skill.via, ts: event.ts, rankInSearch: rankIn(latest, skill) });
  }
  // One row per candidate uri; when several searches returned it, the latest search's ranks are the reported ones.
  const candidates = new Map<string, FindingCandidate>();
  for (const search of searches) {
    for (const group of search.groups) {
      for (const member of group.members) {
        candidates.set(member.uri, { uri: member.uri, name: member.name, rank: group.rank, rawRank: member.rank, copies: group.members.length });
      }
    }
  }
  const surfaced = searches.flatMap((search) => search.groups.flatMap((group) => group.members));
  const missedLater = new Map<string, FindingMiss>();
  if (searches.length > 0) {
    for (const next of later) {
      for (const event of next.events) {
        const skill = usedSkillOf(event);
        if (skill === null || surfaced.some((candidate) => matches(candidate, skill))) continue;
        const key = skill.uri ?? skill.name;
        if (!missedLater.has(key)) missedLater.set(key, { uri: skill.uri, name: skill.name, via: skill.via, turnId: next.id, ts: event.ts });
      }
    }
  }
  return { turnId: turn.id, searched: searches.length > 0, queries: searches.map((search) => search.query),
    candidates: [...candidates.values()].sort((a, b) => a.rank - b.rank || a.rawRank - b.rawRank || a.uri.localeCompare(b.uri)),
    loadedSkills: used, abstained: abstentions.length > 0, abstentions,
    nativeWithoutSearch, missedLater: [...missedLater.values()], label: labelOf(searches.length > 0, used, nativeWithoutSearch) };
}

export function aggregateFindings(turns: readonly TurnFinding[]): FindingAggregate {
  const labels = Object.fromEntries(LABELS.map((label) => [label, 0])) as Record<FindingLabel, number>;
  const ranks: number[] = [];
  let abstainedSearches = 0;
  let abstainedTurns = 0;
  for (const turn of turns) {
    labels[turn.label] += 1;
    abstainedSearches += turn.abstentions.length;
    if (turn.abstained) abstainedTurns += 1;
    for (const skill of turn.loadedSkills) if (skill.rankInSearch !== null) ranks.push(skill.rankInSearch);
  }
  return { turns: turns.length, labels, abstainedSearches, abstainedTurns,
    meanRank: ranks.length === 0 ? null : ranks.reduce((sum, rank) => sum + rank, 0) / ranks.length };
}

export function analyzeSession(tree: SessionTree, digestOf?: SkillDigestLookup): SessionFinding {
  const turns = tree.turns.map((turn, i) => analyzeTurn(turn, tree.turns.slice(i + 1), digestOf));
  return { sessionId: tree.id, turns, aggregate: aggregateFindings(turns) };
}

/** The SKILL.md digest of what a load actually read, taken from the resource list stored with that load. It is the
 * same digest a candidate carries, so a load of an identical copy under another uri is recognised as that skill. */
export function loadedDigests(store: Pick<Store, "getLoad">): SkillDigestLookup {
  return ({ uri, loadId }) => (uri === null || loadId === null
    ? undefined
    : store.getLoad(loadId)?.resources.find((resource) => resource.uri === uri)?.digest);
}

export function sessionFinding(store: Pick<Store, "treeSessionData" | "getLoad">, sessionId: string): SessionFinding | undefined {
  const tree = sessionTree(store, sessionId);
  return tree ? analyzeSession(tree, loadedDigests(store)) : undefined;
}

export function flowFinding(store: Pick<Store, "treeSessionData" | "treeFlowData" | "getLoad">, flowOrWorkspaceId: string): FlowFinding | undefined {
  const flow = flowTree(store, flowOrWorkspaceId);
  if (!flow) return undefined;
  const sessions = new Map<string, SessionFinding>();
  const digestOf = loadedDigests(store);
  for (const tab of flow.tabs) {
    for (const pane of tab.panes) {
      for (const link of pane.sessions) {
        if (link.session !== null && !sessions.has(link.session.id)) sessions.set(link.session.id, analyzeSession(link.session, digestOf));
      }
    }
  }
  const list = [...sessions.values()];
  return { id: flow.id, sessions: list, aggregate: aggregateFindings(list.flatMap((session) => session.turns)) };
}
