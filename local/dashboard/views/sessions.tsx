import { useEffect, useState } from "preact/hooks";
import type { AdoptionState, Filter, RuntimeId } from "../../src/types.js";
import { api, type SessionListRow, type Stats } from "../api";
import {
  ADOPTION_STATES, ATTRIBUTION_LABEL, RUNTIME_IDS, RUNTIME_LABEL, RUNTIME_MARK, STATE_LABEL, STATE_TITLE,
  buildHash, isEmptyFilter, serializeFilter, skillName, type Route, type ViewProps,
} from "../state";

const timeFmt = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });
const dateFmt = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
const dateTimeFmt = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });

function isSameLocalDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function formatDuration(ms: number): string {
  const minutes = Math.round(ms / 60e3);
  if (minutes < 1) return "<1m";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours}h ${rest}m` : `${hours}h`;
}

function When({ row }: { row: SessionListRow }) {
  const started = new Date(row.startedAt);
  const dateLabel = isSameLocalDay(started, new Date()) ? "Today" : dateFmt.format(started);
  return (
    <time class="when" dateTime={started.toISOString()} title={started.toLocaleString()}>
      <span class="when__date">{dateLabel}</span>
      <span class="when__time">{timeFmt.format(started)}</span>
      {row.endedAt !== undefined && <span class="when__dur">{formatDuration(row.endedAt - row.startedAt)}</span>}
    </time>
  );
}

function Runtime({ runtime }: { runtime: RuntimeId }) {
  const label = RUNTIME_LABEL[runtime] ?? RUNTIME_LABEL.unknown;
  return (
    <span class="rt">
      <span class="rt__mark" aria-hidden="true">{RUNTIME_MARK[runtime] ?? RUNTIME_MARK.unknown}</span>
      <span>{label}</span>
    </span>
  );
}

const MAX_SKILL_CHIPS = 3;

function Skills({ skills }: { skills: string[] }) {
  if (!skills.length) return <span class="skills__none">none</span>;
  const shown = skills.slice(0, MAX_SKILL_CHIPS);
  const more = skills.length - shown.length;
  return (
    <span class="skills">
      {shown.map((uri) => <span class="skill" key={uri} title={uri}>{skillName(uri)}</span>)}
      {more > 0 && <span class="skill skill--more" title={skills.slice(MAX_SKILL_CHIPS).map(skillName).join(", ")}>+{more}</span>}
    </span>
  );
}

function StateBadge({ state }: { state: AdoptionState }) {
  return <span class={`badge badge--${state}`} title={STATE_TITLE[state] ?? state}>{STATE_LABEL[state] ?? state}</span>;
}

function AttributionCell({ row }: { row: SessionListRow }) {
  if (row.attribution !== "none") return <span class="attr">{ATTRIBUTION_LABEL[row.attribution] ?? row.attribution}</span>;
  const tip = `unattributed: ${row.attributionReason ?? "reason not reported"}`;
  return (
    <span class="attr attr--none" tabIndex={0} data-tip={tip} aria-label={tip}>unattributed</span>
  );
}

function isInteractive(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest("a, button, input, select, [data-tip]") !== null;
}

function Row({ row, route, navigate }: { row: SessionListRow; route: Route; navigate: ViewProps["navigate"] }) {
  const target: Route = { view: "trace", sessionId: row.id, filter: route.filter };
  return (
    <tr onClick={(event) => { if (!isInteractive(event.target)) navigate(target); }}>
      <td class="c-runtime" data-label="Runtime"><Runtime runtime={row.runtime} /></td>
      <td class="c-started" data-label="Started"><When row={row} /></td>
      <td class="c-prompt" data-label="First prompt">
        <a class={row.firstPrompt ? "rowlink" : "rowlink rowlink--dim"} href={buildHash(target)}>
          {row.firstPrompt ?? "(no prompt captured)"}
        </a>
      </td>
      <td class="c-skills" data-label="Skills"><Skills skills={row.skills} /></td>
      <td class="c-state" data-label="State"><StateBadge state={row.state} /></td>
      <td class="c-attr" data-label="Attribution"><AttributionCell row={row} /></td>
    </tr>
  );
}

function WaitingEmpty({ stats }: { stats: Stats }) {
  const { ingest } = stats;
  return (
    <section class="empty" aria-live="polite">
      <h2>Waiting for the first event</h2>
      <p>
        No runtime has sent an event yet. Start a session in a connected runtime, or run
        {" "}<code class="cmd">gisool doctor</code> to check each connection.
      </p>
      <dl class="checklist">
        {RUNTIME_IDS.filter((id) => id !== "unknown").map((id) => {
          const ts = stats.lastEventByRuntime[id];
          return (
            <>
              <dt key={`${id}-k`}>{RUNTIME_LABEL[id]}</dt>
              <dd key={`${id}-v`} class={ts !== undefined ? "is-ok" : undefined}>{ts !== undefined ? `last event ${dateTimeFmt.format(ts)}` : "no events yet"}</dd>
            </>
          );
        })}
        <dt>Ingest</dt>
        <dd class={ingest.rejected || ingest.dropped ? "is-bad" : undefined}>
          {ingest.accepted} accepted, {ingest.rejected} rejected, {ingest.dropped} dropped
        </dd>
        {ingest.lastError && (
          <>
            <dt>Last error</dt>
            <dd class="is-bad">{ingest.lastError.code} at {dateTimeFmt.format(ingest.lastError.ts)}</dd>
          </>
        )}
      </dl>
    </section>
  );
}

function FilteredEmpty({ route, navigate }: { route: Route; navigate: ViewProps["navigate"] }) {
  return (
    <section class="empty">
      <h2>No sessions match these filters</h2>
      <p>Widen the time range or remove a filter to see more sessions.</p>
      <button type="button" class="btn" onClick={() => navigate({ ...route, filter: {} })}>Clear filters</button>
    </section>
  );
}

function NoSessionsEmpty() {
  return (
    <section class="empty">
      <h2>No sessions recorded yet</h2>
      <p>Events arrived but none opened a session. Start a prompt in a connected runtime, or run <code class="cmd">gisool doctor</code>.</p>
    </section>
  );
}

function Toolbar({ route, navigate, count }: { route: Route; navigate: ViewProps["navigate"]; count: number | undefined }) {
  const { filter } = route;
  const update = (patch: Filter) => {
    const next: Filter = { ...filter, ...patch };
    for (const key of Object.keys(next) as (keyof Filter)[]) if (next[key] === undefined) delete next[key];
    navigate({ ...route, filter: next });
  };
  return (
    <form
      class="toolbar"
      role="search"
      onSubmit={(event) => {
        event.preventDefault();
        const input = (event.currentTarget as HTMLFormElement).elements.namedItem("q") as HTMLInputElement | null;
        const q = input?.value.trim() ?? "";
        update({ q: q || undefined });
      }}
    >
      <input class="field field--search" type="search" name="q" placeholder="Search prompts and skills" aria-label="Search prompts and skills" value={filter.q ?? ""} />
      <select class="field field--select" aria-label="Runtime" value={filter.runtime?.length === 1 ? filter.runtime[0] : ""} onChange={(event) => { const v = (event.currentTarget as HTMLSelectElement).value as RuntimeId | ""; update({ runtime: v ? [v] : undefined }); }}>
        <option value="">All runtimes</option>
        {RUNTIME_IDS.map((id) => <option key={id} value={id}>{RUNTIME_LABEL[id]}</option>)}
      </select>
      <select class="field field--select" aria-label="Adoption state" value={filter.state?.length === 1 ? filter.state[0] : ""} onChange={(event) => { const v = (event.currentTarget as HTMLSelectElement).value as AdoptionState | ""; update({ state: v ? [v] : undefined }); }}>
        <option value="">All states</option>
        {ADOPTION_STATES.map((state) => <option key={state} value={state}>{STATE_LABEL[state]}</option>)}
      </select>
      {count !== undefined && <span class="toolbar__count">{count} {count === 1 ? "session" : "sessions"}</span>}
    </form>
  );
}

const LIVE_REFRESH_DEBOUNCE_MS = 300;

export function SessionsView({ route, navigate, live }: ViewProps) {
  const filterKey = serializeFilter(route.filter);
  const [rows, setRows] = useState<SessionListRow[]>();
  const [stats, setStats] = useState<Stats>();
  const [error, setError] = useState<string>();
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    if (live.seq === 0) return;
    const timer = setTimeout(() => setRefresh((n) => n + 1), LIVE_REFRESH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [live.seq]);

  useEffect(() => {
    let cancelled = false;
    Promise.all([api.sessions(route.filter), api.stats()])
      .then(([nextRows, nextStats]) => {
        if (cancelled) return;
        setRows(nextRows);
        setStats(nextStats);
        setError(undefined);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => { cancelled = true; };
  }, [filterKey, refresh]);

  let body;
  if (rows === undefined) {
    body = null;
  } else if (rows.length === 0 && stats && stats.lastEventTs === undefined) {
    body = <WaitingEmpty stats={stats} />;
  } else if (rows.length === 0 && !isEmptyFilter(route.filter)) {
    body = <FilteredEmpty route={route} navigate={navigate} />;
  } else if (rows.length === 0) {
    body = <NoSessionsEmpty />;
  } else {
    body = (
      <div class="card">
        <table class="sessions">
          <colgroup>
            <col style="width:15%" />
            <col style="width:10%" />
            <col />
            <col style="width:20%" />
            <col style="width:13%" />
            <col style="width:12%" />
          </colgroup>
          <thead>
            <tr>
              <th scope="col">Runtime</th>
              <th scope="col">Started</th>
              <th scope="col">First prompt</th>
              <th scope="col">Skills</th>
              <th scope="col">State</th>
              <th scope="col">Attribution</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => <Row key={row.id} row={row} route={route} navigate={navigate} />)}
          </tbody>
        </table>
      </div>
    );
  }

  return (
    <section aria-busy={rows === undefined}>
      <Toolbar route={route} navigate={navigate} count={rows?.length} />
      {error && <p class="notice" role="alert">Could not load sessions: {error}</p>}
      {body}
    </section>
  );
}
