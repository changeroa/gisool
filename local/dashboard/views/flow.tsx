import { useEffect, useMemo, useState } from "preact/hooks";
import type { AdoptionState, Filter, FlowDto, SkillEntry } from "../../src/types.js";
import { api } from "../api";
import { STATE_VALUES, Sankey, installStyles, nodeValue, percent, share, type FlowLink, type FlowNode, type FlowTarget } from "../charts/sankey";
import { ADOPTION_STATES, STATE_LABEL, buildHash, isEmptyFilter, serializeFilter, skillName, type Route, type ViewProps } from "../state";

// Flow view: Sankey (>= TABLE_THRESHOLD sessions) or the "Top paths" table, each switchable.
// Clicks map to the shared Filter: skill node -> `skill`, outcome node -> `state`, band -> both.
// Task types have no Filter field, so their nodes only highlight; `q` is never used for them.

export const TABLE_THRESHOLD = 30;
export const DEFAULT_TOP = 7;
export const EXPANDED_TOP = 15;
export type FlowMode = "chart" | "table";
export type FlowUnit = FlowDto["unit"];
export type SkillResolver = (value: string) => string | undefined;
export type TopPath = { index: number; task: string; skill: string; skillNode: FlowNode; state: AdoptionState; count: number; share: number };

const UNIT_LABEL: Record<FlowUnit, string> = { first_load: "First load", all_loads: "All loads" };
const LIVE_REFRESH_DEBOUNCE_MS = 300;

export function defaultMode(sessionCount: number): FlowMode {
  return sessionCount < TABLE_THRESHOLD ? "table" : "chart";
}

export function legendText(unit: FlowUnit): string {
  return unit === "first_load" ? "Band width = sessions (unit: first loaded skill)" : "Band width = skill loads (unit: all loaded skills)";
}

/** Skill node values are URIs from the store; fixtures and older rows may carry a skill name, resolved through the catalog. */
export function skillResolver(skills: SkillEntry[]): SkillResolver {
  const byName = new Map<string, string>();
  for (const entry of skills) {
    byName.set(entry.name, entry.uri);
    byName.set(entry.dir, entry.uri);
    byName.set(skillName(entry.uri), entry.uri);
  }
  return (value) => (value.startsWith("skill://") ? value : byName.get(value));
}

function skillUri(node: FlowNode | undefined, resolve: SkillResolver): string | undefined {
  if (!node || node.column !== 1 || node.other) return undefined;
  return resolve(nodeValue(node));
}

/** The Filter patch a click means, or undefined when the element maps to nothing filterable. */
export function targetFilter(target: FlowTarget, nodes: FlowNode[], resolve: SkillResolver): Pick<Filter, "skill" | "state"> | undefined {
  if (target.kind === "node") {
    const { node } = target;
    if (node.other || node.column === 0) return undefined;
    if (node.column === 1) {
      const uri = skillUri(node, resolve);
      return uri ? { skill: [uri] } : undefined;
    }
    const value = nodeValue(node);
    return STATE_VALUES.has(value) ? { state: [value as AdoptionState] } : undefined;
  }
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const uri = skillUri(byId.get(target.link.source), resolve) ?? skillUri(byId.get(target.link.target), resolve);
  return { ...(uri ? { skill: [uri] } : {}), state: [target.link.state] };
}

export function sessionsRoute(route: Route, patch: Pick<Filter, "skill" | "state">): Route {
  return { view: "sessions", filter: { ...route.filter, ...patch } };
}

/** One row per task -> skill -> outcome path: the task->skill links already count unique sessions per (task, skill, state). */
export function topPaths(dto: FlowDto): TopPath[] {
  const byId = new Map(dto.nodes.map((n) => [n.id, n]));
  const rows: TopPath[] = [];
  dto.links.forEach((link: FlowLink, index) => {
    const task = byId.get(link.source);
    const skill = byId.get(link.target);
    if (!task || !skill || task.column !== 0 || skill.column !== 1) return;
    rows.push({ index, task: task.label, skill: skill.label, skillNode: skill, state: link.state, count: link.count, share: share(link.count, dto.sessionCount) });
  });
  return rows.sort((a, b) => b.count - a.count || a.task.localeCompare(b.task) || a.skill.localeCompare(b.skill) || a.state.localeCompare(b.state));
}

const FLOW_CSS = `
.flow__legend { display: flex; flex-wrap: wrap; align-items: center; gap: var(--s-2) var(--s-4); margin: 0 0 var(--s-3); color: var(--ink-2); font-size: var(--fs-cap); }
.flow__key { display: inline-flex; flex-wrap: wrap; gap: var(--s-2) var(--s-3); }
.flow__swatch { display: inline-flex; align-items: center; gap: var(--s-2); white-space: nowrap; }
.flow__dot { width: 8px; height: 8px; border-radius: 50%; background: var(--neutral); flex: none; }
.flow__dot.is-loaded { background: var(--ok); }
.flow__dot.is-exposed_only { background: var(--warn); }
.flow__dot.is-no_match { background: var(--bad); }
.flow__chart { padding: var(--s-4); }
.seg { display: inline-flex; border: 1px solid var(--line-2); border-radius: var(--r-sm); overflow: hidden; }
.seg__btn { height: 30px; padding: 0 var(--s-3); border: 0; background: transparent; color: var(--ink-2); font-size: var(--fs-sm); font-weight: 500; cursor: pointer; transition: background-color var(--t-micro), color var(--t-micro); }
.seg__btn + .seg__btn { border-left: 1px solid var(--line-2); }
.seg__btn:hover { background: var(--wash); color: var(--ink); }
.seg__btn[aria-pressed="true"] { background: var(--wash-2); color: var(--ink); }
.seg__btn:focus-visible { outline-offset: -2px; }
.paths { width: 100%; border-collapse: collapse; font-size: var(--fs-sm); }
.paths th { text-align: left; padding: var(--s-2) var(--s-3); color: var(--ink-3); font-size: var(--fs-cap); font-weight: 500; border-bottom: 1px solid var(--line); white-space: nowrap; }
.paths td { padding: var(--s-3); border-bottom: 1px solid var(--line); vertical-align: middle; }
.paths tbody tr { cursor: pointer; transition: background-color var(--t-micro); }
.paths tbody tr:hover, .paths tbody tr:has(a:focus-visible) { background: var(--wash); }
.paths tbody tr:last-child td { border-bottom: 0; }
.paths__hint { margin-inline-start: var(--s-2); font-weight: 400; }
.paths__path { display: flex; flex-wrap: wrap; align-items: center; gap: var(--s-1) var(--s-2); }
.paths__task { color: var(--ink-2); }
.paths__arrow { color: var(--ink-3); }
.paths__skill { color: var(--ink); font-weight: 500; text-decoration: none; }
.paths__skill:hover { color: var(--ink); text-decoration: underline; }
.paths__skill--dim { color: var(--ink-3); font-weight: 400; }
.paths .num { width: 1%; text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
.paths__share { display: inline-block; min-width: 4.5rem; padding: 2px var(--s-2); border-radius: var(--r-sm); background: linear-gradient(to right, var(--wash-2) var(--share, 0%), transparent 0); }
`;

installStyles("flow", FLOW_CSS);

function Segmented<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: { value: T; label: string }[]; onChange: (next: T) => void }) {
  return (
    <div class="seg" role="group" aria-label={label}>
      {options.map((option) => (
        <button key={option.value} type="button" class="seg__btn" aria-pressed={option.value === value} onClick={() => onChange(option.value)}>
          {option.label}
        </button>
      ))}
    </div>
  );
}

function Legend({ unit, withKey }: { unit: FlowUnit; withKey: boolean }) {
  return (
    <p class="flow__legend">
      <span>{withKey ? legendText(unit) : `Share = sessions on the path / sessions in range (unit: ${unit === "first_load" ? "first loaded skill" : "all loaded skills"})`}</span>
      {withKey && (
        <span class="flow__key" aria-label="Band color">
          {ADOPTION_STATES.map((state) => (
            <span class="flow__swatch" key={state}>
              <i class={`flow__dot is-${state}`} aria-hidden="true" />
              {STATE_LABEL[state]}
            </span>
          ))}
        </span>
      )}
    </p>
  );
}

function isInteractive(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest("a, button") !== null;
}

function TopPathsTable({ dto, route, navigate, resolve }: { dto: FlowDto; route: Route; navigate: ViewProps["navigate"]; resolve: SkillResolver }) {
  const rows = topPaths(dto);
  return (
    <div class="card">
      <table class="paths">
        <thead>
          <tr>
            <th scope="col">Path<span class="paths__hint">task type {"\u2192"} skill {"\u2192"} outcome</span></th>
            <th scope="col" class="num">Sessions</th>
            <th scope="col" class="num">Share</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const link = dto.links[row.index]!;
            const target = sessionsRoute(route, targetFilter({ kind: "link", link, index: row.index }, dto.nodes, resolve) ?? { state: [row.state] });
            const href = buildHash(target);
            const filterable = skillUri(row.skillNode, resolve) !== undefined;
            return (
              <tr key={row.index} onClick={(event) => { if (!isInteractive(event.target)) navigate(target); }}>
                <td>
                  <span class="paths__path">
                    <span class="paths__task">{row.task}</span>
                    <span class="paths__arrow" aria-hidden="true">{"\u2192"}</span>
                    <a class={filterable ? "paths__skill" : "paths__skill paths__skill--dim"} href={href} title={filterable ? nodeValue(row.skillNode) : undefined}>{row.skill}</a>
                    <span class="paths__arrow" aria-hidden="true">{"\u2192"}</span>
                    <span class={`badge badge--${row.state}`}>{STATE_LABEL[row.state] ?? row.state}</span>
                  </span>
                </td>
                <td class="num">{row.count}</td>
                <td class="num"><span class="paths__share" style={{ "--share": percent(row.count, dto.sessionCount) }}>{percent(row.count, dto.sessionCount)}</span></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function EmptyFlow({ route, navigate }: { route: Route; navigate: ViewProps["navigate"] }) {
  const filtered = !isEmptyFilter(route.filter);
  return (
    <section class="empty">
      <h2>No sessions in this range</h2>
      <p>{filtered ? "No session matches these filters, so there is no flow to draw." : "Start a session in a connected runtime and the task-to-skill flow appears here."}</p>
      {filtered && <button type="button" class="btn" onClick={() => navigate({ ...route, filter: {} })}>Clear filters</button>}
    </section>
  );
}

export function FlowView({ route, navigate, live }: ViewProps) {
  const filterKey = serializeFilter(route.filter);
  const [unit, setUnit] = useState<FlowUnit>("first_load");
  const [top, setTop] = useState(DEFAULT_TOP);
  const [mode, setMode] = useState<FlowMode | "auto">("auto");
  const [dto, setDto] = useState<FlowDto>();
  const [skills, setSkills] = useState<SkillEntry[]>([]);
  const [error, setError] = useState<string>();
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    if (live.seq === 0) return;
    const timer = setTimeout(() => setRefresh((n) => n + 1), LIVE_REFRESH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [live.seq]);

  useEffect(() => {
    let cancelled = false;
    Promise.allSettled([api.flow(route.filter, { unit, top }), api.skills()]).then(([flowResult, skillsResult]) => {
      if (cancelled) return;
      const failed = flowResult.status === "rejected" ? flowResult.reason : skillsResult.status === "rejected" ? skillsResult.reason : undefined;
      if (failed !== undefined) {
        setError(failed instanceof Error ? failed.message : String(failed));
        return;
      }
      setDto((flowResult as PromiseFulfilledResult<FlowDto>).value);
      setSkills((skillsResult as PromiseFulfilledResult<SkillEntry[]>).value);
      setError(undefined);
    });
    return () => { cancelled = true; };
  }, [filterKey, unit, top, refresh]);

  const resolve = useMemo(() => skillResolver(skills), [skills]);
  const shown: FlowMode = mode === "auto" ? defaultMode(dto?.sessionCount ?? 0) : mode;
  const hrefFor = (target: FlowTarget): string | undefined => {
    const patch = dto && targetFilter(target, dto.nodes, resolve);
    return patch ? buildHash(sessionsRoute(route, patch)) : undefined;
  };
  const onActivate = (target: FlowTarget) => {
    const patch = dto && targetFilter(target, dto.nodes, resolve);
    if (patch) navigate(sessionsRoute(route, patch));
  };

  let body;
  if (dto === undefined) {
    body = null;
  } else if (dto.sessionCount === 0) {
    body = <EmptyFlow route={route} navigate={navigate} />;
  } else {
    body = (
      <>
        <div class="toolbar">
          <Segmented label="View" value={shown} options={[{ value: "chart", label: "Chart" }, { value: "table", label: "Top paths" }]} onChange={setMode} />
          <Segmented label="Unit" value={unit} options={(["first_load", "all_loads"] as const).map((value) => ({ value, label: UNIT_LABEL[value] }))} onChange={setUnit} />
          {top !== DEFAULT_TOP && (
            <button type="button" class="btn" onClick={() => setTop(DEFAULT_TOP)}>Top {DEFAULT_TOP} per column</button>
          )}
          <span class="toolbar__count">{dto.sessionCount} {dto.sessionCount === 1 ? "session" : "sessions"}</span>
        </div>
        <Legend unit={unit} withKey={shown === "chart"} />
        {shown === "chart"
          ? (
            <div class="card flow__chart">
              <Sankey dto={dto} hrefFor={hrefFor} onActivate={onActivate} onExpandOther={top < EXPANDED_TOP ? () => setTop(EXPANDED_TOP) : undefined} />
            </div>
          )
          : <TopPathsTable dto={dto} route={route} navigate={navigate} resolve={resolve} />}
      </>
    );
  }

  return (
    <section aria-busy={dto === undefined && !error} data-mode={dto ? shown : undefined} data-top={top} data-unit={unit}>
      {error && <p class="notice" role="alert">Could not load the flow: {error}</p>}
      {body}
    </section>
  );
}
