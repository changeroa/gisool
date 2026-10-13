# Local search regression benchmark

Run from the repository root after `npm --prefix local run build`:

```sh
node local/bench/search.mjs --check
```

It exercises the real `createSearchIndex` from `local/dist/search/index.js` on an in-memory SQLite store (lexical ranker + FTS5 trigram recall, fused with reciprocal rank fusion, k=60).

## Data

- `catalog.json`: a copy of `server/bench/catalog.json` (12 synthetic skills, two explicit-only) with added `aliases_ko` and `examples` fields. The bench maps `keywords` + `aliases_ko` to `aliasesKo` and `examples` to `examples`.
- `search-cases.json`: a copy of `server/bench/search-cases.json` (24 expected matches, 8 no-match queries).
- `paraphrase-cases.json`: the 8 keyword-free KO/EN requests from research verify V3, which the server ranker answered 0/8.
- `real-log-cases.json`: 6 unlabeled free-text queries from Codex event logs (research V6, 2026-09-18..25). These are smoke cases; results are reported, never gated.

## Gates (`--check`)

Hit@1 >= 0.9 and Hit@5 >= 0.98 on the ported cases, negative abstention == 1, exact-name accuracy == 1, preserved invocation policy, paraphrase Hit@3 >= 0.75 (6 of 8), warm p95 <= 20 ms, and `DEFAULT_THRESHOLD` equal to the calibrated value.

## Threshold calibration

`calibrate()` sets the abstention threshold T just above the best fused score of any negative case, so that every negative abstains (T = 0 when no negative produces any hit; those abstain as `no_overlap`). A run without `--check` writes the calibrated value into `DEFAULT_THRESHOLD` in `local/src/search/fusion.ts`; rebuild afterwards. `--check` fails if the constant is stale. At runtime, `meta.search_threshold` in the store overrides the constant, so a fresh `~/.gisool` works without running the bench.

## What this does and does not measure

The paraphrase gate is a regression gate over hand-authored aliases: the aliases and the queries were written by the same maintainers, so it measures alias coverage, not ranker quality. Real quality comes from `gisool eval` on prompts captured from your own sessions. All cases are maintainer-authored, not an independent holdout, and local timings exclude MCP and agent overhead.

Options: `--output report.json` saves detailed results (per-case ranks, scores, negative best scores, smoke results); `--mode automatic|explicit|discovery` changes the search mode (default `discovery`).
