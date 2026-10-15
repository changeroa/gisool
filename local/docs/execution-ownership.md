# Execution ownership and session lifetime

## Recorded cuts (schema 6)

An execution is an analysis interval, not a session lifetime. Event timestamps remain
runtime timestamps. Equal timestamps do not establish causal order.

Registration and end capture a persistent database clock's domain and counter in the same
SQL statement as the lifecycle timestamp. Insert triggers advance that clock and stamp each
event/span atomically. Duplicate event/source-key and composite-span replays are no-ops.
An idempotent end never recaptures. Membership is resolved separately on read: mapping a
pane after registration or discovering its session after closure cannot move these cuts.

An event is owned when:

1. Its timestamp is at or after registration and at or before the end, when ended.
2. If equal to registration, its recorded order in the start domain exceeds the start cut.
3. If equal to the end, its recorded order in the end domain is at or below the end cut.

This is **local recording-order evidence at a timestamp tie**, not an assertion about
runtime causal order or network delivery order. Delayed boundary telemetry is not silently
reassigned to a completed execution. It remains in workspace/session history. Data recorded while
no execution was active may belong to neither execution, even if the clock did not advance.
Timestamp-interior events remain timestamp-scoped, including delayed telemetry received after
closure. This preserves the existing late-ingestion and attribution-reconciliation contract.

For adjacent A and B sharing millisecond t, an event recorded before A ends is at or below
A's end cut and B's start cut. An event recorded after B starts exceeds both cuts.
Thus neither category is duplicated or lost.
This also holds for zero-duration executions. No UUID comparison or SQLite rowid is used
to invent lifecycle order. The counter survives deletion, retention, reopening and VACUUM.

The owned event set is shared by tree membership, finding, usage, comparison and unresolved
load warnings. Earlier prompts only supply continuing turn identity, not inherited skills
or calls. Indexed conversation/call/exact-pair joins select relevant endpoint or untimed
spans, whose recorded order must pass the end cut. Interior delayed spans remain eligible.
`putSpans` keeps the first observation on replay. Explicit SQL corrections to span facts
receive new order and invalidate old provenance; changed endpoint facts cannot borrow the
former facts' pre-close order. The metadata contains no captured prompt/tool content.

Completed reports remain stable against the adjacent execution's boundary and later activity.
This is not an immutable export: delayed interior events, corrected attribution/reconciliation,
topology labels, automation classification and retained content can still change their
respective interpretation. The underlying event history is never deleted by flow scoping.

## Portable history and unavailable order

Each row stores order by recording domain. History import retains source-domain marks and
adds destination arrival order; chained export/import preserves both. The local clock is
never imported or reset. New local flows therefore see imported rows as already present,
while imported flows can still use their source cuts. Import skips existing identities:
if a duplicate lacks the source order, it remains unknown rather than borrowing local order.
Start and end domains can differ when an imported open flow is closed locally.

Migration establishes a new domain and marks existing observations at zero. This proves
only that they precede future cuts, not their relative order or a historical cut. Pre-v6
flow cuts remain unavailable because schema-5 identity snapshots may have omitted eventual
members. Known positive end identities remain usable; absence from an old start snapshot
is not proof of later arrival. Unproven exact-boundary events are excluded from credited
results and `executionScope.boundary` is `order_unavailable`. Interior timestamps remain usable.
The API and dashboard disclose this uncertainty and point to workspace history. A historical
same-millisecond causal ordering cannot be recovered from independent event and flow rowids.
An observation from a different database with no mark for a flow's domain is also uncertain
at equality. A full database restore retains its lineage; independently writable databases
must be created separately and combined through export/import, not forked database files.

## Lifecycle versus analysis

`SessionTree.startedAt` and `endedAt` describe observed session lifetime, never clipping.
In a completed execution, an end strictly inside the window can arrive late; an end exactly
at the boundary must have been observed at closure. An end beyond the window is not part
of that execution's observations and is NULL there. The unscoped session report retains the
latest actual termination observation.
Bounded member-session end snapshots preserve already known ends against later updates.
An end-order stamp also recognizes a current endpoint termination when membership is learned
after close. Neither a later termination nor flow closure invents a previous observed end.
`executionWindow: { from, to }` separately describes the analysis slice. Turn/span durations
are clipped to this slice. An execution end never becomes a session end.

An unended session in an ended flow renders `end_not_observed`, not `ended`. A complete
herdr snapshot omitting both agent fields after a known agent was present is an observed
disappearance; an omitted field in a partial status event is not.

## Attribution uncertainty

Unresolved load disclosures show the real count and every affected URI in both flow and
session trace reports. They mean a recorded load cannot yet be assigned confidently, not
that a skill was unused. Flow warnings use the same recorded-order predicates as the tree;
reconciliation remains responsible for candidate and URI matching.

## Storage cost

Registration stores only a scalar cut. End stores a scalar cut and bounded member-session
end observations, not event IDs or historical span IDs. Candidate-session event and load
indexes bound reads; endpoint span joins use the same indexes as tree assembly. GET is
read-only. Unrelated history does not enlarge cut identities or scope-query populations.
Native observation metadata has one domain entry; imported metadata grows with its database
ancestry, not with unrelated history. A search benchmark is separate from flow-scale checks.
