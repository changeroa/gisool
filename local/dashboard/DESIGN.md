# gisool Dashboard Design System

Scope: `local/dashboard/**` (the Preact app served by the gisool daemon at `http://127.0.0.1:8799`).
Every color, size, and spacing value used by dashboard code must trace to a token here; the tokens
live as CSS custom properties in `styles.css` under the same names.

## 0. Research Log

- Embedded refs: shortlisted `linear.app`, `sentry`, `posthog` (data-dense dashboards) -> picked
  `taste-skill` (operational brief) + `layout-skill` (app shell) + `linear.app` as the Layer B token
  source, because the plan's mockups (`.senpi/html-pages/gisul 대시보드 목업*.html`,
  `gisul 라이브 활동 화면 목업*.html`) are near-black, card-based, achromatic with one accent and
  semantic status chips, which is Linear's luminance-stepping model. The mockups set visual
  direction only; the celebration ("처음 쓰임") card is dropped on purpose (user decision).
- Lazyweb: skipped - the plan supplies concrete mockups as the visual contract; no external
  research lane was budgeted for this executor.
- Imagen drafts: skipped - concrete mockups given; no generated concept needed.

## 1. Atmosphere & Identity

A quiet instrument panel for one person's skills. It reads like a log viewer that respects the
reader: dense rows, calm chrome, nothing animated unless it reports a live fact. Surfaces are
separated by luminance steps and hairline translucent borders, not by shadows or colored stripes.
The signature is restraint - one accent (indigo) used only for the live dot, the active tab, links,
and the keyboard focus ring; everything else is ink at alphas. Status (adoption state) is the only
other chroma, and it is semantic, never decorative. No streaks, badges, celebrations, or gimmicks.

## 2. Color

Light and dark values swap under `prefers-color-scheme: dark`. Washes are derived with
`color-mix()` from the ink and status colors so there is one ramp per role.

| Role | Token | Light | Dark | Usage |
|------|-------|-------|------|-------|
| Canvas | `--bg` | #f7f8f8 | #0f1011 | Page background |
| Surface | `--surface` | #ffffff | #151618 | Table, cards, header |
| Surface raised | `--surface-2` | #f3f4f5 | #1b1c1e | Monogram tiles, inputs, tooltip bg (inverted) |
| Ink | `--ink` | #15171a | #f7f8f8 | Primary text |
| Ink secondary | `--ink-2` | #5c6069 | #b4b9c2 | Body metadata, labels |
| Ink tertiary | `--ink-3` | #8a8f98 | #7f848d | Timestamps, dim text, placeholders |
| Line | `--line` | rgba(21,23,26,.08) | rgba(255,255,255,.08) | Hairline borders, dividers |
| Line strong | `--line-2` | rgba(21,23,26,.16) | rgba(255,255,255,.16) | Input borders, chip borders on hover |
| Wash hover | `--wash` | rgba(21,23,26,.04) | rgba(255,255,255,.04) | Row hover, ghost button hover |
| Wash active | `--wash-2` | rgba(21,23,26,.08) | rgba(255,255,255,.08) | Active tab, pressed, selected |
| Accent | `--accent` | #5e6ad2 | #7170ff | Live dot, active tab text, links |
| Accent hover | `--accent-2` | #4f5bc4 | #828fff | Link hover |
| Accent wash | `--accent-wash` | color-mix(accent 12%) | color-mix(accent 18%) | Live dot halo, focus ring halo |
| Status ok | `--ok` | #1f8f45 | #3ccb6a | `loaded` |
| Status warn | `--warn` | #a8690f | #e0a84a | `exposed_only` |
| Status bad | `--bad` | #c0392b | #ef6b6b | `no_match`, ingest errors, offline dot |
| Status neutral | `--neutral` | #8a8f98 | #7f848d | `aborted`, `not_used`, unattributed |

Rules
- Accent never marks state on a border. Selected / active / hover are `--wash` / `--wash-2`
  backgrounds plus ink; `:focus-visible` rings (`--accent`) are the only colored edge.
- Status colors appear only in state badges, the ingest error count, the live dot, and timeline
  step dots (kind colors, see TimelineStep): prompt `--ink`, search `--accent`, load / read_file
  `--ok` (read_file hollow), native_skill `--warn` (hollow), error `--bad`, session_start / end
  `--neutral`. Candidate score bars use `--ok` when the candidate was loaded, otherwise ink at 35%.
- Never introduce a color outside this table; extend the table first.

## 3. Typography

| Level | Token | Size / Weight / LH | Usage |
|-------|-------|--------------------|-------|
| Title | `--t-title` | 15px / 600 / 1.3, tracking -0.01em | Brand wordmark, empty-state heading |
| Body | `--t-body` | 14px / 400 / 1.5 | Prompt text, empty-state copy |
| Small | `--t-sm` | 13px / 400 / 1.5 | Table cells, tabs, inputs, chips |
| Caption | `--t-cap` | 12px / 500 / 1.4 | Column headers, badges, meta |
| Micro | `--t-micro` | 11px / 600 / 1.2, tracking 0.02em | Monogram letters, counts |

Font stack
- Sans `--font-sans`: `"Pretendard Variable", Pretendard, -apple-system, BlinkMacSystemFont,
  system-ui, "Apple SD Gothic Neo", "Segoe UI", Roboto, sans-serif` (system stack plus Pretendard
  when installed; never fetched from the network).
- Mono `--font-mono`: `ui-monospace, "SF Mono", Menlo, Consolas, monospace` for commands and
  session ids. Numbers use `font-variant-numeric: tabular-nums`.

Rules
- Korean text uses `word-break: keep-all` plus `overflow-wrap: anywhere` so words never split
  mid-syllable but unbroken URIs still wrap.
- Nothing below 11px; body copy never below 13px.

## 4. Spacing & Layout

Base unit 4px.

| Token | Value | Usage |
|-------|-------|-------|
| `--s-1` | 4px | Icon-to-label, chip inner gap |
| `--s-2` | 8px | Chip padding, cell inner gaps |
| `--s-3` | 12px | Cell padding, toolbar gaps |
| `--s-4` | 16px | Page gutter (mobile), card padding |
| `--s-5` | 20px | Section inner spacing |
| `--s-6` | 24px | Page gutter (desktop), block gaps |
| `--s-8` | 32px | Empty-state padding |
| `--s-12` | 48px | Empty-state vertical rhythm |

Layout
- Max content width `--max-w: 1180px`, centered; gutter `--s-4` under 640px, `--s-6` above.
- Shell = `sticky-header + document scroll`: the document owns vertical scroll; the header and tab
  bar are one sticky block at `top: 0`. No nested scroll regions in this todo's views.
- Breakpoint `--bp-sm: 640px`: the sessions table becomes a card list (`tr` -> grid card with
  named areas). Primary content never scrolls horizontally at 390px.
- Primitives used: `stack`, `cluster` (filter chips, skill chips), `content-limiter` (empty
  state, 48ch), `page-grid` (header / tabs / main).

## 5. Components

### AppShell (`main.tsx`)
- Structure: `header.top` (brand, live dot, filter chips) > `nav.tabs` > `main.page`.
- States: live dot `connecting` (neutral, no pulse), `live` (accent, one slow pulse), `offline`
  (bad), `fixtures` (accent, static, labelled "fixtures").
- Layout: page-grid, sticky header; `main` is a `stack` inside a `content-limiter` at `--max-w`.
- Motion: the live dot pulses at 2.4s ease-in-out (opacity + scale only); under
  `prefers-reduced-motion` it is static.

### TabBar
- Structure: `nav` > `a.tab` x3 (Sessions, Flow, Heatmap); hrefs keep the current filter query.
- States: default `--ink-2`; hover `--wash`; active `--wash-2` + `--ink`; `focus-visible` ring.
- Accessibility: `aria-current="page"` on the active tab; 36px min target height.

### FilterChip
- Structure: `span.chip` > label (`--ink-3`) + value (`--ink`) + `button.chip__x` (remove).
- Variants: default, removable. Spacing: `--s-2` horizontal, `--s-1` inner gap; radius `--r-full`.
- States: hover `--line-2` border; `focus-visible` ring on the remove button.
- Accessibility: remove button has `aria-label="Remove <label> filter"`.

### SessionsToolbar (`views/sessions.tsx`)
- Structure: `form.toolbar` > search input (`q`) + runtime `select` + state `select`.
- States: input focus ring; placeholder `--ink-3`.
- Layout: `cluster`; wraps at narrow widths.

### SessionsTable
- Structure: `table.sessions` with columns runtime / started / prompt / skills / state /
  attribution; each row is a link target (`a.rowlink` on the prompt cell + whole row click).
- Spacing: cell padding `--s-3` x `--s-3`; row min-height 56px.
- States: hover `--wash`; `focus-visible` ring on the row link; empty (two variants below).
- Accessibility: real `<table>` semantics on desktop; `<th scope="col">`; on cards each cell keeps
  `data-label` for context.
- Layout: under 640px rows become grid cards:
  `"runtime started" / "prompt prompt" / "skills skills" / "state attr"`.

### RuntimeLabel
- Structure: `span.rt` > `span.rt__mark` (two-letter monogram, `--surface-2` tile, radius
  `--r-sm`) + label text. One geometric mark per runtime; no emoji, no hand-drawn glyphs.

### StateBadge
- Structure: `span.badge.badge--<state>` > dot + label. Dot color = status token; text `--ink-2`;
  background `color-mix(status 12%)`.
- Variants: loaded (ok), exposed_only (warn), no_match (bad), aborted / not_used (neutral).

### SkillChip
- Structure: `span.skill` with the skill dir name; `title` carries the full URI. Max 3 shown,
  then `+n` chip. Border `--line`, radius `--r-full`, font `--t-cap`.

### Tooltip
- Structure: any element with `data-tip` and `tabindex="0"`; `::after` renders `attr(data-tip)`
  on `:hover` and `:focus-visible`, inverted (`--ink` bg, `--bg` text), radius `--r-sm`.
- Used by the dim `unattributed` attribution cell: text `unattributed: <reason>`.

### EmptyState
- Structure: `section.empty` > title (`--t-title`) + copy + checklist (`dl`) + command `<code>`.
- Variants: `waiting` (no events yet: per-runtime last-seen list, ingest counters, `gisool doctor`)
  and `filtered` (events exist, filter matches nothing: "Clear filters" ghost button).

### GhostButton
- `button.btn`: transparent bg, `--line-2` border, radius `--r-sm`, 32px height; hover `--wash`;
  active `--wash-2` + `translateY(1px)`; `focus-visible` ring. `[disabled]` keeps the border, text
  `--ink-2`, default cursor; the saved eval-case variant (`data-save-eval="saved"`) is `--ok` text
  plus a check glyph.

### TraceHeader (`views/trace.tsx`)
- Structure: `header.trace__head.card` > `a.trace__back` (chevron + "Sessions", keeps the list
  filter) > `h1.trace__title` (first prompt; dim italic "(no prompt captured)") > `dl.trace__meta`
  (Runtime / Started / Duration / Attribution / State / Session) > `p.trace__counts`.
- Duration states: ended (`42m`), live and open (`in progress · 3m so far`), open without a live
  stream (`3m (no end recorded)`). Attribution `none` renders `unattributed · <reason>` in `--ink-3`.
- Spacing: card padding `--s-4` x `--s-5` (mobile `--s-4`); meta gaps `--s-3` x `--s-6`.

### Timeline / TimelineStep (`views/trace.tsx`)
- Structure: `div.card.tl__card` > `ol.tl` > `li.tl__step.tl__step--<kind>` > `span.tl__dot` +
  `div.tl__head` (`span.tl__kind` label, optional `span.tl__tag` "native" / "abstained",
  `time.tl__time` = HH:MM:SS + `+offset` from session start) + `div.tl__body`.
- Rail: a 2px `--line-2` segment per step, starting at the first dot and ending at the last dot;
  dots are 8px (`--s-2`) with a 2px `--surface` ring so the rail never crosses them; hollow dots
  (read_file, native_skill) are an inset 2px ring of the kind color.
- Bodies: prompt = `p.tl__text` (pre-wrap) with a `button.foldbtn` fold over 600 chars; search =
  mode / elapsed ms / count / trace id row + `blockquote.tl__query` (`--wash`) + CandidatesPanel
  or AbstainBlock; load = name + mono URI + `@<8-char manifest digest>`; read_file = mono
  resource path relative to the skill dir + bytes + `from <skill>`; native_skill = name + `via`;
  error = mono code in `--bad` + message; session_end = `after <duration>`.
- Empty states: `section.empty` "Session not found" (stale id) and `div.callout` "This session
  never consulted gisool" above the timeline when no search step exists.
- Motion: none; live updates refetch the trace and keyed steps keep their DOM nodes.

### CandidatesPanel (`components/candidates.tsx`)
- Structure: `ol.cands` > `li.cand[.cand--chosen]` grid with areas
  `rank name inv bar score pick` / `rank desc` (mobile: `rank name inv score pick` / `rank bar` /
  `rank desc`). Rows are ordered by score descending, ties by rank.
- Parts: `cand__rank` (`--ink-3`, tabular), `cand__name` (ink, 500), `cand__inv` tag (`auto` /
  `explicit`, mono micro on `--surface-2`), `cand__bar` 6px track `--wash-2` with `cand__fill`
  width = score, `cand__score` (2 decimals), `cand__pick` = Lucide check in `--ok` only on loaded
  candidates, `cand__desc` (description `·` matched terms, `--ink-3`).
- States: chosen row = `--wash` background + `--ok` fill + check; nothing else is colored.

### AbstainBlock (`views/trace.tsx`)
- Structure: `div.tl__abstain` (hairline `--line`, radius `--r-sm`) > StateBadge
  `badge--no_match` "abstained · <reason>" > `p.tl__hint` > GhostButton "Save as eval case"
  (POSTs `{query, fromTraceId}`; states idle / saving / saved / error with a `role="alert"` line).

### Callout
- `div.callout`: hairline card (`--line`, `--r-md`, `--surface`) with a bold `--ink` title and
  `--ink-2` copy; used for the never-consulted empty state. No status color.

### TextFold
- `button.foldbtn`: text-only accent button (`--fs-cap`, 500) toggling the prompt body between the
  600-char head and the full text; `aria-expanded` reflects the state.

## 6. Motion & Interaction

| Type | Duration | Easing | Usage |
|------|----------|--------|-------|
| Micro | 120ms | ease-out | Hover washes, button press |
| Live pulse | 2400ms loop | ease-in-out | Live dot only (opacity + scale) |

Rules: animate only `transform` and `opacity`; no entrance animations on rows (lists refetch
silently); `prefers-reduced-motion: reduce` removes the pulse and all transitions.

## 7. Depth & Surface

Strategy: tonal-shift plus hairline translucent borders (Linear's luminance stepping). No drop
shadows except the tooltip (`--shadow-pop: 0 4px 16px rgba(0,0,0,.18)`).

| Token | Value | Usage |
|-------|-------|-------|
| `--r-sm` | 6px | Inputs, buttons, monogram tiles, tooltip |
| `--r-md` | 10px | Table container, cards, empty state |
| `--r-full` | 9999px | Chips, badges, dots |

Nested corners are concentric (card 10px, inner chip 6px with 4px padding).

## 8. Accessibility Constraints & Accepted Debt

Constraints: WCAG 2.2 AA; body contrast >= 4.5:1 in both schemes (`--ink-2` on `--surface` is
7.1:1 light / 9.8:1 dark); every interactive element reachable by keyboard with a visible
`focus-visible` ring; tooltips open on focus as well as hover; `prefers-reduced-motion` honored;
`lang="en"` document with Korean-safe line breaking.

| Item | Location | Why accepted | Owner / Exit |
|------|----------|--------------|--------------|
| Trace / Flow / Heatmap views render "Coming soon" | `views/{trace,flow,heatmap}.tsx` | Stubs owned by todos 15-17 | Replaced in Wave 2 |
| Attribution reason tooltip depends on an optional `attributionReason` field the API may omit | `views/sessions.tsx` | `SessionRow` is frozen without a reason field; the dashboard tolerates its absence ("reason not reported") | Todo 5/12 may add the field; no contract change needed here |
| Trace view CSS ships as a `<style id="gisool-trace-style">` injected by `views/trace.tsx` instead of living in `styles.css` | `views/trace.tsx` | `styles.css` is owned by todo 6 in this wave; the block uses only tokens from this file | Fold into `styles.css` once the ledger allows (todo 18/19 cleanup) |
| Trace header fetches `/api/sessions` unfiltered and picks the row client-side | `views/trace.tsx` | The HTTP surface has no `GET /api/sessions/:id`; the list is local and small | Add a by-id endpoint if the list grows past retention defaults |
