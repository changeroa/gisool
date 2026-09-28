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

Deployment and fresh-session results will be recorded after verification.
