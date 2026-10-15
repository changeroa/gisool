# Execution ownership and session lifetime

## Recorded cuts (schema 4)

Integration note: this isolated branch starts at `ca73462`, so the registry's fourth step
is the boundary migration. Its filename is reserved as `005_execution_boundaries.sql` to
avoid colliding with approved parallel commit `bc260550`'s `004_load_reconciliation.sql`.
When combining them, register reconciliation first and boundaries second, set schema version
to 5, accept history versions 1 through 5, and update current-version test assertions to 5.
Do not deploy this branch's standalone schema-4 database as reconciliation's schema 4.
The registry index, not the filename, determines `PRAGMA user_version`.

An execution is an analysis interval, not a session lifetime. Event timestamps remain
runtime timestamps. Equal timestamps do not establish causal order.

Registration records the identities of events already present at its exact millisecond.
Those events cannot belong to the newly registered execution. Ending records the identities
of events at its exact timestamp, equal-time or untimed span identities, and the observed
session ends. These cuts are stored on the flow
row in the same SQL statement as its lifecycle timestamp. An idempotent end never recaptures.

An event is owned when:

1. Its timestamp is at or after registration and at or before the end, when ended.
2. If equal to registration, its identity was not in the registration snapshot.
3. If equal to the end, its identity was in the end snapshot.

This is **local recording-order evidence at a timestamp tie**, not an assertion about
runtime causal order or network delivery order. Delayed boundary telemetry is not silently
reassigned to a completed execution. It remains in workspace/session history. Data recorded while
no execution was active may belong to neither execution, even if the clock did not advance.
Timestamp-interior events remain timestamp-scoped, including delayed telemetry received after
closure. This preserves the existing late-ingestion and attribution-reconciliation contract.

For adjacent A and B sharing millisecond t, an event recorded before A ends belongs to
A's end snapshot and B's registration exclusion. An event recorded after B starts is
absent from A's snapshot and B's exclusion. Thus neither category is duplicated or lost.
This also holds for zero-duration executions. No UUID comparison or SQLite rowid is used
to invent lifecycle order; identity survives reopening, VACUUM and history import.

The owned event set is shared by tree membership, finding, usage, comparison and unresolved
load warnings. Earlier prompts only supply continuing turn identity, not inherited skills
or calls. Boundary prompt filtering and span identity cuts prevent B's equal-time prompts/spans
from moving A's calls to a new turn. Snapshots contain IDs and observed lifecycle metadata, not captured
prompt/tool content; retention still removes content normally.

Completed reports remain stable against the adjacent execution's boundary and later activity.
This is not an immutable export: delayed interior events, corrected attribution/reconciliation,
topology labels, automation classification and retained content can still change their
respective interpretation. The underlying event history is never deleted by flow scoping.

## History without recorded cuts

Migration does not backfill imaginary historical snapshots. Missing start/end cuts are NULL.
At a missing cut, exact-boundary events are excluded from credited execution results and
`executionScope.boundary` is `order_unavailable`. Interior timestamps remain usable.
The API and dashboard disclose this uncertainty and point to workspace history. A historical
same-millisecond causal ordering cannot be recovered from independent event and flow rowids.

## Lifecycle versus analysis

`SessionTree.startedAt` and `endedAt` describe observed session lifetime, never clipping.
In a completed execution, an end strictly inside the window can arrive late; an end exactly
at the boundary must have been observed at closure. An end beyond the window is not part
of that execution's observations and is NULL there. The unscoped session report retains the
latest actual termination observation.
`executionWindow: { from, to }` separately describes the analysis slice. Turn/span durations
are clipped to this slice. An execution end never becomes a session end.

An unended session in an ended flow renders `end_not_observed`, not `ended`. A complete
herdr snapshot omitting both agent fields after a known agent was present is an observed
disappearance; an omitted field in a partial status event is not.

## Attribution uncertainty

Unresolved load disclosures show the real count and every affected URI in both flow and
session trace reports. They mean a recorded load cannot yet be assigned confidently, not
that a skill was unused. Flow warnings use the same recorded identity cuts as the tree;
reconciliation remains responsible for candidate and URI matching.

## Storage cost

Registration and end snapshots cover only equal-time event IDs. The end also records
equal-time/untimed span IDs and member-session end observations.
These are per-execution metadata, not a second content archive. Large simultaneous batches
and untimed span histories increase snapshot size; no claim of a new flow-scale performance benchmark
is made by the existing search benchmark.
