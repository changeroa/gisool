import { render } from "preact";
import { useCallback, useEffect, useState } from "preact/hooks";
import type { Filter } from "../src/types.js";
import { api, type LiveState, type SessionListRow } from "./api";
import {
  DOW_LABEL, FILTER_KEYS, RUNTIME_LABEL, STATE_LABEL, buildHash, parseHash, skillName, withoutFilterKey,
  type FilterKey, type LiveInfo, type Route, type View,
} from "./state";
import { FlowView } from "./views/flow";
import { HeatmapView } from "./views/heatmap";
import { SessionsView } from "./views/sessions";
import { TraceView } from "./views/trace";
import { WorkspaceView, WorkspacesView } from "./views/workspaces";

function useRoute(): [Route, (next: Route) => void] {
  const [route, setRoute] = useState<Route>(() => parseHash(location.hash));
  useEffect(() => {
    const onChange = () => setRoute(parseHash(location.hash));
    addEventListener("hashchange", onChange);
    return () => removeEventListener("hashchange", onChange);
  }, []);
  const navigate = useCallback((next: Route) => {
    location.hash = buildHash(next);
  }, []);
  return [route, navigate];
}

function useLive(): LiveInfo {
  const [live, setLive] = useState<LiveInfo>({ state: "connecting", seq: 0 });
  useEffect(() => api.events({
    onState: (state: LiveState) => setLive((prev) => (prev.state === state ? prev : { ...prev, state })),
    onSession: (row: SessionListRow) => setLive((prev) => ({ ...prev, seq: prev.seq + 1, last: row })),
  }), []);
  return live;
}

const LIVE_TEXT: Record<LiveState, string> = { connecting: "connecting", live: "live", offline: "offline", fixtures: "fixtures" };

const dateTime = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });

type Chip = { key: FilterKey; label: string; value: string };

function chipsFor(filter: Filter): Chip[] {
  const chips: Chip[] = [];
  for (const key of FILTER_KEYS) {
    const value = filter[key];
    if (value === undefined) continue;
    switch (key) {
      case "from": chips.push({ key, label: "from", value: dateTime.format(value as number) }); break;
      case "to": chips.push({ key, label: "to", value: dateTime.format(value as number) }); break;
      case "runtime": chips.push({ key, label: "runtime", value: filter.runtime!.map((r) => RUNTIME_LABEL[r]).join(", ") }); break;
      case "skill": chips.push({ key, label: "skill", value: filter.skill!.map(skillName).join(", ") }); break;
      case "state": chips.push({ key, label: "state", value: filter.state!.map((s) => STATE_LABEL[s]).join(", ") }); break;
      case "dow": chips.push({ key, label: "day", value: DOW_LABEL[value as number] ?? String(value) }); break;
      case "hour": {
        const span = filter.hourSpan ?? 1;
        chips.push({ key, label: "hour", value: `${String(value).padStart(2, "0")}:00-${String(((value as number) + span) % 24).padStart(2, "0")}:00` });
        break;
      }
      case "hourSpan": break;
      case "q": chips.push({ key, label: "search", value: String(value) }); break;
      case "automated": chips.push({ key, label: "automated", value: value === "only" ? "only" : "shown" }); break;
    }
  }
  return chips;
}

function FilterChips({ route, navigate }: { route: Route; navigate: (next: Route) => void }) {
  const chips = chipsFor(route.filter);
  if (!chips.length) return null;
  return (
    <div class="filters" aria-label="Active filters">
      {chips.map((chip) => (
        <span class="chip" key={chip.key}>
          <span class="chip__k">{chip.label}</span>
          <span class="chip__v" title={chip.value}>{chip.value}</span>
          <button type="button" class="chip__x" aria-label={`Remove ${chip.label} filter`} onClick={() => navigate({ ...route, filter: withoutFilterKey(route.filter, chip.key) })}>
            {"\u00d7"}
          </button>
        </span>
      ))}
      {chips.length > 1 && (
        <button type="button" class="btn" onClick={() => navigate({ ...route, filter: {} })}>Clear</button>
      )}
    </div>
  );
}

export const AUTOMATED_EXPLAINER =
  "Sessions you did not start: Codex thread titles, Herdr pane recaps, scheduled jobs, memory reflection and dreaming runs, and sessions with no prompt or skill activity. Hidden from every view unless shown.";

function AutomatedToggle({ route, navigate, live }: { route: Route; navigate: (next: Route) => void; live: LiveInfo }) {
  const [hidden, setHidden] = useState(0);
  const { automated: _shown, ...base } = route.filter;
  const baseKey = buildHash({ view: "sessions", filter: base });
  useEffect(() => {
    let cancelled = false;
    api.stats(base).then((stats) => { if (!cancelled) setHidden(stats.automatedSessions ?? 0); }, () => { if (!cancelled) setHidden(0); });
    return () => { cancelled = true; };
  }, [baseKey, live.seq]);
  if (route.filter.automated !== undefined || hidden === 0) return null;
  return (
    <button type="button" class="btn" data-automated-toggle title={AUTOMATED_EXPLAINER}
      onClick={() => navigate({ ...route, filter: { ...route.filter, automated: "include" } })}>
      {`${hidden} automated ${hidden === 1 ? "session" : "sessions"} hidden \u00b7 Show`}
    </button>
  );
}

const TABS: { view: View; label: string }[] = [
  { view: "sessions", label: "Sessions" },
  { view: "workspaces", label: "Workspaces" },
  { view: "flow", label: "Flow" },
  { view: "heatmap", label: "Heatmap" },
];

/** The tab a detail route belongs to, so opening a trace or a flow keeps its list tab marked current. */
export const TAB_OF: Record<View, View> = {
  sessions: "sessions", trace: "sessions", workspaces: "workspaces", workspace: "workspaces", flow: "flow", heatmap: "heatmap",
};

function App() {
  const [route, navigate] = useRoute();
  const live = useLive();
  const activeTab: View = TAB_OF[route.view];
  const props = { route, navigate, live };
  return (
    <>
      <header class="top">
        <div class="wrap">
          <div class="top__row">
            <a class="brand" href={buildHash({ view: "sessions", filter: route.filter })}>gisool</a>
            <span class={`live live--${live.state}`} role="status" aria-live="polite">
              <span class="live__dot" aria-hidden="true" />
              {LIVE_TEXT[live.state]}
            </span>
            <FilterChips route={route} navigate={navigate} />
            <AutomatedToggle route={route} navigate={navigate} live={live} />
          </div>
          <nav class="tabs" aria-label="Views">
            {TABS.map((tab) => (
              <a key={tab.view} class="tab" href={buildHash({ view: tab.view, filter: route.filter })} aria-current={activeTab === tab.view ? "page" : undefined}>
                {tab.label}
              </a>
            ))}
          </nav>
        </div>
      </header>
      <main class="page wrap">
        {route.view === "sessions" && <SessionsView {...props} />}
        {route.view === "trace" && <TraceView {...props} />}
        {route.view === "workspaces" && <WorkspacesView {...props} />}
        {route.view === "workspace" && <WorkspaceView {...props} />}
        {route.view === "flow" && <FlowView {...props} />}
        {route.view === "heatmap" && <HeatmapView {...props} />}
      </main>
    </>
  );
}

const el = document.getElementById("app");
if (el) render(<App />, el);
