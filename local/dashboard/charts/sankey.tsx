import { sankey as sankeyLayout, sankeyLinkHorizontal, type SankeyNode } from "d3-sankey";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { AdoptionState, FlowDto } from "../../src/types.js";
import { STATE_LABEL } from "../state";

// Three-column Sankey (task type -> skill -> outcome): d3-sankey computes the layout, the SVG is
// rendered by hand (nodes as rects, links as sankeyLinkHorizontal paths). Links take the color of
// their adoption state, so DESIGN.md's status colors also encode outcome in the flow bands and the
// legend. Styles are installed from this module as a constructed stylesheet (CSSOM, so a CSP
// without 'unsafe-inline' still applies them); every value traces to a DESIGN.md token.
//
// Node ids follow the store: "t:<task type>", "s:<skill URI | (none) | __other__>", "a:<state>"
// (fixtures use "st:<state>"); `column` is authoritative, the id prefix is never parsed.

export type FlowNode = FlowDto["nodes"][number];
export type FlowLink = FlowDto["links"][number];
export type FlowTarget = { kind: "node"; node: FlowNode } | { kind: "link"; link: FlowLink; index: number };
export type LaidOutNode = FlowNode & { x0: number; x1: number; y0: number; y1: number; value: number };
export type LaidOutLink = FlowLink & { index: number; width: number; y0: number; y1: number; path: string };
export type FlowLayout = { nodes: LaidOutNode[]; links: LaidOutLink[] };
export type LayoutOptions = { width: number; height: number; top?: number; nodeWidth?: number; nodePadding?: number };

export const COLUMN_TITLE: Record<FlowDto["columns"][number], string> = { task_type: "Task type", skill: "Skill", state: "Outcome" };
export const STATE_VALUES: ReadonlySet<string> = new Set<AdoptionState>(["loaded", "exposed_only", "no_match", "aborted", "not_used"]);

const NODE_WIDTH = 10;
const HEADER_HEIGHT = 24;
const MIN_HEIGHT = 320;
const MAX_HEIGHT = 600;
const NARROW_WIDTH = 640;
const LABEL_GAP = 6;
const TIP_OFFSET = 12;
const OUTCOME_MARGIN = 80;

/** The value part of a node id: "t:review" -> "review", "s:skill://x/SKILL.md" -> "skill://x/SKILL.md". */
export function nodeValue(node: Pick<FlowNode, "id">): string {
  const i = node.id.indexOf(":");
  return i < 0 ? node.id : node.id.slice(i + 1);
}

/** Outcome nodes carry the raw state as their label; show the same wording as the badges and the legend. */
export function displayLabel(node: FlowNode): string {
  const value = nodeValue(node);
  return node.column === 2 && STATE_VALUES.has(value) ? STATE_LABEL[value as AdoptionState] : node.label;
}

export function share(count: number, total: number): number {
  return total > 0 ? count / total : 0;
}

export function percent(count: number, total: number): string {
  const value = share(count, total) * 100;
  return `${value > 0 && value < 1 ? "<1" : Math.round(value)}%`;
}

const installed = new Set<string>();

/** Installs a stylesheet once per key. Uses the CSSOM (constructed sheets) so a strict style-src CSP still applies it. */
export function installStyles(key: string, css: string): void {
  if (typeof document === "undefined" || installed.has(key)) return;
  installed.add(key);
  if ("adoptedStyleSheets" in document && typeof CSSStyleSheet !== "undefined" && "replaceSync" in CSSStyleSheet.prototype) {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(css);
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
    return;
  }
  const el = document.createElement("style");
  el.dataset.sheet = key;
  el.textContent = css;
  document.head.append(el);
}

type LinkExtra = { index: number; count: number; state: AdoptionState };
type LinkInput = LinkExtra & { source: string; target: string; value: number };

/** d3-sankey layout in pixel space. Nodes are pinned to their column, sorted by value (Other last); links keep their DTO index. */
export function layoutFlow(dto: FlowDto, opts: LayoutOptions): FlowLayout {
  const { width, height, top = 0, nodeWidth = NODE_WIDTH, nodePadding = 14 } = opts;
  const ids = new Set(dto.nodes.map((n) => n.id));
  const links: LinkInput[] = [];
  dto.links.forEach((link, index) => {
    if (ids.has(link.source) && ids.has(link.target) && link.count > 0) {
      links.push({ source: link.source, target: link.target, value: link.count, index, count: link.count, state: link.state });
    }
  });
  const linked = new Set<string>();
  for (const link of links) {
    linked.add(link.source);
    linked.add(link.target);
  }
  const nodes = dto.nodes.filter((n) => linked.has(n.id)).map((n) => ({ ...n }));
  if (!nodes.length || width <= nodeWidth || height <= top) return { nodes: [], links: [] };

  const generator = sankeyLayout<FlowNode, LinkExtra>()
    .nodeId((d) => d.id)
    .nodeAlign((d) => d.column)
    .nodeSort((a, b) => Number(Boolean(a.other)) - Number(Boolean(b.other)) || (b.value ?? 0) - (a.value ?? 0) || a.label.localeCompare(b.label))
    .nodeWidth(nodeWidth)
    .nodePadding(nodePadding)
    .extent([[0, top], [width, height]]);
  const graph = generator({ nodes, links });
  const toPath = sankeyLinkHorizontal<FlowNode, LinkExtra>();

  const outNodes: LaidOutNode[] = graph.nodes
    .map((n) => ({
      id: n.id, column: n.column, label: n.label, count: n.count, ...(n.other ? { other: true } : {}),
      x0: n.x0 ?? 0, x1: n.x1 ?? 0, y0: n.y0 ?? 0, y1: n.y1 ?? 0, value: n.value ?? 0,
    }))
    .sort((a, b) => a.column - b.column || a.y0 - b.y0);
  const column = new Map(outNodes.map((n) => [n.id, n.column]));
  const outLinks: LaidOutLink[] = graph.links
    .map((l) => {
      const source = l.source as SankeyNode<FlowNode, LinkExtra>;
      const target = l.target as SankeyNode<FlowNode, LinkExtra>;
      return { source: source.id, target: target.id, count: l.count, state: l.state, index: l.index, width: l.width ?? 0, y0: l.y0 ?? 0, y1: l.y1 ?? 0, path: toPath(l) ?? "" };
    })
    .sort((a, b) => (column.get(a.source) ?? 0) - (column.get(b.source) ?? 0) || a.y0 - b.y0);
  return { nodes: outNodes, links: outLinks };
}

/**
 * Links and nodes that carry at least one session of the hovered element. Links carry the session's
 * state, so a task->skill band (state s) continues in exactly one skill->outcome band (same skill, state s)
 * and vice versa; that makes the upstream/downstream set exact despite the per-column aggregation.
 */
export function connected(dto: FlowDto, target: FlowTarget): { links: Set<number>; nodes: Set<string> } {
  const columnOf = new Map(dto.nodes.map((n) => [n.id, n.column]));
  const links = dto.links.map((link, index) => ({ ...link, index }));
  const hop1 = links.filter((l) => columnOf.get(l.source) === 0);
  const hop2 = links.filter((l) => columnOf.get(l.source) === 1);
  const picked = new Set<number>();
  const downstream = (l: FlowLink) => { for (const n of hop2) if (n.source === l.target && n.state === l.state) picked.add(n.index); };
  const upstream = (l: FlowLink) => { for (const p of hop1) if (p.target === l.source && p.state === l.state) picked.add(p.index); };
  if (target.kind === "link") {
    const link = links[target.index];
    if (link) {
      picked.add(link.index);
      if (columnOf.get(link.source) === 0) downstream(link);
      else upstream(link);
    }
  } else {
    const { id, column } = target.node;
    if (column === 0) for (const l of hop1) { if (l.source === id) { picked.add(l.index); downstream(l); } }
    else if (column === 1) for (const l of links) { if (l.source === id || l.target === id) picked.add(l.index); }
    else for (const l of hop2) { if (l.target === id) { picked.add(l.index); upstream(l); } }
  }
  const nodes = new Set<string>();
  if (target.kind === "node") nodes.add(target.node.id);
  for (const i of picked) {
    nodes.add(links[i]!.source);
    nodes.add(links[i]!.target);
  }
  return { links: picked, nodes };
}

export function chartHeight(dto: FlowDto, narrow: boolean): number {
  const perColumn = [0, 0, 0];
  for (const n of dto.nodes) perColumn[n.column] = (perColumn[n.column] ?? 0) + 1;
  const rows = Math.max(1, ...perColumn);
  return Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, HEADER_HEIGHT + 8 + rows * (narrow ? 34 : 44)));
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, Math.max(1, max - 1))}\u2026` : text;
}

function describe(dto: FlowDto, target: FlowTarget): { title: string; sub: string } {
  if (target.kind === "node") {
    const { node } = target;
    return { title: displayLabel(node), sub: `${node.count} ${node.count === 1 ? "session" : "sessions"} \u00b7 ${percent(node.count, dto.sessionCount)}` };
  }
  const label = new Map(dto.nodes.map((n) => [n.id, displayLabel(n)]));
  const { link } = target;
  return {
    title: `${label.get(link.source) ?? link.source} \u2192 ${label.get(link.target) ?? link.target}`,
    sub: `${STATE_LABEL[link.state] ?? link.state} \u00b7 ${link.count} ${link.count === 1 ? "session" : "sessions"} \u00b7 ${percent(link.count, dto.sessionCount)}`,
  };
}

const SANKEY_CSS = `
.sankey { position: relative; }
.sankey__svg { display: block; overflow: visible; font: 500 var(--fs-cap) / 1 var(--font-sans); }
.sankey__svg.is-narrow { font-size: var(--fs-micro); }
.sankey__head { fill: var(--ink-3); font-size: var(--fs-micro); font-weight: 600; letter-spacing: 0.02em; text-transform: uppercase; }
.sankey__link { fill: none; stroke: var(--neutral); stroke-opacity: 0.38; transition: stroke-opacity var(--t-micro); }
.sankey__link.is-loaded { stroke: var(--ok); }
.sankey__link.is-exposed_only { stroke: var(--warn); }
.sankey__link.is-no_match { stroke: var(--bad); }
.sankey__link.is-aborted, .sankey__link.is-not_used { stroke: var(--neutral); }
.sankey__svg.is-hovering .sankey__link:not(.is-on) { stroke-opacity: 0.1; }
.sankey__svg.is-hovering .sankey__link.is-on { stroke-opacity: 0.72; }
.sankey__node { transition: opacity var(--t-micro); }
.sankey__svg.is-hovering .sankey__node:not(.is-on) { opacity: 0.35; }
.sankey__rect { fill: var(--ink-2); }
.sankey__node.is-other .sankey__rect { fill: var(--ink-3); }
.sankey__node.is-c2.is-loaded .sankey__rect { fill: var(--ok); }
.sankey__node.is-c2.is-exposed_only .sankey__rect { fill: var(--warn); }
.sankey__node.is-c2.is-no_match .sankey__rect { fill: var(--bad); }
.sankey__node.is-c2.is-aborted .sankey__rect, .sankey__node.is-c2.is-not_used .sankey__rect { fill: var(--neutral); }
.sankey__label { fill: var(--ink); paint-order: stroke; stroke: var(--surface); stroke-width: 3px; stroke-linejoin: round; dominant-baseline: central; pointer-events: none; }
.sankey__label--end, .sankey__head--end { text-anchor: end; }
.sankey__head--mid { text-anchor: middle; }
.sankey__count { fill: var(--ink-3); font-variant-numeric: tabular-nums; }
.sankey a, .sankey [role="button"] { cursor: pointer; outline: none; }
.sankey a:focus-visible .sankey__rect, .sankey [role="button"]:focus-visible .sankey__rect { stroke: var(--accent); stroke-width: 2px; }
.sankey a:focus-visible .sankey__link { stroke-opacity: 0.85; }
.sankey__tip { position: absolute; z-index: 2; max-width: 32ch; padding: var(--s-1) var(--s-2); border-radius: var(--r-sm); background: var(--ink); color: var(--bg); font-size: var(--fs-cap); font-weight: 500; line-height: 1.4; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; box-shadow: var(--shadow-pop); pointer-events: none; }
.sankey__tip-sub { opacity: 0.75; font-variant-numeric: tabular-nums; }
`;

installStyles("sankey", SANKEY_CSS);

export type SankeyProps = {
  dto: FlowDto;
  /** Hash href for a node or link, or undefined when it maps to no Filter change (task types, "(no skill)", Other). */
  hrefFor: (target: FlowTarget) => string | undefined;
  onActivate: (target: FlowTarget) => void;
  /** When set, Other nodes become buttons that request a wider top-N. */
  onExpandOther?: () => void;
};

type Hover = { target: FlowTarget; x: number; y: number };

function isPlainClick(event: MouseEvent): boolean {
  return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}

export function Sankey({ dto, hrefFor, onActivate, onExpandOther }: SankeyProps) {
  const wrap = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [hover, setHover] = useState<Hover>();

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const measure = () => setWidth(Math.floor(el.getBoundingClientRect().width));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const narrow = width < NARROW_WIDTH;
  const height = chartHeight(dto, narrow);
  // Narrow screens keep outcome labels outside the bands (right margin); wide screens tuck them inside, left of the node.
  const plotWidth = narrow ? width - OUTCOME_MARGIN : width;
  const layout = useMemo(
    () => layoutFlow(dto, { width: plotWidth, height, top: HEADER_HEIGHT, nodeWidth: NODE_WIDTH, nodePadding: narrow ? 10 : 14 }),
    [dto, plotWidth, height, narrow],
  );
  const lit = useMemo(() => (hover ? connected(dto, hover.target) : undefined), [dto, hover?.target]);
  const nodeById = useMemo(() => new Map(layout.nodes.map((n) => [n.id, n])), [layout]);
  // A gap holds one column's labels (narrow, 11px: ~6.2px per character) or two columns' labels (wide, 12px: ~7px), plus the count.
  const gap = (plotWidth - 3 * NODE_WIDTH) / 2;
  const maxChars = Math.max(8, Math.min(24, narrow ? Math.floor((gap * 0.95 - 22) / 6.2) : Math.floor((gap * 0.5 - 24) / 7)));
  const labelLeft = (node: LaidOutNode) => node.column === 2 && !narrow;

  const place = (event: MouseEvent): { x: number; y: number } => {
    const rect = wrap.current?.getBoundingClientRect();
    return { x: event.clientX - (rect?.left ?? 0), y: event.clientY - (rect?.top ?? 0) };
  };
  const bind = (target: FlowTarget, focusPoint: { x: number; y: number }) => ({
    onPointerEnter: (event: PointerEvent) => setHover({ target, ...place(event) }),
    onPointerMove: (event: PointerEvent) => setHover({ target, ...place(event) }),
    onPointerLeave: () => setHover(undefined),
    onFocus: () => setHover({ target, ...focusPoint }),
    onBlur: () => setHover(undefined),
  });
  const activate = (target: FlowTarget) => (event: MouseEvent) => {
    if (!isPlainClick(event)) return;
    event.preventDefault();
    onActivate(target);
  };

  const tip = hover ? describe(dto, hover.target) : undefined;
  const flip = hover ? hover.x > width / 2 : false;

  return (
    <div class="sankey" ref={wrap} style={{ minHeight: `${height}px` }}>
      {layout.nodes.length > 0 && (
        <svg class={`sankey__svg${narrow ? " is-narrow" : ""}${hover ? " is-hovering" : ""}`} width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="group" aria-label={`Flow of ${dto.sessionCount} sessions from task type to skill to outcome`}>
          <g aria-hidden="true">
            <text class="sankey__head" x={0} y={10}>{COLUMN_TITLE[dto.columns[0]]}</text>
            <text class="sankey__head sankey__head--mid" x={plotWidth / 2} y={10}>{COLUMN_TITLE[dto.columns[1]]}</text>
            <text class={narrow ? "sankey__head" : "sankey__head sankey__head--end"} x={narrow ? plotWidth - NODE_WIDTH : plotWidth} y={10}>{COLUMN_TITLE[dto.columns[2]]}</text>
          </g>
          <g>
            {layout.links.map((link) => {
              const target: FlowTarget = { kind: "link", link, index: link.index };
              const href = hrefFor(target);
              const source = nodeById.get(link.source);
              const dest = nodeById.get(link.target);
              const on = !lit || lit.links.has(link.index);
              const path = <path class={`sankey__link is-${link.state}${on ? " is-on" : ""}`} d={link.path} stroke-width={Math.max(1, link.width)} />;
              const label = `${source ? displayLabel(source) : link.source} to ${dest ? displayLabel(dest) : link.target}, ${STATE_LABEL[link.state] ?? link.state}: ${link.count} sessions (${percent(link.count, dto.sessionCount)})`;
              const handlers = bind(target, { x: ((source?.x1 ?? 0) + (dest?.x0 ?? plotWidth)) / 2, y: (link.y0 + link.y1) / 2 });
              return href
                ? <a key={`l${link.index}`} href={href} aria-label={label} onClick={activate(target)} {...handlers}>{path}</a>
                : <g key={`l${link.index}`} {...handlers}>{path}</g>;
            })}
          </g>
          <g>
            {layout.nodes.map((node) => {
              const target: FlowTarget = { kind: "node", node };
              const href = hrefFor(target);
              const expandable = Boolean(node.other && onExpandOther);
              const on = !lit || lit.nodes.has(node.id);
              const value = nodeValue(node);
              const cls = `sankey__node is-c${node.column}${node.other ? " is-other" : ""}${node.column === 2 && STATE_VALUES.has(value) ? ` is-${value}` : ""}${on ? " is-on" : ""}`;
              const end = labelLeft(node);
              const body = (
                <>
                  <rect class="sankey__rect" x={node.x0} y={node.y0} width={node.x1 - node.x0} height={Math.max(1, node.y1 - node.y0)} rx={2} />
                  <text class={`sankey__label${end ? " sankey__label--end" : ""}`} x={end ? node.x0 - LABEL_GAP : node.x1 + LABEL_GAP} y={(node.y0 + node.y1) / 2}>
                    {end ? <tspan class="sankey__count">{node.count}</tspan> : null}
                    <tspan dx={end ? LABEL_GAP : 0}>{truncate(displayLabel(node), maxChars)}</tspan>
                    {end ? null : <tspan class="sankey__count" dx={LABEL_GAP}>{node.count}</tspan>}
                  </text>
                </>
              );
              const label = `${displayLabel(node)}: ${node.count} sessions (${percent(node.count, dto.sessionCount)})`;
              const handlers = bind(target, { x: end ? node.x0 - LABEL_GAP : node.x1 + LABEL_GAP, y: (node.y0 + node.y1) / 2 });
              if (href) return <a key={node.id} class={cls} href={href} aria-label={label} onClick={activate(target)} {...handlers}>{body}</a>;
              if (expandable) {
                return (
                  <g
                    key={node.id}
                    class={cls}
                    role="button"
                    tabindex={0}
                    aria-label={`${node.label}: show up to 15 per column`}
                    onClick={() => onExpandOther?.()}
                    onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onExpandOther?.(); } }}
                    {...handlers}
                  >
                    {body}
                  </g>
                );
              }
              return <g key={node.id} class={cls} {...handlers}>{body}</g>;
            })}
          </g>
        </svg>
      )}
      {hover && tip && (
        <div class="sankey__tip" role="status" style={flip ? { right: `${width - hover.x + TIP_OFFSET}px`, top: `${hover.y + TIP_OFFSET}px` } : { left: `${hover.x + TIP_OFFSET}px`, top: `${hover.y + TIP_OFFSET}px` }}>
          <div>{tip.title}</div>
          <div class="sankey__tip-sub">{tip.sub}</div>
        </div>
      )}
    </div>
  );
}
