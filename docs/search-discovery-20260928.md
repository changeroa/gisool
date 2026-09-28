# Subject-first skill discovery

Long natural-language requests previously returned no candidates unless every
word occurred in metadata. Ranked modes now tokenize and normalize the request,
weight names/keywords/descriptions by corpus rarity and coverage, and allow
unmatched narrative details. Exact names remain first. Incidental single-word
matches in a longer request are excluded. The legacy mode is unchanged.

`discovery` returns relevant candidates across the catalog with an invocation
policy; it does not activate a skill. `automatic` still excludes explicit-only
skills. The loader searches before new actionable tasks, retries a failed subject
once with fewer terms, selects each skill separately, and respects explicit-only
policies. Small writing tasks are actionable; greetings and unchanged task
continuations are not new discovery requests. Local global guidance is aligned
after the runtime is deployed.

The content repository adds bilingual keywords to all 39 manifests. Three bounded
text transforms (debloat, dedash, reorder) become automatically eligible. The
other nine explicit-only workflows retain that policy. Skill bodies, supporting
files and URI identities are preserved.

## Reproducible regression measurements

```sh
npm --prefix server run build
node server/bench/search.mjs --inventory docs/evidence/search-20260928/catalog-after.json --check
```

The fixed corpus has 46 positive natural-language requests covering all 39 skills
and eight unrelated queries, plus 39 exact-name and nine remaining explicit-policy
checks. Two positive requests come verbatim from observed fresh-session searches.
Expected names and cases were written before modifying the ranker or metadata.

| Metric | Before | After |
|---|---:|---:|
| Natural-language Hit@1 / Hit@5 / MRR | 0 / 0 / 0 | 1 / 1 / 1 |
| Unrelated-query abstention | 8/8 | 8/8 |
| Exact identity first | 39/39 | 39/39 |
| Explicit invocation filter | 12/12 | 9/9 (three deliberate policy changes) |
| Warm local p95 | 0.118ms | 0.056ms |
| Cold index p95 | 0.114ms | 1.267ms |

Latency has a tradeoff: the bounded metadata index reduces repeated-search cost
but takes about 1ms more to build. Local timings exclude network and agent work.
They use 1,080 warm samples and 30 cold samples per version; live timings and
fresh-session behavior are recorded separately. This is not a claim that every
latency metric improved. No embedding service or network dependency was added.

These are maintainer-authored regression examples, not an independent holdout.
The implementer also selected the keywords, so a perfect regression score does
not establish general semantic accuracy. Preserve raw reports, compare unchanged
fresh-session prompts, avoid mentioning skill names in those prompts, and report
failed or skipped discovery as observed. The original global instructions named
ux-state-review, so the old name-search recovery is not blind retrieval evidence.

Metadata snapshots are evaluation fixtures only; runtime routing never imports
them. Reports are in `docs/evidence/search-20260928`. The previous end-to-end
baseline is retained locally at `/Users/victor/tmp/gisul-search-benchmark-20260928`.

## Deployment

- Runtime PR: https://github.com/Ark-Point/gisul/pull/3
- Content PR: https://github.com/Ark-Point/gisul-skills/pull/3
- Runtime source: `6f8871285f7b850047151d757dba6d63b4935025`
- Cloudflare version: `4e713606-76e9-4754-9411-8e09d7b39d9a`
- Content source: `bf5c9674aee361bcaa183e78488cc5bb1b8a40cc`, release `20260928.8`
- Endpoint: https://gisul.arkpoint.dev/mcp
- Canonical runtime: `/Users/victor/projects/gisul`
- Canonical content: `/Users/victor/projects/arkpoint-gisul-skills`

Runtime CI passed 49 server tests, 59 Worker tests, the search corpus, TypeScript
checks, plugin checks and deployment compilation. Content validation and five
tests passed before gated publication. Live health reports the exact runtime
commit and OAuth discovery/anonymous denial pass. Authenticated production
search passed all 54 cases, 39 exact identities and nine explicit-policy filters;
load retained the searched content commit. Direct HTTP p50 was 618ms and p95
749ms over 103 searches, with at most four independent requests in flight.
Those timings are not directly comparable to the previous Codex MCP timings.

The local Codex plugin was updated to 0.4.0 and installed bytes matched the
committed loader. Other plugins remained unchanged and gisul@personal remained
absent. Global guidance now searches short actionable tasks, uses discovery,
retries an empty result once and removes named workflow examples that could prime
selection. Its previous version is backed up under
`~/.codex/backups/gisul-search-upgrade-20260928-104136`.

Fresh-session measurements are recorded separately in `agent-after.json`.

## Fresh Codex session comparison

Five identical prompts were each run in a fresh `/new` session in Herdr, using
Codex 0.157.1 and gpt-6-astra with max reasoning both before and after. Session
IDs are distinct and the current global instructions were checked in every log.
No prompt mentions Gisul, search mechanics or a target skill name.

| Case | Search calls before / after | Loaded after | Total seconds before / after |
|---|---:|---|---:|
| state-flow | 2 / 1 | ux-state-review | 88.25 / 92.23 |
| prose | 0 / 1 | debloat | 15.74 / 32.74 |
| simple-edit | 0 / 2 | none | 22.98 / 22.54 |
| dev-status | 0 / 1 | development-status | 20.26 / 73.07 |
| dev-status-unconstrained | 1 / 1 | development-status | 30.68 / 41.98 |

Search participation improved from 2/5 to 5/5. The four tasks with an expected
skill selected it on the first subject search; button-copy review selected none.
No unrelated UX-state skill was loaded. The original two natural-language
searches returned no candidates; after deployment, all four relevant tasks found
the intended skill first without a guessed-name retry.

Observed native MCP search mean was 771.94ms before (n=3) and 874.80ms after (n=6). Network latency improvement is not established. Total response time increased for some tasks because discovery and skill loading were previously skipped; model reasoning also varies. These samples do not justify a general success rate or latency percentile.

The measurable improvement is consistent discovery, relevant selection and
abstention, not an across-the-board wall-clock speedup. Live HTTP benchmarks
and local warm/cold timings remain separate. The test pane was closed after
completion. No temporary worktree was created.
