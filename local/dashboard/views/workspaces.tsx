import { useEffect, useState } from "preact/hooks";
import type { AttributionShare, SkillSpanUsage } from "../../src/analysis/usage.js";
import type {
  AutomatedMode, FlowListEntry, FlowReportDto, FlowSpecRef, FlowTree, RuntimeId, SessionTree, SkillSpan, TreePaneLink,
  TurnFindingDto, TurnTree,
} from "../../src/types.js";
import type { FlowComparison, StepComparison } from "../../src/workflow/compare.js";
import { api, type FlowsQuery } from "../api";
import { installStyles } from "../charts/sankey";
import { CallList, Tokens, UNKNOWN, callRows, isCall, numberOf, tokenParts } from "../components/calls";
import { Facts, type Fact } from "../components/facts";
import {
  BASIS_LABEL, BASIS_TITLE, FINDING_LABEL, FINDING_TITLE, RUNTIME_LABEL, RUNTIME_MARK, SPAN_ATTRIBUTION_LABEL,
  STEP_STATUS_LABEL, STEP_STATUS_TITLE, buildHash, type Route, type ViewProps,
} from "../state";

// Workspaces view (todo 11): the herdr flows gisool knows, and what the agents inside them did.
// The list is one cheap call (GET /api/flows); the found/used summary per row is that flow's report, read after the
// list paints, SUMMARY_CONCURRENCY at a time, so a slow analysis never blocks the page. A flow report is computed on
// read, so the detail view shows the snapshot time and refreshes on request, never on a timer.

/** Flow reports are computed on read, so the list enriches at most this many rows at a time. */
export const SUMMARY_CONCURRENCY = 2;
export const TURNS_OPEN_MAX = 3;
const LIVE_REFRESH_DEBOUNCE_MS = 300;

const dateTimeFmt = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
const clockFmt = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });

export function flowTitle(entry: Pick<FlowListEntry, "label" | "workspaceId">): string {
  return entry.label ?? entry.workspaceId;
}

/**
 * The two parts of the spec tag: a registered flow names its spec and version, a herdr workspace nobody registered
 * has no version at all. They stay separate so a long name can truncate while its version stays on screen.
 */
export function specTagParts(spec: FlowSpecRef | null): { name: string; version: string | null } {
  return spec ? { name: spec.name, version: `v${spec.version}` } : { name: "unregistered", version: null };
}

export function specLabel(spec: FlowSpecRef | null): string {
  const { name, version } = specTagParts(spec);
  return version === null ? name : `${name} ${version}`;
}

/** A time herdr never reported stays unknown instead of becoming the epoch. */
export function formatStarted(ms: number | null | undefined): string {
  const value = numberOf(ms);
  return value === undefined ? UNKNOWN : dateTimeFmt.format(value);
}

/** Which skill the calls of a span were credited to; a count of 0 is left out, and no call at all says so. */
export function attributionParts(share: AttributionShare): { key: keyof typeof SPAN_ATTRIBUTION_LABEL; label: string; value: number; title: string }[] {
  const counts: [keyof typeof SPAN_ATTRIBUTION_LABEL, number, string][] = [
    ["reported", share.reported, "the runtime credited them to this skill"],
    ["single", share.single, "this skill was the only one active"],
    ["co_active", share.coActive, "another skill was active at the same time"],
  ];
  return counts.flatMap(([key, value, why]) => (value > 0
    ? [{ key, label: SPAN_ATTRIBUTION_LABEL[key], value, title: `${value} ${value === 1 ? "call" : "calls"}: ${why}` }]
    : []));
}

export type FlowSummary = {
  turns: number; foundViaSearch: number; abstainedTurns: number;
  spans: number; spansActed: number;
  /** Null unless every span reported its cost, so a partial sum is never read as the flow's price. */
  costUsd: number | null;
};

export function flowSummary(report: Pick<FlowReportDto, "finding" | "usage">): FlowSummary {
  const { labels, turns, abstainedTurns } = report.finding.aggregate;
  const spans = report.usage.sessions.flatMap((session) => session.spans);
  const costs = spans.map((span) => span.costUsd);
  const known = costs.filter((cost): cost is number => cost !== null);
  return {
    turns,
    foundViaSearch: labels.found_top1 + labels.found_lower,
    abstainedTurns,
    spans: spans.length,
    spansActed: spans.filter((span) => span.followThrough > 0).length,
    costUsd: known.length === costs.length && known.length > 0 ? known.reduce((sum, cost) => sum + cost, 0) : null,
  };
}

export function summaryFacts(summary: FlowSummary): Fact[] {
  const facts: Fact[] = [
    { key: "turns", value: summary.turns },
    { key: "found", value: summary.foundViaSearch },
    { key: "spans", acted: summary.spansActed, total: summary.spans },
  ];
  if (summary.abstainedTurns > 0) facts.push({ key: "abstained", value: summary.abstainedTurns });
  facts.push({ key: "cost", value: summary.spans === 0 ? null : summary.costUsd });
  return facts;
}

export function entryFacts(entry: FlowListEntry): Fact[] {
  if (entry.kind === "outside_herdr") return [{ key: "sessions", value: entry.counts.sessions }];
  const facts: Fact[] = [{ key: "workspace", value: entry.workspaceId }];
  if (entry.tabId !== null) facts.push({ key: "tab", value: entry.tabId });
  facts.push({ key: "panes", value: entry.counts.panes }, { key: "sessions", value: entry.counts.sessions });
  if (entry.attribution.inferred > 0) facts.push({ key: "inferred", value: entry.attribution.inferred });
  if (entry.attribution.unlinked > 0) facts.push({ key: "unlinked", value: entry.attribution.unlinked });
  return facts;
}

/** The shared filter, narrowed to what GET /api/flows accepts. */
export function flowsQuery(route: Route): FlowsQuery {
  return {
    ...(route.filter.from !== undefined ? { from: route.filter.from } : {}),
    ...(route.filter.to !== undefined ? { to: route.filter.to } : {}),
    ...(route.filter.automated !== undefined ? { automated: route.filter.automated as AutomatedMode } : {}),
  };
}

export function turnsOpen(count: number): boolean {
  return count <= TURNS_OPEN_MAX;
}

/** Per-turn finding and per-span usage, keyed the way the tree is walked. */
export function reportIndex(report: Pick<FlowReportDto, "finding" | "usage">): { findings: Map<string, TurnFindingDto>; usageBySpan: Map<string, SkillSpanUsage> } {
  const findings = new Map<string, TurnFindingDto>();
  for (const session of report.finding.sessions) for (const turn of session.turns) findings.set(turn.turnId, turn);
  const usageBySpan = new Map<string, SkillSpanUsage>();
  for (const session of report.usage.sessions) for (const span of session.spans) usageBySpan.set(span.spanId, span);
  return { findings, usageBySpan };
}

export function spanFacts(span: Pick<SkillSpan, "startedAt" | "endedAt">, usage: SkillSpanUsage | undefined, calls: number): Fact[] {
  if (!usage) {
    return [{ key: "active", value: span.endedAt - span.startedAt }, { key: "calls", value: calls }, { key: "cost", value: null }];
  }
  const facts: Fact[] = [
    { key: "active", value: usage.durationMs },
    { key: "callsAfter", value: usage.followThrough },
  ];
  if (usage.skillToolCalls > 0) facts.push({ key: "gisoolCalls", value: usage.skillToolCalls });
  if (usage.toolFailures > 0) facts.push({ key: "failed", value: usage.toolFailures });
  if (usage.supportingReads.length > 0) facts.push({ key: "reads", value: usage.supportingReads.length });
  facts.push({ key: "cost", value: usage.costUsd });
  return facts;
}

function Chevron() {
  return (
    <svg class="chev" viewBox="0 0 24 24" width="12" height="12" aria-hidden="true" focusable="false">
      <path d="m9 18 6-6-6-6" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  );
}

function SpecTag({ entry }: { entry: FlowListEntry }) {
  if (entry.kind === "outside_herdr") return <span class="tag tag--dim">no pane link</span>;
  const { name, version } = specTagParts(entry.spec);
  const title = entry.spec
    ? `${specLabel(entry.spec)}: the workflow spec this flow was registered with`
    : "no workflow spec was registered for this herdr workspace";
  return (
    <span class={entry.spec ? "tag" : "tag tag--dim"} title={title}>
      <span class="tag__name">{name}</span>
      {version !== null && <span class="tag__suffix">{version}</span>}
    </span>
  );
}

function Runtime({ runtime }: { runtime: RuntimeId }) {
  return (
    <span class="rt">
      <span class="rt__mark" aria-hidden="true">{RUNTIME_MARK[runtime] ?? RUNTIME_MARK.unknown}</span>
      <span>{RUNTIME_LABEL[runtime] ?? RUNTIME_LABEL.unknown}</span>
    </span>
  );
}

type SummaryState = { status: "loading" } | { status: "ready"; summary: FlowSummary } | { status: "error" };

/** Reads one flow report per row, SUMMARY_CONCURRENCY at a time, and drops what is in flight when the list changes. */
function useFlowSummaries(ids: readonly string[], query: FlowsQuery): Record<string, SummaryState> {
  const key = ids.join("\n");
  const queryKey = JSON.stringify(query);
  const [summaries, setSummaries] = useState<Record<string, SummaryState>>({});
  useEffect(() => {
    if (ids.length === 0) {
      setSummaries({});
      return;
    }
    let cancelled = false;
    setSummaries(Object.fromEntries(ids.map((id) => [id, { status: "loading" } as SummaryState])));
    const queue = [...ids];
    const worker = async (): Promise<void> => {
      for (let next = queue.shift(); next !== undefined && !cancelled; next = queue.shift()) {
        const id = next;
        try {
          const report = await api.flowReport(id, query);
          if (!cancelled) setSummaries((prev) => ({ ...prev, [id]: { status: "ready", summary: flowSummary(report) } }));
        } catch {
          // A report that cannot be read leaves the row's structure facts in place; the summary line says so.
          if (!cancelled) setSummaries((prev) => ({ ...prev, [id]: { status: "error" } }));
        }
      }
    };
    void Promise.all(Array.from({ length: Math.min(SUMMARY_CONCURRENCY, ids.length) }, worker));
    return () => { cancelled = true; };
  }, [key, queryKey]);
  return summaries;
}

function FlowRow({ entry, route, summary }: { entry: FlowListEntry; route: Route; summary: SummaryState | undefined }) {
  const href = buildHash({ view: "workspace", flowId: entry.id, filter: route.filter });
  return (
    <li class="wsrow" data-flow={entry.id}>
      <a class="wsrow__title" href={href}>{flowTitle(entry)}</a>
      <SpecTag entry={entry} />
      <time class="wsrow__when" dateTime={entry.startedMs === null ? undefined : new Date(entry.startedMs).toISOString()}>
        {formatStarted(entry.startedMs)}
      </time>
      <Facts facts={entryFacts(entry)} className="facts wsrow__meta" />
      {summary === undefined || summary.status === "loading"
        ? <p class="facts wsrow__sum dim" data-summary="loading">reading skill spans{"\u2026"}</p>
        : summary.status === "error"
          ? <p class="facts wsrow__sum dim" data-summary="error">skill span summary unavailable</p>
          : <Facts facts={summaryFacts(summary.summary)} className="facts wsrow__sum" />}
    </li>
  );
}

function ListEmpty({ filtered, route, navigate }: { filtered: boolean; route: Route; navigate: ViewProps["navigate"] }) {
  if (filtered) {
    return (
      <section class="empty">
        <h2>No workspaces in this range</h2>
        <p>Widen the time range or remove a filter to see more workspaces.</p>
        <button type="button" class="btn" onClick={() => navigate({ ...route, filter: {} })}>Clear filters</button>
      </section>
    );
  }
  return (
    <section class="empty">
      <h2>No herdr workspaces recorded</h2>
      <p>
        gisool groups sessions by the herdr pane they ran in. Start a herdr workspace and run an agent in one of its
        panes, or run <code class="cmd">gisool doctor</code> to check the herdr connection.
      </p>
    </section>
  );
}

export function WorkspacesView({ route, navigate, live }: ViewProps) {
  const query = flowsQuery(route);
  const queryKey = JSON.stringify(query);
  const [flows, setFlows] = useState<FlowListEntry[]>();
  const [error, setError] = useState<string>();
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    if (live.seq === 0) return;
    const timer = setTimeout(() => setRefresh((n) => n + 1), LIVE_REFRESH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [live.seq]);

  useEffect(() => {
    let cancelled = false;
    api.flows(query)
      .then((dto) => {
        if (cancelled) return;
        setFlows([...dto.flows]);
        setError(undefined);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => { cancelled = true; };
  }, [queryKey, refresh]);

  const summaries = useFlowSummaries(flows?.map((entry) => entry.id) ?? [], query);
  const filtered = query.from !== undefined || query.to !== undefined;

  return (
    <section class="ws" aria-busy={flows === undefined}>
      {error && <p class="notice" role="alert">Could not load workspaces: {error}</p>}
      {flows !== undefined && flows.length === 0 && <ListEmpty filtered={filtered} route={route} navigate={navigate} />}
      {flows !== undefined && flows.length > 0 && (
        <div class="card">
          <ul class="wslist" aria-label="herdr workspaces">
            {flows.map((entry) => <FlowRow key={entry.id} entry={entry} route={route} summary={summaries[entry.id]} />)}
          </ul>
        </div>
      )}
    </section>
  );
}

function StepRow({ step }: { step: StepComparison }) {
  const used = new Set(step.usedSkills);
  const intended = new Set(step.intendedSkills);
  return (
    <li class="step" data-step={step.stepId} data-status={step.status}>
      <div class="step__head">
        <span class="step__id">{step.stepId}</span>
        <span class={`badge badge--${step.status}`} title={STEP_STATUS_TITLE[step.status]}>{STEP_STATUS_LABEL[step.status]}</span>
        <span class="dim">{step.panes.length === 0 ? "no pane mapped" : step.panes.join(", ")}</span>
      </div>
      <div class="step__row">
        <span class="step__k">intended</span>
        <span class="step__v">
          {step.intendedSkills.length === 0
            ? <span class="dim">none</span>
            : step.intendedSkills.map((name) => (
              <span key={name} class={used.has(name) ? "skill" : "skill skill--missing"} title={used.has(name) ? "used in this step" : "not used in this step"}>{name}</span>
            ))}
        </span>
      </div>
      <div class="step__row">
        <span class="step__k">used</span>
        <span class="step__v">
          {step.usedSkills.length === 0
            ? <span class="dim">none</span>
            : step.usedSkills.map((name) => (
              <span key={name} class="skill" title={intended.has(name) ? "intended by this step" : "not intended by this step"}>
                {name}
                {!intended.has(name) && <span class="skill__tag">extra</span>}
              </span>
            ))}
        </span>
      </div>
      {step.unexpectedTools.length > 0 && (
        <p class="dim step__tools">tools outside the step{"\u2019"}s list: {step.unexpectedTools.join(", ")}</p>
      )}
    </li>
  );
}

function Steps({ comparison }: { comparison: FlowComparison }) {
  return (
    <section class="card ws__block" aria-labelledby="ws-steps">
      <h2 class="ws__h" id="ws-steps">Steps</h2>
      <ol class="steps">
        {comparison.steps.map((step) => <StepRow key={step.stepId} step={step} />)}
      </ol>
      {comparison.unplanned.length > 0 && (
        <p class="dim">
          Panes outside the spec: {comparison.unplanned.map((pane) => `${pane.paneId}${pane.usedSkills.length ? ` (${pane.usedSkills.join(", ")})` : ""}`).join(", ")}
        </p>
      )}
    </section>
  );
}

function Span({ span, usage }: { span: SkillSpan; usage: SkillSpanUsage | undefined }) {
  const rows = callRows(span.events);
  const attribution = usage ? attributionParts(usage.attribution) : [];
  return (
    <li class="span" data-span={span.id} data-skill={span.skill}>
      <div class="span__head">
        <span class="span__name" title={span.uri ?? "no skill uri reported"}>{span.name}</span>
        {attribution.length === 0
          ? <span class="tag tag--dim">no call attributed</span>
          : attribution.map((part) => <span key={part.key} class="tag" title={part.title}>{part.label} {part.value}</span>)}
      </div>
      <Facts facts={spanFacts(span, usage, rows.length)} className="facts span__facts" />
      <p class="span__tokens"><Tokens parts={tokenParts(usage?.tokens ?? [])} /></p>
      <CallList rows={rows} />
    </li>
  );
}

function Turn({ turn, index, finding, usageBySpan, open }: {
  turn: TurnTree; index: number; finding: TurnFindingDto | undefined; usageBySpan: Map<string, SkillSpanUsage>; open: boolean;
}) {
  const calls = turn.events.filter(isCall).length;
  return (
    <li>
      <details class="turn" open={open} data-turn={turn.id}>
        <summary class="turn__sum">
          <Chevron />
          <span class="turn__n">Turn {index + 1}</span>
          <time class="turn__time" dateTime={new Date(turn.startedAt).toISOString()}>{clockFmt.format(turn.startedAt)}</time>
          <span class="tag" title={BASIS_TITLE[turn.basis]}>{BASIS_LABEL[turn.basis]}</span>
          {finding && <span class="tag" title={FINDING_TITLE[finding.label]} data-finding={finding.label}>{FINDING_LABEL[finding.label]}</span>}
          <span class="turn__meta">{turn.skillSpans.length} {turn.skillSpans.length === 1 ? "skill span" : "skill spans"}</span>
        </summary>
        {turn.skillSpans.length === 0 ? (
          <p class="dim turn__none">No skill was active in this turn{calls > 0 ? `; ${calls} ${calls === 1 ? "call" : "calls"} ran without one` : ""}.</p>
        ) : (
          <ul class="spans">
            {turn.skillSpans.map((span) => <Span key={span.id} span={span} usage={usageBySpan.get(span.id)} />)}
          </ul>
        )}
      </details>
    </li>
  );
}

function Session({ link, session, route, findings, usageBySpan }: {
  link?: TreePaneLink & { basis: "reported" | "inferred" }; session: SessionTree; route: Route;
  findings: Map<string, TurnFindingDto>; usageBySpan: Map<string, SkillSpanUsage>;
}) {
  const open = turnsOpen(session.turns.length);
  return (
    <article class="sess" data-session={session.id}>
      <header class="sess__head">
        <Runtime runtime={session.runtime} />
        <a class="sess__link" href={buildHash({ view: "trace", sessionId: session.id, filter: route.filter })}>Open trace</a>
        <time class="sess__when" dateTime={new Date(session.startedAt).toISOString()}>{formatStarted(session.startedAt)}</time>
        <span class="tag" title={link ? link.basis === "reported" ? "herdr reported this pane's agent session" : "herdr did not report it; gisool inferred it from cwd and time" : "no herdr pane is linked to this session"}>
          {link?.basis ?? "outside herdr"}
        </span>
        <span class="sess__meta">{session.turns.length} {session.turns.length === 1 ? "turn" : "turns"}</span>
      </header>
      {session.turns.length === 0
        ? <p class="dim">No turn was recorded for this session.</p>
        : (
          <ol class="turns">
            {session.turns.map((turn, index) => (
              <Turn key={turn.id} turn={turn} index={index} finding={findings.get(turn.id)} usageBySpan={usageBySpan} open={open} />
            ))}
          </ol>
        )}
    </article>
  );
}

function Tree({ tree, route, findings, usageBySpan, filtered }: {
  tree: FlowTree; route: Route; findings: Map<string, TurnFindingDto>; usageBySpan: Map<string, SkillSpanUsage>; filtered: boolean;
}) {
  if (tree.sessions !== undefined) return (
    <section class="card ws__block" aria-labelledby="ws-sessions">
      <h2 class="ws__h" id="ws-sessions">Sessions</h2>
      {tree.sessions.length === 0 && <p class="dim">No sessions outside herdr in this range.</p>}
      {tree.sessions.map((session) => (
        <Session key={session.id} session={session} route={route} findings={findings} usageBySpan={usageBySpan} />
      ))}
    </section>
  );
  const panes = tree.tabs.reduce((n, tab) => n + tab.panes.length, 0);
  return (
    <section class="card ws__block" aria-labelledby="ws-panes">
      <h2 class="ws__h" id="ws-panes">Panes</h2>
      {panes === 0 ? (
        <p class="dim">herdr reported no pane for this workspace yet.</p>
      ) : (
        <ul class="tabsets">
          {tree.tabs.map((tab) => (
            <li key={tab.id} class="tabset">
              <p class="tabset__head">
                <span class="tabset__name">{tab.label ?? tab.id}</span>
                <span class="dim">{tab.panes.length} {tab.panes.length === 1 ? "pane" : "panes"}</span>
              </p>
              <ul class="panes">
                {tab.panes.map((pane) => (
                  <li key={pane.id}>
                    <details class="pane" open data-pane={pane.id}>
                      <summary class="pane__sum">
                        <Chevron />
                        <span class="pane__name">{pane.label ?? pane.id}</span>
                        <span class="pane__meta">{pane.sessions.length} {pane.sessions.length === 1 ? "session" : "sessions"}</span>
                      </summary>
                      <div class="pane__body">
                        {pane.sessions.length === 0 && (
                          <p class="dim">{filtered
                            ? "No agent session is shown for this pane; the automated ones are left out."
                            : "No agent session ran in this pane."}</p>
                        )}
                        {pane.sessions.map((link) => (
                          link.session === null
                            ? (
                              <p key={link.agentSessionValue} class="dim" data-unlinked={link.agentSessionValue}>
                                Agent session <code class="cmd">{link.agentSessionValue}</code> is not matched to a gisool session yet.
                              </p>
                            )
                            : <Session key={link.session.id} link={link} session={link.session} route={route} findings={findings} usageBySpan={usageBySpan} />
                        ))}
                      </div>
                    </details>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Header({ report, backHref, onRefresh, busy }: { report: FlowReportDto; backHref: string; onRefresh: () => void; busy: boolean }) {
  const panes = report.tree.tabs.reduce((n, tab) => n + tab.panes.length, 0);
  return (
    <header class="ws__head card">
      <a class="ws__back" href={backHref}>
        <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" focusable="false"><path d="m15 18-6-6 6-6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" /></svg>
        Workspaces
      </a>
      <h1 class="ws__title">{report.label ?? report.workspaceId}</h1>
      <dl class="ws__meta">
        {report.kind !== "outside_herdr" && <>
        <div>
          <dt>Workspace</dt>
          <dd class="ws__id">{report.workspaceId}</dd>
        </div>
        <div>
          <dt>Spec</dt>
          <dd class={report.spec ? undefined : "dim"}>{specLabel(report.spec)}</dd>
        </div>
        <div>
          <dt>Started</dt>
          <dd>{formatStarted(report.flow?.registeredMs ?? null)}</dd>
        </div>
        <div>
          <dt>Ended</dt>
          <dd class={report.flow?.endedMs ? undefined : "dim"}>{report.flow?.endedMs ? formatStarted(report.flow.endedMs) : "open"}</dd>
        </div>
        <div>
          <dt>Panes</dt>
          <dd>{panes}</dd>
        </div>
        </>}
        <div>
          <dt>Sessions</dt>
          <dd>{report.usage.sessions.length}</dd>
        </div>
      </dl>
      <Facts facts={summaryFacts(flowSummary(report))} className="facts ws__counts" />
      <div class="ws__actions">
        <span class="dim">as of {clockFmt.format(report.generatedAt)}</span>
        <button type="button" class="btn" onClick={onRefresh} disabled={busy}>{busy ? "Reading\u2026" : "Refresh"}</button>
      </div>
      {report.excludedSessions.length > 0 && (
        <p class="dim" data-excluded={report.excludedSessions.length}>
          {report.excludedSessions.length} automated {report.excludedSessions.length === 1 ? "session" : "sessions"} left out
          ({[...new Set(report.excludedSessions.map((session) => session.reason))].join(", ")}). Show automated sessions to include them.
        </p>
      )}
    </header>
  );
}

export function WorkspaceView({ route }: ViewProps) {
  const flowId = route.flowId ?? "";
  const backHref = buildHash({ view: "workspaces", filter: route.filter });
  const query = flowsQuery(route);
  const queryKey = JSON.stringify(query);
  const [report, setReport] = useState<FlowReportDto>();
  const [error, setError] = useState<string>();
  const [refresh, setRefresh] = useState(0);
  const [busy, setBusy] = useState(true);

  useEffect(() => {
    setReport(undefined);
    setError(undefined);
  }, [flowId, queryKey]);

  useEffect(() => {
    let cancelled = false;
    setBusy(true);
    api.flowReport(flowId, query)
      .then((dto) => {
        if (cancelled) return;
        setReport(dto);
        setError(undefined);
        setBusy(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        setBusy(false);
      });
    return () => { cancelled = true; };
  }, [flowId, queryKey, refresh]);

  if (error !== undefined) {
    return (
      <section class="ws">
        <p class="notice" role="alert">Could not load this flow: {error}</p>
        <a class="btn ws__backbtn" href={backHref}>Back to workspaces</a>
      </section>
    );
  }
  if (report === undefined) return <section class="ws" aria-busy="true" />;

  const { findings, usageBySpan } = reportIndex(report);
  return (
    <section class="ws" aria-busy="false">
      <Header report={report} backHref={backHref} onRefresh={() => setRefresh((n) => n + 1)} busy={busy} />
      {report.comparison && <Steps comparison={report.comparison} />}
      <Tree tree={report.tree} route={route} findings={findings} usageBySpan={usageBySpan} filtered={report.excludedSessions.length > 0} />
    </section>
  );
}

const WORKSPACES_CSS = `
.ws { display: grid; gap: var(--s-4); }
.ws__head { display: grid; gap: var(--s-3); padding: var(--s-4) var(--s-5); }
.ws__back { display: inline-flex; align-items: center; gap: var(--s-1); justify-self: start; min-height: 32px; color: var(--ink-2); font-size: var(--fs-sm); font-weight: 500; text-decoration: none; }
.ws__back:hover { color: var(--ink); }
.ws__backbtn { justify-self: start; text-decoration: none; }
.ws__title { margin: 0; font-size: var(--fs-title); font-weight: 600; letter-spacing: -0.01em; line-height: 1.4; overflow-wrap: anywhere; }
.ws__meta { display: flex; flex-wrap: wrap; gap: var(--s-3) var(--s-6); margin: 0; }
.ws__meta > div { display: grid; gap: var(--s-1); align-content: start; min-width: 0; }
.ws__meta dt { color: var(--ink-3); font-size: var(--fs-cap); font-weight: 500; }
.ws__meta dd { margin: 0; color: var(--ink); font-size: var(--fs-sm); font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
.ws__id { font-family: var(--font-mono); font-size: var(--fs-cap); color: var(--ink-2); }
.ws__actions { display: flex; flex-wrap: wrap; align-items: center; gap: var(--s-2) var(--s-3); }
.ws__block { padding: var(--s-4) var(--s-5); display: grid; gap: var(--s-3); }
.ws__h { margin: 0; color: var(--ink-3); font-size: var(--fs-cap); font-weight: 600; letter-spacing: 0.02em; text-transform: uppercase; }

.wslist { list-style: none; margin: 0; padding: 0; }
.wsrow { display: grid; grid-template-columns: minmax(min-content, auto) minmax(0, 1fr) auto; grid-template-areas: "title tag when" "meta meta when" "sum sum sum"; align-items: baseline; gap: var(--s-1) var(--s-3); padding: var(--s-3) var(--s-4); border-bottom: 1px solid var(--line); transition: background-color var(--t-micro); }
.wsrow:last-child { border-bottom: 0; }
.wsrow:hover, .wsrow:has(.wsrow__title:focus-visible) { background: var(--wash); }
.wsrow__title { grid-area: title; min-width: 0; color: var(--ink); font-size: var(--fs-sm); font-weight: 600; text-decoration: none; overflow-wrap: anywhere; }
.wsrow__title:hover { color: var(--ink); text-decoration: underline; }
.wsrow .tag { grid-area: tag; align-self: center; justify-self: start; }
.wsrow__when { grid-area: when; color: var(--ink-2); font-size: var(--fs-cap); font-variant-numeric: tabular-nums; white-space: nowrap; }
.wsrow__meta { grid-area: meta; }
.wsrow__sum { grid-area: sum; }

.steps { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--s-2); }
.step { display: grid; gap: var(--s-1); padding: var(--s-3); border: 1px solid var(--line); border-radius: var(--r-sm); }
.step__head { display: flex; flex-wrap: wrap; align-items: center; gap: var(--s-2); }
.step__id { color: var(--ink); font-family: var(--font-mono); font-size: var(--fs-sm); font-weight: 600; }
.step__row { display: flex; flex-wrap: wrap; align-items: baseline; gap: var(--s-1) var(--s-2); }
.step__k { min-width: 4.5rem; color: var(--ink-3); font-size: var(--fs-cap); }
.step__v { display: flex; flex-wrap: wrap; gap: var(--s-1); min-width: 0; }
.step__tools { margin: 0; }
.skill--missing { color: var(--ink-3); border-style: dashed; }
.skill__tag { margin-inline-start: var(--s-1); color: var(--ink-3); font-size: var(--fs-micro); font-weight: 500; }

.tabsets, .panes, .spans, .turns { list-style: none; margin: 0; padding: 0; }
.tabsets { display: grid; gap: var(--s-4); }
.tabset__head { display: flex; flex-wrap: wrap; align-items: baseline; gap: var(--s-2); margin: 0 0 var(--s-2); }
.tabset__name { color: var(--ink-2); font-size: var(--fs-cap); font-weight: 600; }
.panes { display: grid; gap: var(--s-2); }
.pane { border: 1px solid var(--line); border-radius: var(--r-sm); background: var(--surface); }
.pane__sum, .turn__sum { display: flex; flex-wrap: wrap; align-items: center; gap: var(--s-1) var(--s-2); cursor: pointer; list-style: none; border-radius: var(--r-sm); }
.pane__sum::-webkit-details-marker, .turn__sum::-webkit-details-marker { display: none; }
.pane__sum { padding: var(--s-2) var(--s-3); min-height: 36px; }
.pane__sum:hover, .turn__sum:hover { background: var(--wash); }
.pane__name { color: var(--ink); font-size: var(--fs-sm); font-weight: 600; overflow-wrap: anywhere; }
.pane__meta, .sess__meta, .turn__meta { color: var(--ink-3); font-size: var(--fs-cap); font-variant-numeric: tabular-nums; }
.pane__body { display: grid; gap: var(--s-3); padding: 0 var(--s-3) var(--s-3); }
.chev { color: var(--ink-3); flex: none; transition: transform var(--t-micro); }
details[open] > summary .chev { transform: rotate(90deg); }

.sess { display: grid; gap: var(--s-2); padding-inline-start: var(--s-3); border-inline-start: 1px solid var(--line); }
.sess__head { display: flex; flex-wrap: wrap; align-items: center; gap: var(--s-2) var(--s-3); }
.sess__link { font-size: var(--fs-cap); font-weight: 500; }
.sess__when { color: var(--ink-2); font-size: var(--fs-cap); font-variant-numeric: tabular-nums; white-space: nowrap; }

.turns { display: grid; gap: var(--s-1); }
.turn__sum { padding: var(--s-1) var(--s-2); min-height: 32px; }
.turn__n { color: var(--ink); font-size: var(--fs-sm); font-weight: 500; }
.turn__time { color: var(--ink-3); font-size: var(--fs-cap); font-variant-numeric: tabular-nums; }
.turn__none { margin: 0; padding: 0 var(--s-2) var(--s-2) var(--s-5); }

.spans { display: grid; gap: var(--s-2); padding: var(--s-1) 0 var(--s-2) var(--s-5); }
.span { display: grid; gap: var(--s-1); padding: var(--s-2) var(--s-3); border-radius: var(--r-sm); background: var(--wash); }
.span__head { display: flex; flex-wrap: wrap; align-items: center; gap: var(--s-2); }
.span__name { color: var(--ink); font-size: var(--fs-sm); font-weight: 600; overflow-wrap: anywhere; }
.span__tokens { display: flex; flex-wrap: wrap; gap: var(--s-1) var(--s-3); margin: 0; }

@media (max-width: 639.98px) {
  .ws__head, .ws__block { padding: var(--s-4); }
  .ws__meta { gap: var(--s-3) var(--s-5); }
  /* A spec name can be 64 characters, so the row stacks instead of racing the title against the tag. */
  .wsrow { grid-template-columns: minmax(0, 1fr); grid-template-areas: "title" "tag" "when" "meta" "sum"; }
  .spans, .turn__none { padding-inline-start: var(--s-3); }
}
`;

installStyles("workspaces", WORKSPACES_CSS);
