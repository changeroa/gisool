import { useEffect, useState } from "preact/hooks";
import type { AbstainReason, EventKind, RuntimeId, SearchMode, SkillUri, TraceStep } from "../../src/types.js";
import { api, type SessionListRow } from "../api";
import { Candidates, type CandidateLike } from "../components/candidates";
import { ATTRIBUTION_LABEL, RUNTIME_LABEL, RUNTIME_MARK, STATE_LABEL, STATE_TITLE, buildHash, skillName, type ViewProps } from "../state";

// Session trace view (todo 15): header + narrative timeline + candidates panel + "Save as eval case".
// The SSE stream only carries `session` rows (contract), so a live update for the open session
// refetches /api/sessions/:id/trace and the timeline grows by the steps that arrived.
// The stylesheet lives here (injected once) because styles.css belongs to todo 6 in this wave;
// every value traces to a token in DESIGN.md.

export type SearchDetail = {
  kind: "search"; traceId: string; chosen: SkillUri[]; query: string; mode: SearchMode; candidates: CandidateLike[];
  abstained?: { reason: AbstainReason; hint: string }; elapsedMs: number; total: number;
};
type PromptDetail = { kind: "prompt"; text?: string; textLength?: number };
type LoadDetail = { kind: "load"; uri: SkillUri; loadId: string; manifestDigest: string };
type ReadDetail = { kind: "read_file"; skillUri: SkillUri; uri: SkillUri; bytes: number };
type NativeDetail = { kind: "native_skill"; name: string; via: string };
type ErrorDetail = { kind: "error"; code: string; message: string };

export const PROMPT_FOLD_CHARS = 600;
export const SHORT_DIGEST_CHARS = 8;

export const KIND_LABEL: Record<EventKind, string> = {
  session_start: "Session started",
  prompt: "Prompt",
  search: "Searched gisool",
  load: "Loaded skill",
  read_file: "Read resource",
  native_skill: "Native skill",
  session_end: "Session ended",
  error: "Error",
};
export const MODE_LABEL: Record<SearchMode, string> = { discovery: "discovery", automatic: "automatic", explicit: "explicit" };
export const ABSTAIN_LABEL: Record<AbstainReason, string> = {
  empty_query: "empty query", no_overlap: "no overlap", below_threshold: "below threshold", explicit_only: "explicit only",
};
export const NEVER_CONSULTED = "This session never consulted gisool";

export type TraceCounts = { steps: number; searches: number; abstained: number; loads: number; reads: number; natives: number; errors: number };

export function traceCounts(steps: readonly TraceStep[]): TraceCounts {
  const counts: TraceCounts = { steps: steps.length, searches: 0, abstained: 0, loads: 0, reads: 0, natives: 0, errors: 0 };
  for (const step of steps) {
    switch (step.kind) {
      case "search": counts.searches += 1; if (step.detail.abstained) counts.abstained += 1; break;
      case "load": counts.loads += 1; break;
      case "read_file": counts.reads += 1; break;
      case "native_skill": counts.natives += 1; break;
      case "error": counts.errors += 1; break;
      default: break;
    }
  }
  return counts;
}

export function sessionBounds(steps: readonly TraceStep[], row?: Pick<SessionListRow, "startedAt" | "endedAt">): { startedAt?: number; endedAt?: number; lastTs?: number } {
  const first = steps[0];
  const last = steps[steps.length - 1];
  const end = steps.find((step) => step.kind === "session_end");
  return {
    startedAt: row?.startedAt ?? first?.ts,
    endedAt: row?.endedAt ?? end?.ts,
    lastTs: last?.ts,
  };
}

export function formatDuration(ms: number): string {
  const minutes = Math.round(ms / 60e3);
  if (minutes < 1) return "<1m";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours}h ${rest}m` : `${hours}h`;
}

export function formatOffset(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "";
  if (ms < 10e3) return `+${(ms / 1e3).toFixed(1)}s`;
  if (ms < 60e3) return `+${Math.round(ms / 1e3)}s`;
  const totalSeconds = Math.round(ms / 1e3);
  const minutes = Math.floor(totalSeconds / 60);
  if (minutes < 60) return `+${minutes}m ${String(totalSeconds % 60).padStart(2, "0")}s`;
  const hours = Math.floor(minutes / 60);
  return `+${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "-";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** First SHORT_DIGEST_CHARS hex chars; catalog digests carry a `sha256:` prefix that is not part of the hash. */
export function shortDigest(digest: string): string {
  return digest ? digest.replace(/^sha256[:-]/, "").slice(0, SHORT_DIGEST_CHARS) : "";
}

/** Search latency as the timeline shows it: sub-millisecond keeps two decimals, under 100 ms one, above that whole ms. */
export function formatMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "-";
  if (ms < 1) return `${ms.toFixed(2)} ms`;
  if (ms < 100) return `${ms.toFixed(1)} ms`;
  return `${Math.round(ms)} ms`;
}

export function resourcePath(skillUri: string, uri: string): string {
  const dir = skillUri.replace(/\/SKILL\.md$/i, "");
  if (dir && uri.startsWith(`${dir}/`)) return uri.slice(dir.length + 1);
  return uri;
}

export function foldText(text: string, limit = PROMPT_FOLD_CHARS): { head: string; folded: boolean } {
  const chars = Array.from(text);
  if (chars.length <= limit) return { head: text, folded: false };
  return { head: chars.slice(0, limit).join(""), folded: true };
}

export function isSearchStep(step: TraceStep): step is TraceStep & { detail: SearchDetail } {
  return step.kind === "search";
}

export function searchDetail(step: TraceStep): SearchDetail {
  const detail = step.detail as Partial<SearchDetail>;
  return {
    kind: "search",
    traceId: typeof detail.traceId === "string" ? detail.traceId : "",
    chosen: Array.isArray(detail.chosen) ? detail.chosen : [],
    query: typeof detail.query === "string" ? detail.query : "",
    mode: detail.mode ?? "automatic",
    candidates: Array.isArray(detail.candidates) ? detail.candidates : [],
    abstained: detail.abstained,
    elapsedMs: Number(detail.elapsedMs ?? 0),
    total: Number(detail.total ?? (Array.isArray(detail.candidates) ? detail.candidates.length : 0)),
  };
}

export function evalCasePayload(detail: Pick<SearchDetail, "query" | "traceId">): { query: string; fromTraceId?: string } {
  return detail.traceId ? { query: detail.query, fromTraceId: detail.traceId } : { query: detail.query };
}

export function firstPromptOf(steps: readonly TraceStep[], row?: Pick<SessionListRow, "firstPrompt">): string | undefined {
  if (row?.firstPrompt) return row.firstPrompt;
  const prompt = steps.find((step) => step.kind === "prompt");
  const text = (prompt?.detail as PromptDetail | undefined)?.text;
  return text || undefined;
}

const timeFmt = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
const dateTimeFmt = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });

function Runtime({ runtime }: { runtime: RuntimeId }) {
  return (
    <span class="rt">
      <span class="rt__mark" aria-hidden="true">{RUNTIME_MARK[runtime] ?? RUNTIME_MARK.unknown}</span>
      <span>{RUNTIME_LABEL[runtime] ?? RUNTIME_LABEL.unknown}</span>
    </span>
  );
}

function Header({ sessionId, row, steps, backHref, liveState }: { sessionId: string; row?: SessionListRow; steps: TraceStep[]; backHref: string; liveState: ViewProps["live"]["state"] }) {
  const bounds = sessionBounds(steps, row);
  const counts = traceCounts(steps);
  const title = firstPromptOf(steps, row);
  const runtime = row?.runtime;
  let duration: string;
  if (bounds.startedAt === undefined) duration = "-";
  else if (bounds.endedAt !== undefined) duration = formatDuration(bounds.endedAt - bounds.startedAt);
  else if (liveState === "live") duration = `in progress \u00b7 ${formatDuration((bounds.lastTs ?? bounds.startedAt) - bounds.startedAt)} so far`;
  else duration = `${formatDuration((bounds.lastTs ?? bounds.startedAt) - bounds.startedAt)} (no end recorded)`;
  const attribution = row
    ? row.attribution === "none"
      ? `unattributed \u00b7 ${row.attributionReason ?? "reason not reported"}`
      : ATTRIBUTION_LABEL[row.attribution] ?? row.attribution
    : "-";
  const parts = [
    `${counts.steps} ${counts.steps === 1 ? "step" : "steps"}`,
    `${counts.searches} ${counts.searches === 1 ? "search" : "searches"}`,
    `${counts.loads} ${counts.loads === 1 ? "load" : "loads"}`,
  ];
  if (counts.reads) parts.push(`${counts.reads} ${counts.reads === 1 ? "file read" : "file reads"}`);
  if (counts.natives) parts.push(`${counts.natives} native`);
  if (counts.errors) parts.push(`${counts.errors} ${counts.errors === 1 ? "error" : "errors"}`);
  return (
    <header class="trace__head card">
      <a class="trace__back" href={backHref}>
        <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" focusable="false"><path d="m15 18-6-6 6-6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" /></svg>
        Sessions
      </a>
      <h1 class={title ? "trace__title" : "trace__title trace__title--dim"}>{title ?? "(no prompt captured)"}</h1>
      <dl class="trace__meta">
        <div>
          <dt>Runtime</dt>
          <dd>{runtime ? <Runtime runtime={runtime} /> : <span class="trace__dim">unknown</span>}</dd>
        </div>
        <div>
          <dt>Started</dt>
          <dd>{bounds.startedAt !== undefined ? <time dateTime={new Date(bounds.startedAt).toISOString()}>{dateTimeFmt.format(bounds.startedAt)}</time> : "-"}</dd>
        </div>
        <div>
          <dt>Duration</dt>
          <dd>{duration}</dd>
        </div>
        <div>
          <dt>Attribution</dt>
          <dd class={row?.attribution === "none" ? "trace__dim" : undefined}>{attribution}</dd>
        </div>
        {row && (
          <div>
            <dt>State</dt>
            <dd><span class={`badge badge--${row.state}`} title={STATE_TITLE[row.state] ?? row.state}>{STATE_LABEL[row.state] ?? row.state}</span></dd>
          </div>
        )}
        <div>
          <dt>Session</dt>
          <dd class="trace__id">{sessionId}</dd>
        </div>
      </dl>
      <p class="trace__counts">{parts.join(" \u00b7 ")}</p>
    </header>
  );
}

function StepTime({ ts, startedAt }: { ts: number; startedAt?: number }) {
  const offset = startedAt !== undefined ? formatOffset(ts - startedAt) : "";
  return (
    <time class="tl__time" dateTime={new Date(ts).toISOString()} title={new Date(ts).toLocaleString()}>
      <b>{timeFmt.format(ts)}</b>
      {offset && <span class="tl__offset">{offset}</span>}
    </time>
  );
}

function PromptBody({ detail }: { detail: PromptDetail }) {
  const [open, setOpen] = useState(false);
  if (!detail.text) {
    return <p class="tl__dim">(prompt not captured{detail.textLength !== undefined ? `, ${detail.textLength} chars` : ""})</p>;
  }
  const { head, folded } = foldText(detail.text);
  return (
    <div>
      <p class="tl__text">{open || !folded ? detail.text : `${head}\u2026`}</p>
      {folded && (
        <button type="button" class="foldbtn" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          {open ? "Show less" : `Show more (${Array.from(detail.text).length} chars)`}
        </button>
      )}
    </div>
  );
}

type SaveState = { status: "idle" | "saving" | "saved" } | { status: "error"; message: string };

function SaveEvalButton({ detail }: { detail: SearchDetail }) {
  const [state, setState] = useState<SaveState>({ status: "idle" });
  const save = () => {
    setState({ status: "saving" });
    api.addEvalCase(evalCasePayload(detail))
      .then(() => setState({ status: "saved" }))
      .catch((err: unknown) => setState({ status: "error", message: err instanceof Error ? err.message : String(err) }));
  };
  const saved = state.status === "saved";
  return (
    <div class="tl__save">
      <button type="button" class="btn" data-save-eval={state.status} disabled={state.status === "saving" || saved} onClick={save}>
        {saved && <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" focusable="false"><path d="M20 6 9 17l-5-5" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" /></svg>}
        {saved ? "Saved as eval case" : state.status === "saving" ? "Saving\u2026" : "Save as eval case"}
      </button>
      {state.status === "error" && <span class="tl__err" role="alert">Could not save: {state.message}</span>}
    </div>
  );
}

function SearchBody({ detail }: { detail: SearchDetail }) {
  const shown = detail.candidates.length;
  const countText = detail.abstained
    ? "abstained"
    : detail.total > shown ? `top ${shown} of ${detail.total}` : `${shown} ${shown === 1 ? "candidate" : "candidates"}`;
  return (
    <div>
      <p class="tl__meta tl__meta--row">
        <span class="tl__mode" title={`mode: ${detail.mode}`}>{MODE_LABEL[detail.mode] ?? detail.mode}</span>
        <span>{formatMs(detail.elapsedMs)}</span>
        <span>{countText}</span>
        {detail.traceId && <span class="tl__id" title="trace id">{detail.traceId}</span>}
      </p>
      <blockquote class="tl__query">{detail.query || <span class="tl__dim">(empty query)</span>}</blockquote>
      {detail.abstained ? (
        <div class="tl__abstain" data-abstained={detail.abstained.reason}>
          <div class="tl__abstain-head">
            <span class="badge badge--no_match">abstained {"\u00b7"} {ABSTAIN_LABEL[detail.abstained.reason] ?? detail.abstained.reason}</span>
          </div>
          <p class="tl__hint">{detail.abstained.hint}</p>
          <SaveEvalButton detail={detail} />
        </div>
      ) : (
        <Candidates candidates={detail.candidates} chosen={detail.chosen} />
      )}
    </div>
  );
}

function LoadBody({ detail }: { detail: LoadDetail }) {
  return (
    <p class="tl__line">
      <span class="tl__name">{skillName(detail.uri)}</span>
      <span class="tl__uri">{detail.uri}</span>
      {detail.manifestDigest && <span class="tl__digest" title={`manifest ${detail.manifestDigest}`}>@{shortDigest(detail.manifestDigest)}</span>}
    </p>
  );
}

function ReadBody({ detail }: { detail: ReadDetail }) {
  return (
    <p class="tl__line">
      <span class="tl__name tl__name--mono">{resourcePath(detail.skillUri, detail.uri)}</span>
      <span class="tl__meta">{formatBytes(detail.bytes)}</span>
      {detail.skillUri && <span class="tl__meta">from {skillName(detail.skillUri)}</span>}
    </p>
  );
}

function NativeBody({ detail }: { detail: NativeDetail }) {
  return (
    <p class="tl__line">
      <span class="tl__name">{detail.name}</span>
      <span class="tl__meta">via {detail.via}</span>
    </p>
  );
}

function ErrorBody({ detail }: { detail: ErrorDetail }) {
  return (
    <p class="tl__line">
      <span class="tl__code">{detail.code}</span>
      <span class="tl__errmsg">{detail.message}</span>
    </p>
  );
}

function StepBody({ step, bounds }: { step: TraceStep; bounds: ReturnType<typeof sessionBounds> }) {
  switch (step.kind) {
    case "prompt": return <PromptBody detail={step.detail as PromptDetail} />;
    case "search": return <SearchBody detail={searchDetail(step)} />;
    case "load": return <LoadBody detail={step.detail as LoadDetail} />;
    case "read_file": return <ReadBody detail={step.detail as ReadDetail} />;
    case "native_skill": return <NativeBody detail={step.detail as NativeDetail} />;
    case "error": return <ErrorBody detail={step.detail as ErrorDetail} />;
    case "session_end":
      return bounds.startedAt !== undefined ? <p class="tl__meta">after {formatDuration(step.ts - bounds.startedAt)}</p> : null;
    case "session_start":
      return null;
    default:
      return <p class="tl__meta">{step.summary}</p>;
  }
}

function Step({ step, bounds }: { step: TraceStep; bounds: ReturnType<typeof sessionBounds> }) {
  const search = step.kind === "search" ? searchDetail(step) : undefined;
  const hollow = step.kind === "read_file" || step.kind === "native_skill";
  return (
    <li class={`tl__step tl__step--${step.kind}`} data-kind={step.kind}>
      <span class={hollow ? "tl__dot tl__dot--hollow" : "tl__dot"} aria-hidden="true" />
      <div class="tl__head">
        <span class="tl__kind">{KIND_LABEL[step.kind] ?? step.kind}</span>
        {step.kind === "native_skill" && <span class="tl__tag" title="handled by the runtime's own skill mechanism, not gisool">native</span>}
        {search?.abstained && <span class="tl__tag tl__tag--bad">abstained</span>}
        <StepTime ts={step.ts} startedAt={bounds.startedAt} />
      </div>
      <div class="tl__body">
        <StepBody step={step} bounds={bounds} />
      </div>
    </li>
  );
}

function NotFound({ sessionId, backHref }: { sessionId: string; backHref: string }) {
  return (
    <section class="empty empty--trace">
      <h2>Session not found</h2>
      <p>No events are recorded for <code class="cmd">{sessionId}</code>. It may have been removed by retention, or the link is stale.</p>
      <a class="btn" href={backHref}>Back to sessions</a>
    </section>
  );
}

function NeverConsulted({ counts }: { counts: TraceCounts }) {
  return (
    <div class="callout" role="status" data-empty="never-consulted">
      <strong>{NEVER_CONSULTED}</strong>
      <span>
        No skill search was recorded, so no candidates were ranked.
        {counts.natives ? ` The runtime handled ${counts.natives === 1 ? "one skill" : `${counts.natives} skills`} natively.` : ""}
      </span>
    </div>
  );
}

const STYLE_ID = "gisool-trace-style";

function ensureStyles() {
  if (typeof document === "undefined" || document.getElementById(STYLE_ID)) return;
  const el = document.createElement("style");
  el.id = STYLE_ID;
  el.textContent = TRACE_CSS;
  document.head.append(el);
}

export function TraceView({ route, live }: ViewProps) {
  ensureStyles();
  const sessionId = route.sessionId ?? "";
  const backHref = buildHash({ view: "sessions", filter: route.filter });
  const [steps, setSteps] = useState<TraceStep[]>();
  const [row, setRow] = useState<SessionListRow>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    let cancelled = false;
    setSteps(undefined);
    setRow(undefined);
    Promise.all([api.trace(sessionId), api.sessions({})])
      .then(([trace, rows]) => {
        if (cancelled) return;
        setSteps(trace);
        setRow(rows.find((r) => r.id === sessionId));
        setError(undefined);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => { cancelled = true; };
  }, [sessionId]);

  useEffect(() => {
    if (live.seq === 0 || !live.last || live.last.id !== sessionId) return;
    setRow(live.last);
    let cancelled = false;
    api.trace(sessionId)
      .then((trace) => {
        if (cancelled) return;
        setSteps(trace);
        setError(undefined);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => { cancelled = true; };
  }, [live.seq, sessionId]);

  if (steps === undefined) {
    return (
      <section class="trace" aria-busy="true">
        {error && <p class="notice" role="alert">Could not load the trace: {error}</p>}
      </section>
    );
  }
  if (steps.length === 0 && !row) return <NotFound sessionId={sessionId} backHref={backHref} />;

  const bounds = sessionBounds(steps, row);
  const counts = traceCounts(steps);
  return (
    <section class="trace" aria-busy="false">
      {error && <p class="notice" role="alert">Live update failed: {error}</p>}
      <Header sessionId={sessionId} row={row} steps={steps} backHref={backHref} liveState={live.state} />
      {counts.searches === 0 && <NeverConsulted counts={counts} />}
      {steps.length > 0 && (
        <div class="card tl__card">
          <ol class="tl" aria-label="Session timeline">
            {steps.map((step, index) => <Step key={`${step.ts}-${index}-${step.kind}`} step={step} bounds={bounds} />)}
          </ol>
        </div>
      )}
    </section>
  );
}

const TRACE_CSS = `
.trace { display: grid; gap: var(--s-4); }
.trace__head { display: grid; gap: var(--s-3); padding: var(--s-4) var(--s-5); }
.trace__back { display: inline-flex; align-items: center; gap: var(--s-1); justify-self: start; min-height: 32px; color: var(--ink-2); font-size: var(--fs-sm); font-weight: 500; text-decoration: none; }
.trace__back:hover { color: var(--ink); }
.trace__title { margin: 0; font-size: var(--fs-title); font-weight: 600; letter-spacing: -0.01em; line-height: 1.4; }
.trace__title--dim { color: var(--ink-3); font-style: italic; font-weight: 400; }
.trace__meta { display: flex; flex-wrap: wrap; gap: var(--s-3) var(--s-6); margin: 0; }
.trace__meta > div { display: grid; gap: var(--s-1); align-content: start; }
.trace__meta dt { color: var(--ink-3); font-size: var(--fs-cap); font-weight: 500; }
.trace__meta dd { margin: 0; color: var(--ink); font-size: var(--fs-sm); font-variant-numeric: tabular-nums; }
.trace__dim { color: var(--ink-3); }
.trace__id { font-family: var(--font-mono); font-size: var(--fs-cap); color: var(--ink-2); }
.trace__counts { margin: 0; color: var(--ink-3); font-size: var(--fs-cap); font-variant-numeric: tabular-nums; }
.empty--trace .btn { text-decoration: none; }
.callout { display: grid; gap: var(--s-1); padding: var(--s-3) var(--s-4); border: 1px solid var(--line); border-radius: var(--r-md); background: var(--surface); color: var(--ink-2); font-size: var(--fs-sm); }
.callout strong { color: var(--ink); font-weight: 600; }
.tl__card { padding: var(--s-4) var(--s-5); }
.tl { --dot-top: calc(var(--s-2) + 6px); list-style: none; margin: 0; padding: 0 0 0 var(--s-6); }
.tl__step { --dot: var(--neutral); position: relative; padding-block: var(--s-2) var(--s-4); }
.tl__step:last-child { padding-bottom: var(--s-2); }
.tl__step::before { content: ""; position: absolute; top: 0; bottom: 0; left: calc(var(--s-1) - 1px - var(--s-6)); width: 2px; background: var(--line-2); }
.tl__step:first-child::before { top: var(--dot-top); }
.tl__step:last-child::before { bottom: auto; height: var(--dot-top); }
.tl__step:only-child::before { display: none; }
.tl__step--prompt { --dot: var(--ink); }
.tl__step--search { --dot: var(--accent); }
.tl__step--load, .tl__step--read_file { --dot: var(--ok); }
.tl__step--native_skill { --dot: var(--warn); }
.tl__step--error { --dot: var(--bad); }
.tl__dot { position: absolute; left: calc(-1 * var(--s-6)); top: var(--dot-top); width: var(--s-2); height: var(--s-2); border-radius: 50%; background: var(--dot); box-shadow: 0 0 0 2px var(--surface); }
.tl__dot--hollow { background: var(--surface); box-shadow: inset 0 0 0 2px var(--dot), 0 0 0 2px var(--surface); }
.tl__head { display: flex; flex-wrap: wrap; align-items: baseline; gap: var(--s-1) var(--s-2); }
.tl__kind { color: var(--ink); font-size: var(--fs-sm); font-weight: 600; }
.tl__tag { display: inline-flex; align-items: center; height: 18px; padding: 0 var(--s-2); border: 1px solid var(--line); border-radius: var(--r-full); background: var(--surface-2); color: var(--ink-2); font: 600 var(--fs-micro) / 1 var(--font-mono); letter-spacing: 0.02em; text-transform: uppercase; }
.tl__tag--bad { color: var(--bad); background: color-mix(in srgb, var(--bad) 12%, transparent); border-color: transparent; }
.tl__time { display: inline-flex; gap: var(--s-2); margin-inline-start: auto; color: var(--ink-3); font-size: var(--fs-cap); font-variant-numeric: tabular-nums; white-space: nowrap; }
.tl__time b { color: var(--ink-2); font-weight: 500; }
.tl__body { margin-top: var(--s-1); color: var(--ink-2); font-size: var(--fs-sm); }
.tl__body > :first-child { margin-top: 0; }
.tl__text { margin: 0; color: var(--ink); white-space: pre-wrap; }
.tl__dim { margin: 0; color: var(--ink-3); font-style: italic; }
.tl__line { display: flex; flex-wrap: wrap; align-items: baseline; gap: var(--s-1) var(--s-2); margin: 0; }
.tl__name { color: var(--ink); font-weight: 500; }
.tl__name--mono { font-family: var(--font-mono); font-size: var(--fs-cap); }
.tl__uri, .tl__digest, .tl__id, .tl__code { font-family: var(--font-mono); font-size: var(--fs-cap); color: var(--ink-3); overflow-wrap: anywhere; }
.tl__code { color: var(--bad); font-weight: 500; }
.tl__errmsg { color: var(--ink-2); }
.tl__meta { margin: 0; color: var(--ink-3); font-size: var(--fs-cap); }
.tl__meta--row { display: flex; flex-wrap: wrap; gap: var(--s-1) var(--s-3); }
.tl__mode { color: var(--ink-2); font-weight: 500; }
.tl__query { margin: var(--s-2) 0 0; padding: var(--s-2) var(--s-3); border-radius: var(--r-sm); background: var(--wash); color: var(--ink); font-size: var(--fs-sm); }
.tl__abstain { display: grid; gap: var(--s-2); margin-top: var(--s-2); padding: var(--s-3); border: 1px solid var(--line); border-radius: var(--r-sm); background: var(--surface); }
.tl__abstain-head { display: flex; flex-wrap: wrap; gap: var(--s-2); }
.tl__hint { margin: 0; color: var(--ink-2); }
.tl__save { display: flex; flex-wrap: wrap; align-items: center; gap: var(--s-2); }
.tl__save .btn[disabled] { cursor: default; color: var(--ink-2); }
.tl__save .btn[data-save-eval="saved"] { color: var(--ok); }
.tl__err { color: var(--bad); font-size: var(--fs-cap); }
.foldbtn { margin-top: var(--s-1); padding: 0; border: 0; background: none; color: var(--accent); font-size: var(--fs-cap); font-weight: 500; cursor: pointer; }
.foldbtn:hover { color: var(--accent-2); }
.cands { display: grid; gap: var(--s-1); list-style: none; margin: var(--s-2) 0 0; padding: 0; }
.cands__none { margin: var(--s-2) 0 0; color: var(--ink-3); font-size: var(--fs-cap); }
.cand { display: grid; grid-template-columns: var(--s-5) minmax(0, 11rem) auto minmax(4rem, 1fr) 2.6em var(--s-5); grid-template-areas: "rank name inv bar score pick" "rank desc desc desc desc desc"; align-items: center; column-gap: var(--s-2); padding: var(--s-2); border-radius: var(--r-sm); font-size: var(--fs-sm); }
.cand--chosen { background: var(--wash); }
.cand__rank { grid-area: rank; align-self: start; color: var(--ink-3); font-size: var(--fs-cap); line-height: 1.6; font-variant-numeric: tabular-nums; text-align: right; }
.cand__name { grid-area: name; color: var(--ink); font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cand__inv { grid-area: inv; display: inline-flex; align-items: center; height: 18px; padding: 0 var(--s-1); border: 1px solid var(--line); border-radius: var(--r-sm); background: var(--surface-2); color: var(--ink-2); font: 600 var(--fs-micro) / 1 var(--font-mono); letter-spacing: 0.02em; text-transform: uppercase; }
.cand__bar { grid-area: bar; display: block; height: 6px; border-radius: var(--r-full); background: var(--wash-2); overflow: hidden; }
.cand__fill { display: block; height: 100%; border-radius: inherit; background: color-mix(in srgb, var(--ink) 35%, transparent); }
.cand--chosen .cand__fill { background: var(--ok); }
.cand__score { grid-area: score; color: var(--ink); font-size: var(--fs-cap); font-weight: 500; font-variant-numeric: tabular-nums; text-align: right; }
.cand__pick { grid-area: pick; display: grid; place-items: center; width: var(--s-5); height: var(--s-5); color: var(--ok); }
.cand__desc { grid-area: desc; color: var(--ink-3); font-size: var(--fs-cap); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cand__matched { color: var(--ink-2); }
@media (max-width: 639.98px) {
  .trace__head, .tl__card { padding: var(--s-4); }
  .trace__meta { gap: var(--s-3) var(--s-5); }
  .tl__time { flex-basis: 100%; margin-inline-start: 0; }
  .cand { grid-template-columns: var(--s-5) minmax(0, 1fr) auto 2.6em var(--s-5); grid-template-areas: "rank name inv score pick" "rank bar bar bar bar" "rank desc desc desc desc"; row-gap: var(--s-1); }
  .cand__desc { white-space: normal; }
}
`;
