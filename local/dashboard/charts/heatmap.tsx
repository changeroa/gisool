import type { Filter, HeatmapDto, SkillUri, SkillWeekDto } from "../../src/types.js";
import { DOW_LABEL } from "../state";

// Colors derive from the DESIGN.md tokens: one hue (--accent) at five alphas for data cells, ink at
// alpha for marginal bars, --wash for empty cells. The CSS lives in HEATMAP_CSS (rendered once by
// <HeatmapStyles/>) because styles.css is owned by the shell todo.

export type BucketHours = 1 | 2 | 4;
export type WeekStart = 0 | 1;
export type Level = 0 | 1 | 2 | 3 | 4;
export type BucketChoice = "auto" | BucketHours;

export const BUCKET_OPTIONS: readonly BucketHours[] = [1, 2, 4];
/** Below this many sessions in range the automatic bucket widens to 2 h. */
export const AUTO_BUCKET_BELOW = 50;
export const LEVEL_COUNT = 5;

const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;

export type HeatCell = { dow: number; hour: number; count: number; share: number; level: Level };
export type HeatGrid = {
  bucketHours: BucketHours;
  weekStart: WeekStart;
  /** Row order: weekdays starting at weekStart (JS getDay numbering, 0 = Sunday). */
  dows: number[];
  /** Column order: bucket start hours. */
  hours: number[];
  rows: HeatCell[][];
  rowTotals: number[];
  colTotals: number[];
  total: number;
  maxCount: number;
  maxRowTotal: number;
  maxColTotal: number;
  level: (count: number) => Level;
};
export type HourSelection = { dow: number; hour: number; hourSpan: number };
export type SkillWeekRow = { uri: SkillUri; name: string; counts: number[]; total: number; levels: Level[] };
export type SkillWeekGrid = {
  weeks: string[];
  rows: SkillWeekRow[];
  colTotals: number[];
  total: number;
  maxCount: number;
  maxRowTotal: number;
  maxColTotal: number;
  level: (count: number) => Level;
};

function isBucket(value: unknown): value is BucketHours {
  return value === 1 || value === 2 || value === 4;
}

function finiteCount(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function sum(values: readonly number[]): number {
  return values.reduce((a, b) => a + b, 0);
}

export function ratio(value: number, max: number): number {
  return max > 0 ? Math.min(1, value / max) : 0;
}

/**
 * Five discrete levels: 0 for empty cells, then the quartiles of the non-zero counts (nearest rank).
 * The busiest cell always sits at level 4 so "More" in the legend means the observed maximum.
 */
export function levelScale(counts: Iterable<number>): (count: number) => Level {
  const nz = [...counts].map(finiteCount).filter((c) => c > 0).sort((a, b) => a - b);
  if (nz.length === 0) return () => 0;
  const max = nz[nz.length - 1]!;
  const quantile = (p: number) => nz[Math.max(0, Math.ceil(p * nz.length) - 1)]!;
  const q1 = quantile(0.25);
  const q2 = quantile(0.5);
  const q3 = quantile(0.75);
  return (count) => {
    const c = finiteCount(count);
    if (c === 0) return 0;
    if (c >= max) return 4;
    if (c <= q1) return 1;
    if (c <= q2) return 2;
    if (c <= q3) return 3;
    return 4;
  };
}

/** One label per level ("0", "1", "2-3", ...): the count range that maps to each swatch. */
export function legendRanges(level: (count: number) => Level, max: number): string[] {
  const ranges: (number[] | undefined)[] = Array.from({ length: LEVEL_COUNT }, () => undefined);
  ranges[0] = [0, 0];
  for (let c = 1; c <= Math.max(0, Math.trunc(max)); c++) {
    const l = level(c);
    const r = ranges[l];
    if (r) r[1] = c; else ranges[l] = [c, c];
  }
  return ranges.map((r) => (r ? (r[0] === r[1] ? String(r[0]) : `${r[0]}-${r[1]}`) : "-"));
}

/**
 * Dense 7 x (24 / bucket) grid from a HeatmapDto. Cells are keyed by (dow, start hour) so sparse and
 * dense DTOs both work; a coarser DTO cannot be split, so the grid never gets finer than the server sent.
 */
export function buildGrid(dto: HeatmapDto, opts: { bucketHours?: BucketHours; weekStart?: WeekStart } = {}): HeatGrid {
  const source: BucketHours = isBucket(dto.bucketHours) ? dto.bucketHours : 1;
  const wanted = opts.bucketHours ?? source;
  const bucketHours: BucketHours = wanted < source ? source : wanted;
  const weekStart: WeekStart = opts.weekStart ?? (dto.weekStart === 0 ? 0 : 1);
  const cols = 24 / bucketHours;
  const counts = Array.from({ length: 7 }, () => new Array<number>(cols).fill(0));
  for (const cell of dto.cells ?? []) {
    const dow = Math.trunc(Number(cell.dow));
    const hour = Math.trunc(Number(cell.hour));
    const count = finiteCount(cell.count);
    if (!(dow >= 0 && dow < 7 && hour >= 0 && hour < 24) || count === 0) continue;
    counts[dow]![Math.floor(hour / bucketHours)]! += count;
  }
  const dows = Array.from({ length: 7 }, (_, i) => (weekStart + i) % 7);
  const hours = Array.from({ length: cols }, (_, c) => c * bucketHours);
  const rowTotals = dows.map((dow) => sum(counts[dow]!));
  const colTotals = hours.map((_, c) => sum(counts.map((row) => row[c]!)));
  const total = sum(rowTotals);
  const flat = counts.flat();
  const level = levelScale(flat);
  const rows = dows.map((dow) => hours.map((hour, c) => {
    const count = counts[dow]![c]!;
    return { dow, hour, count, share: total > 0 ? count / total : 0, level: level(count) };
  }));
  return {
    bucketHours, weekStart, dows, hours, rows, rowTotals, colTotals, total,
    maxCount: Math.max(0, ...flat), maxRowTotal: Math.max(0, ...rowTotals), maxColTotal: Math.max(0, ...colTotals), level,
  };
}

export function gridTotal(dto: HeatmapDto): number {
  return sum((dto.cells ?? []).map((cell) => finiteCount(cell.count)));
}

export function autoBucket(total: number, narrow = false): BucketHours {
  return narrow || total < AUTO_BUCKET_BELOW ? 2 : 1;
}

export function buildSkillWeekGrid(dto: SkillWeekDto): SkillWeekGrid {
  const weeks = Array.isArray(dto.weeks) ? dto.weeks.map(String) : [];
  const normalized = (dto.rows ?? []).map((row) => {
    const counts = weeks.map((_, i) => finiteCount(row.counts?.[i]));
    return { uri: row.uri, name: row.name || skillLabel(row.uri), counts, total: sum(counts) };
  }).filter((row) => row.total > 0);
  normalized.sort((a, b) => b.total - a.total);
  const flat = normalized.flatMap((row) => row.counts);
  const level = levelScale(flat);
  const rows: SkillWeekRow[] = normalized.map((row) => ({ ...row, levels: row.counts.map(level) }));
  const colTotals = weeks.map((_, i) => sum(rows.map((row) => row.counts[i]!)));
  return {
    weeks, rows, colTotals, total: sum(colTotals),
    maxCount: Math.max(0, ...flat), maxRowTotal: Math.max(0, ...rows.map((row) => row.total)), maxColTotal: Math.max(0, ...colTotals), level,
  };
}

function skillLabel(uri: string): string {
  const segments = uri.replace(/\/SKILL\.md$/i, "").split("/").filter(Boolean);
  return segments[segments.length - 1] ?? uri;
}

export function localTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/** Locale week start via Intl.Locale#getWeekInfo (firstDay 7 = Sunday); anything else falls back to Monday. */
export function localeWeekStart(locale: string | undefined = typeof navigator === "undefined" ? undefined : navigator.language): WeekStart {
  if (!locale) return 1;
  try {
    const info = (new Intl.Locale(locale) as Intl.Locale & { getWeekInfo?: () => { firstDay?: number } }).getWeekInfo?.();
    return info?.firstDay === 7 ? 0 : 1;
  } catch {
    return 1;
  }
}

export function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** "09:00-11:00"; the end wraps at midnight like the header filter chip does. */
export function hourRangeLabel(hour: number, span: number): string {
  return `${pad2(hour)}:00-${pad2((hour + span) % 24)}:00`;
}

export function cellLabel(cell: { dow: number; hour: number }, span: number): string {
  return `${DOW_LABEL[cell.dow] ?? String(cell.dow)} ${hourRangeLabel(cell.hour, span)}`;
}

export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** "7.5%", "25%", and "0%" when there is nothing to share. */
export function formatShare(count: number, total: number): string {
  if (!(total > 0) || !(count > 0)) return "0%";
  const p = (count / total) * 100;
  return `${p >= 10 || Number.isInteger(p) ? String(Math.round(p)) : p.toFixed(1)}%`;
}

export function cellTip(cell: { dow: number; hour: number; count: number }, span: number, total: number, unit = "session"): string {
  const label = cellLabel(cell, span);
  return cell.count > 0 ? `${label} \u00b7 ${plural(cell.count, unit)} \u00b7 ${formatShare(cell.count, total)}` : `${label} \u00b7 no ${unit}s`;
}

export function hourLabels(bucketHours: BucketHours): string[] {
  const step = bucketHours === 1 ? 3 : 4;
  return Array.from({ length: 24 / bucketHours }, (_, c) => {
    const hour = c * bucketHours;
    return hour % step === 0 ? String(hour) : "";
  });
}

/** ISO week "2026-W35" -> its Monday and Sunday as UTC dates. */
export function isoWeekRange(week: string): { start: Date; end: Date } | undefined {
  const m = /^(\d{4})-W(\d{2})$/.exec(week);
  if (!m) return undefined;
  const year = Number(m[1]);
  const n = Number(m[2]);
  if (n < 1 || n > 53) return undefined;
  const jan4 = Date.UTC(year, 0, 4);
  const week1 = jan4 - ((new Date(jan4).getUTCDay() + 6) % 7) * DAY_MS;
  const start = week1 + (n - 1) * WEEK_MS;
  return { start: new Date(start), end: new Date(start + 6 * DAY_MS) };
}

const weekDateFmt = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", timeZone: "UTC" });

export function formatWeek(week: string): { short: string; range: string } {
  const r = isoWeekRange(week);
  const short = week.replace(/^\d{4}-/, "");
  if (!r) return { short, range: week };
  const fmt = weekDateFmt as Intl.DateTimeFormat & { formatRange?: (a: Date, b: Date) => string };
  const range = fmt.formatRange ? fmt.formatRange(r.start, r.end) : `${weekDateFmt.format(r.start)} - ${weekDateFmt.format(r.end)}`;
  return { short, range };
}

/** Shift-click: extend the current span to cover the clicked bucket when on the same row, else start a new one. */
export function extendSelection(current: HourSelection | undefined, cell: { dow: number; hour: number }, bucketHours: number): HourSelection {
  if (!current || current.dow !== cell.dow) return { dow: cell.dow, hour: cell.hour, hourSpan: bucketHours };
  const start = Math.min(current.hour, cell.hour);
  const end = Math.max(current.hour + current.hourSpan, cell.hour + bucketHours);
  return { dow: cell.dow, hour: start, hourSpan: Math.min(24 - start, end - start) };
}

export function cellSelected(selection: HourSelection | undefined, cell: { dow: number; hour: number }): boolean {
  return selection !== undefined && selection.dow === cell.dow && cell.hour >= selection.hour && cell.hour < selection.hour + selection.hourSpan;
}

export function selectionFromFilter(filter: Filter): HourSelection | undefined {
  if (filter.dow === undefined || filter.hour === undefined) return undefined;
  return { dow: filter.dow, hour: filter.hour, hourSpan: filter.hourSpan ?? 1 };
}

/** Filter without the cell axes; the grids are drawn from every session, dow/hour only select cells. */
export function withoutCellFilter(filter: Filter): Filter {
  const { dow: _dow, hour: _hour, hourSpan: _span, ...rest } = filter;
  return rest;
}

export function withSelection(filter: Filter, selection: HourSelection): Filter {
  const next: Filter = { ...withoutCellFilter(filter), dow: selection.dow, hour: selection.hour };
  if (selection.hourSpan > 1) next.hourSpan = selection.hourSpan;
  return next;
}

export function selectionCount(grid: HeatGrid, selection: HourSelection): number {
  const r = grid.dows.indexOf(selection.dow);
  if (r < 0) return 0;
  return sum(grid.rows[r]!.filter((cell) => cellSelected(selection, cell)).map((cell) => cell.count));
}

export type CellClick = (cell: HeatCell, event: MouseEvent) => void;

export function WeekdayHourHeatmap({ grid, selection, onCellClick, label }: { grid: HeatGrid; selection?: HourSelection; onCellClick: CellClick; label: string }) {
  const cols = grid.hours.length;
  const labels = hourLabels(grid.bucketHours);
  const flipFrom = Math.ceil(cols / 2);
  return (
    <div class={`hm hm--cols-${cols}`} role="table" aria-label={label} style={`--hm-cols:${cols}`}>
      <div class="hm__row" role="row">
        <div class="hm__corner" role="columnheader">Day</div>
        {grid.hours.map((hour, c) => (
          <div key={hour} class="hm__h" role="columnheader" title={hourRangeLabel(hour, grid.bucketHours)}>{labels[c]}</div>
        ))}
        <div class="hm__h hm__h--total" role="columnheader">Total</div>
      </div>
      {grid.rows.map((cells, r) => {
        const dow = grid.dows[r]!;
        const rowTotal = grid.rowTotals[r]!;
        return (
          <div class="hm__row" role="row" key={dow}>
            <div class="hm__d" role="rowheader">{DOW_LABEL[dow]}</div>
            {cells.map((cell, c) => {
              const selected = cellSelected(selection, cell);
              const tip = cellTip(cell, grid.bucketHours, grid.total);
              const cls = `hm__cell hm__cell--l${cell.level}${selected ? " hm__cell--selected" : ""}${c >= flipFrom ? " hm__cell--end" : ""}`;
              return (
                <div class="hm__c" role="cell" key={cell.hour}>
                  <button
                    type="button"
                    class={cls}
                    data-tip={tip}
                    data-dow={dow}
                    data-hour={cell.hour}
                    data-count={cell.count}
                    data-selected={selected ? "true" : undefined}
                    aria-label={selected ? `${tip} (selected)` : tip}
                    onClick={(event) => onCellClick(cell, event)}
                  />
                </div>
              );
            })}
            <div class="hm__rt" role="cell" title={`${DOW_LABEL[dow]}: ${plural(rowTotal, "session")}`}>
              <span class="hm__rbar" style={`--v:${ratio(rowTotal, grid.maxRowTotal)}`} aria-hidden="true" />
              <span class="hm__n">{rowTotal}</span>
            </div>
          </div>
        );
      })}
      <div class="hm__row hm__row--foot" role="row">
        <div class="hm__d hm__d--total" role="rowheader">Total</div>
        {grid.colTotals.map((n, c) => (
          <div class="hm__ct" role="cell" key={grid.hours[c]} title={`${hourRangeLabel(grid.hours[c]!, grid.bucketHours)}: ${plural(n, "session")}`}>
            <span class="hm__cbar" style={`--v:${ratio(n, grid.maxColTotal)}`} aria-hidden="true" />
            <span class="hm__n">{n}</span>
          </div>
        ))}
        <div class="hm__grand" role="cell">{grid.total}</div>
      </div>
    </div>
  );
}

export function SkillWeekHeatmap({ grid, activeSkills, onRowClick, label }: { grid: SkillWeekGrid; activeSkills: readonly SkillUri[]; onRowClick: (uri: SkillUri) => void; label: string }) {
  const cols = grid.weeks.length;
  const flipFrom = Math.ceil(cols / 2);
  return (
    <div class={`hm hm--skills hm--cols-${cols}`} role="table" aria-label={label} style={`--hm-cols:${cols}`}>
      <div class="hm__row" role="row">
        <div class="hm__corner" role="columnheader">Skill</div>
        {grid.weeks.map((week) => {
          const { short, range } = formatWeek(week);
          return (
            <div key={week} class="hm__h hm__wk" role="columnheader" title={`${week} (${range})`}>
              <span><span class="hm__wk__w">{short.slice(0, 1)}</span>{short.slice(1)}</span>
              <small>{range.split(/\s[-\u2013]\s/)[0]}</small>
            </div>
          );
        })}
        <div class="hm__h hm__h--total" role="columnheader">Total</div>
      </div>
      {grid.rows.map((row) => {
        const active = activeSkills.includes(row.uri);
        return (
          <div class="hm__row" role="row" key={row.uri}>
            <div class="hm__d hm__d--skill" role="rowheader">
              <button type="button" class="hm__skill" title={row.uri} aria-pressed={active} onClick={() => onRowClick(row.uri)}>{row.name}</button>
            </div>
            {row.counts.map((count, c) => {
              const week = grid.weeks[c]!;
              const { short, range } = formatWeek(week);
              const tip = count > 0
                ? `${row.name} \u00b7 ${short} (${range}) \u00b7 ${plural(count, "load")} \u00b7 ${formatShare(count, grid.total)}`
                : `${row.name} \u00b7 ${short} (${range}) \u00b7 no loads`;
              return (
                <div class="hm__c" role="cell" key={week}>
                  <button
                    type="button"
                    class={`hm__cell hm__cell--l${row.levels[c]}${c >= flipFrom ? " hm__cell--end" : ""}`}
                    data-tip={tip}
                    data-week={week}
                    data-count={count}
                    aria-label={tip}
                    onClick={() => onRowClick(row.uri)}
                  />
                </div>
              );
            })}
            <div class="hm__rt" role="cell" title={`${row.name}: ${plural(row.total, "load")}`}>
              <span class="hm__rbar" style={`--v:${ratio(row.total, grid.maxRowTotal)}`} aria-hidden="true" />
              <span class="hm__n">{row.total}</span>
            </div>
          </div>
        );
      })}
      <div class="hm__row hm__row--foot" role="row">
        <div class="hm__d hm__d--total" role="rowheader">Total</div>
        {grid.colTotals.map((n, c) => (
          <div class="hm__ct" role="cell" key={grid.weeks[c]} title={`${grid.weeks[c]}: ${plural(n, "load")}`}>
            <span class="hm__cbar" style={`--v:${ratio(n, grid.maxColTotal)}`} aria-hidden="true" />
            <span class="hm__n">{n}</span>
          </div>
        ))}
        <div class="hm__grand" role="cell">{grid.total}</div>
      </div>
    </div>
  );
}

export function HeatLegend({ ranges, unit }: { ranges: string[]; unit: string }) {
  const describe = (range: string) => (range === "-" ? "unused at this scale" : /^\d+$/.test(range) ? plural(Number(range), unit) : `${range} ${unit}s`);
  return (
    <div class="hm__legend">
      <span>Less</span>
      {ranges.map((range, level) => (
        <span key={level} class={`hm__sw hm__cell--l${level}`} role="img" title={describe(range)} aria-label={`level ${level}: ${describe(range)}`} />
      ))}
      <span>More</span>
    </div>
  );
}

export function HeatmapStyles() {
  return <style>{HEATMAP_CSS}</style>;
}

// Every value below is a DESIGN.md token or derived from one (ramp = --accent at alphas, radius = --r-sm / 2).
export const HEATMAP_CSS = `
.hm-stack {
  --hm-l0: var(--wash);
  --hm-l1: color-mix(in srgb, var(--accent) 24%, transparent);
  --hm-l2: color-mix(in srgb, var(--accent) 46%, transparent);
  --hm-l3: color-mix(in srgb, var(--accent) 70%, transparent);
  --hm-l4: var(--accent);
  --hm-bar: color-mix(in srgb, var(--ink) 28%, transparent);
  --hm-r: calc(var(--r-sm) / 2);
  --hm-cell: var(--s-8);
  display: grid;
  gap: var(--s-4);
}
.hmc { background: var(--surface); border: 1px solid var(--line); border-radius: var(--r-md); padding: var(--s-4); overflow: clip; }
.hmc__head { display: flex; flex-wrap: wrap; align-items: center; gap: var(--s-2) var(--s-3); margin-bottom: var(--s-4); }
.hmc__title { margin: 0; font-size: var(--fs-title); font-weight: 600; letter-spacing: -0.01em; }
.hmc__meta { color: var(--ink-3); font-size: var(--fs-cap); font-variant-numeric: tabular-nums; }
.hmc__foot { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: var(--s-2) var(--s-4); margin-top: var(--s-4); color: var(--ink-3); font-size: var(--fs-cap); }
.hmc__hint { margin: 0; }
.hmc__empty { margin: 0 0 var(--s-3); color: var(--ink-2); font-size: var(--fs-sm); }
.hmc__empty .btn { margin-inline-start: var(--s-2); }

.seg { display: inline-flex; margin-inline-start: auto; border: 1px solid var(--line-2); border-radius: var(--r-sm); overflow: hidden; }
.seg__b { height: 32px; padding: 0 var(--s-3); border: 0; background: transparent; color: var(--ink-2); font-size: var(--fs-cap); font-weight: 500; cursor: pointer; transition: background-color var(--t-micro), color var(--t-micro); }
.seg__b + .seg__b { border-inline-start: 1px solid var(--line); }
.seg__b:hover { background: var(--wash); color: var(--ink); }
.seg__b[aria-pressed="true"] { background: var(--wash-2); color: var(--ink); }
.seg__b:focus-visible { outline-offset: -2px; }

.hm {
  --hm-gap: var(--s-1);
  display: grid;
  grid-template-columns: max-content repeat(var(--hm-cols), minmax(0, 1fr)) max-content;
  gap: var(--hm-gap);
  align-items: center;
  color: var(--ink-3);
  font-size: var(--fs-micro);
  font-weight: 500;
  font-variant-numeric: tabular-nums;
  line-height: 1.2;
}
.hm__row { display: contents; }
.hm__corner { padding-inline-end: var(--s-2); white-space: nowrap; }
.hm__h { text-align: center; white-space: nowrap; min-height: 1.2em; align-self: end; }
.hm__h--total { text-align: right; padding-inline-start: var(--s-1); }
.hm__wk { display: flex; flex-direction: column; align-items: center; }
.hm__wk small { font-size: inherit; font-weight: 400; }
.hm__d { padding-inline-end: var(--s-2); color: var(--ink-2); white-space: nowrap; }
.hm__d--total { color: var(--ink-3); }
.hm__d--skill { padding-inline-end: var(--s-1); max-width: 18ch; }
.hm__c { position: relative; height: var(--hm-cell); min-width: 0; }
.hm__cell { display: block; width: 100%; height: 100%; padding: 0; border: 0; border-radius: var(--hm-r); background: var(--hm-l0); cursor: pointer; transition: box-shadow var(--t-micro); }
.hm__cell--l1 { background: var(--hm-l1); }
.hm__cell--l2 { background: var(--hm-l2); }
.hm__cell--l3 { background: var(--hm-l3); }
.hm__cell--l4 { background: var(--hm-l4); }
.hm__cell:hover { box-shadow: inset 0 0 0 1px var(--ink-3); }
.hm__cell--selected, .hm__cell--selected:hover { box-shadow: inset 0 0 0 2px var(--ink); }
.hm__cell:focus-visible { outline-offset: 1px; z-index: 1; }
.hm__cell--end[data-tip]::after { left: auto; right: 0; }
.hm__skill { display: block; max-width: 100%; height: 100%; padding: 0 var(--s-2); border: 0; border-radius: var(--r-sm); background: transparent; color: var(--ink); font: 500 var(--fs-cap) / 1.3 var(--font-sans); text-align: left; cursor: pointer; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; transition: background-color var(--t-micro); }
.hm__skill:hover { background: var(--wash); }
.hm__skill[aria-pressed="true"] { background: var(--wash-2); }
.hm__rt { display: flex; align-items: center; gap: var(--s-2); min-width: calc(var(--s-12) + var(--s-8)); padding-inline-start: var(--s-2); }
.hm__rbar { display: block; flex: none; width: calc(var(--v) * var(--s-12)); height: var(--s-2); border-radius: var(--r-full); background: var(--hm-bar); }
.hm__n { color: var(--ink-2); }
.hm__ct { display: flex; flex-direction: column; align-items: center; justify-content: flex-end; gap: calc(var(--s-1) / 2); height: calc(var(--s-8) + var(--s-3)); min-width: 0; }
.hm__cbar { display: block; width: 100%; max-width: var(--s-3); height: calc(var(--v) * var(--s-6)); border-radius: var(--r-full); background: var(--hm-bar); }
.hm__ct .hm__n { max-width: 100%; overflow: hidden; }
.hm__grand { align-self: end; padding-inline-start: var(--s-2); color: var(--ink); font-size: var(--fs-cap); font-weight: 600; text-align: right; }

.hm__legend { display: inline-flex; align-items: center; gap: var(--s-1); }
.hm__sw { display: inline-block; width: var(--s-3); height: var(--s-3); border-radius: var(--hm-r); }
.hm__sel { display: flex; flex-wrap: wrap; align-items: center; gap: var(--s-2) var(--s-3); margin-top: var(--s-4); padding: var(--s-2) var(--s-3); border-radius: var(--r-sm); background: var(--surface-2); color: var(--ink); font-size: var(--fs-sm); }
.hm__sel strong { font-weight: 600; }
.hm__sel__actions { display: inline-flex; gap: var(--s-2); margin-inline-start: auto; }

@media (max-width: 639.98px) {
  .hm-stack { --hm-cell: var(--s-6); }
  .hm { --hm-gap: calc(var(--s-1) / 2); }
  .hm--cols-24 .hm__ct .hm__n, .hm--cols-24 .hm__rbar { display: none; }
  .hm--cols-24 .hm__rt { min-width: 0; padding-inline-start: var(--s-1); }
  .hm__rt { gap: var(--s-1); min-width: calc(var(--s-6) + var(--s-5)); padding-inline-start: var(--s-1); }
  .hm__rbar { width: calc(var(--v) * var(--s-6)); }
  .hm__d--skill { max-width: 10ch; }
  .hm__wk small, .hm__wk__w { display: none; }
  .seg { margin-inline-start: 0; }
}
`;
