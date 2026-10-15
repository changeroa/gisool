# Skill tracing

gisool joins agent telemetry to herdr panes and compares observed skill use with an orchestrator's intended
workflow. Analysis is computed from stored events when a report is read. It observes; it does not judge with
an LLM, restrict skill choices, or send input to panes.

## Requirements

herdr is required. Start herdr and run `gisool doctor` (or `gisool doctor --json`). The `herdr` check discovers
the socket through `herdr status server` and sends a ping; `GISOOL_HERDR_SOCKET` overrides socket discovery.
A missing herdr command, unavailable socket, or invalid ping reply fails the check with `herdr_unavailable`;
doctor exits 1 if any check fails.

If herdr is unreachable, the daemon keeps collecting sessions and serving MCP and existing views. New panes
and sessions requiring live discovery are not linked until sync reconnects and reconciles. Previously stored
pane/session links and reports remain available, including with `GISOOL_HERDR=off`. A session skill report
can be read without a herdr link. Workspaces also shows these sessions as **outside herdr**; herdr being
unavailable does not hide ingested sessions from the flows list.

## What is collected

These fields were observed in captures of Claude Code 2.1.273 and Codex CLI 0.162.1 on October 14, 2026.
The table describes what gisool keeps, not every field those agents export.

| Agent / channel | Records kept | Available measurements and identity |
| --- | --- | --- |
| Claude Code logs | `claude_code.api_request` | Model, input/output and cache read/creation tokens, reported USD cost, duration, TTFT, request ID, optional skill name; `session.id` and `prompt.id`. |
| Claude Code logs | `claude_code.tool_result` | Tool name, captured arguments, success, duration, input/result byte counts, `tool_use_id`, `prompt.id`. Skill-file reads can also produce native-skill observations. No result-content field was observed. |
| Claude Code logs | `claude_code.skill_activated`, `claude_code.user_prompt` | Skill name, trigger/source and turn key; prompt text when exported, otherwise unavailable text with reported length when present. |
| Codex logs | `codex.sse_event` with `event.kind=response.completed` | Model, input/output, cached/cache-write, reasoning and total tokens, TTFT when reported; `conversation.id`. No reported USD cost. Other SSE events are ignored. |
| Codex logs | `codex.tool_result` | Tool name, captured `arguments`, success, duration, `call_id`, conversation and log span context. Captured tool results lacked a turn key; output content is not retained by this mapper. |
| Codex logs | `codex.skill_invocation`, `codex.user_prompt`, `codex.conversation_starts` | Skill name, scope/type and `turn.id`; exported prompts and conversation identity; session start. |
| Codex traces | Joinable spans only | A span must carry `turn_id`, `turn.id`, or `call_id`, plus trace ID, span ID and name. Stored fields are those IDs, parent span ID, runtime, conversation ID, turn/call keys, start/end times and receive time. Other attributes and keyless spans are dropped. |

Logs enter through `POST /ingest/otlp/v1/logs`; traces through `POST /ingest/otlp/v1/traces` (OTLP/HTTP JSON).
Both acknowledge with 202 before storage. The Codex pack configures both exporters and disables metrics.
The Claude pack configures logs, prompt/tool details and capture hooks, not a trace exporter or enhanced
telemetry beta. Claude traces from the verification experiment are not a pack requirement.

`codex.api_request` is deliberately ignored: the captured records have neither a session nor a timestamp
identity for attribution. Hook lifecycle, tool-decision and connection noise is also ignored; unknown log
event names are counted rather than stored. gisool MCP searches, `SKILL.md` loads and supporting-file reads
are separate observations, not tool-result guesses.

## Pane and turn joins

The tree is workspace > tab > pane > session > turn > skill span > tool/model calls. A pane can contain
successive sessions. Sync subscribes globally to herdr topology events and opens a separate
`pane.agent_status_changed` stream with the required `pane_id` for each live pane from snapshots or
pane-creation reconciliation. Closing a pane or removing it from its workspace closes that stream
(herdr subscriptions are socket-scoped). Reconnection restores subscriptions from a fresh snapshot.

Reported identity wins: a usable herdr `agent_session` ID matches a session's runtime session ID or
conversation ID. These links retain their `herdr:` source. Without usable identity, any agent, including
OmO, can be inferred from an exact nonempty cwd match and a session start within the pane's lifetime.
Agent/runtime matches take precedence over shell panes, including when a matching pane is occupied:
concurrent work does not fall back to the shell. Multiple equally eligible panes remain unlinked rather
than being guessed from recency. A detected mismatching runtime causes abstention when none matches;
only a unique unknown-runtime pane without conflicting agent evidence can be inferred as a fallback.
Reported links reserve their panes and sessions before inference.
Each inferred session gets only one pane. A newer explicit SessionStart in the same unambiguous pane ends
the earlier session's reservation at the successor's start; ambiguous same-cwd panes are not resolved this way.
Inferred links are labelled `inferred:cwd_time`, not reported.

Still-open panes qualify for discovery regardless of age. Unchanged linked history is retained on later
passes; new/unlinked sessions, touched active sessions and changed same-cwd topology are reconsidered.
An old open pane's entire completed session history is not deleted and recreated on every reconcile.

The Claude pack installs both SessionStart and SessionEnd hooks using the same `hook-post.mjs` command.
A SessionEnd becomes a `session_end` event and sets `sessions.ended_at` to its event timestamp. A herdr
`pane.exited`, pane status reporting `agent:null`, or a snapshot showing a previously detected agent removed also ends
linked open sessions. Historical links survive these end signals, but no longer reserve the pane forever.
An idle or `done` interactive agent is not a process exit.

### Registered execution scope

Registered flows use the inclusive event window `[registeredMs, endedMs]`; an open flow has no end bound.
The list's membership, detail tree, finding, usage and step comparison all use that window, including panes
explicitly mapped to steps on another tab. Unmapped panes in the registered workspace/tab remain visible as
unplanned work. A linked session belongs when it starts or has events in the window; an unmatched reported
identity belongs only when first seen within it. Implicit `ws:` workspace reports retain full pane history.

A session continuing across executions appears in each execution with only that execution's events.
`executionScope.overlaps` labels `startedBefore` and `continuesAfter` per session. Original turn identity is
preserved even when a turn crosses registration; turn/span durations and session bounds are clipped to the
execution. Activations, searches, calls, later-missed skills and correction prompts outside the window do not
contribute. A skill activated only before registration is not credited as an activation in the new run.
Ending A and running B on the same pane does not add B's sessions, turns, skills or costs to A.

Turn/event `basis` explains membership:

| Basis | Meaning |
| --- | --- |
| `reported` | An explicit turn key, such as Claude `prompt.id` or Codex `turn.id`; Codex `codex.turn_input` spans supply reported turn boundaries. |
| `span_join` | A tool call joins a span with one unambiguous turn key through `call_id` or exact trace/span context. |
| `inferred_time` | A keyless event falls into the latest preceding turn; unmatched prompts create synthetic turns. |

Nearby hook and telemetry prompt observations are paired within five seconds to avoid duplicate turns.
Events without a usable boundary stay in `unassignedEvents`. Conversation ID or trace ID alone is not
proof of turn membership.

A load or native activation opens a skill span until the turn ends. Skills accumulate within the turn and
reset at the next turn. Calls are attributed as `reported` when a model call names its skill, `single` when
one skill is active, `co_active` when several are active, or `no_skill`. Co-active calls can appear in more
than one skill span; these are observations of shared activity, not exclusive causation or additive billing.

## Orchestrator protocol

Use the daemon port from `~/.gisool/config.json` (default 8799) and the bearer token from `~/.gisool/token`.
With `GISOOL_HOME`, use that directory instead. The following examples use `jq` to construct JSON.
Use actual workspace, tab and pane IDs returned by herdr, not their display positions.

```sh
GISOOL_HOME="${GISOOL_HOME:-$HOME/.gisool}"
PORT=$(jq -r '.port // 8799' "$GISOOL_HOME/config.json")
BASE="http://127.0.0.1:${PORT:-8799}"
TOKEN=$(cat "$GISOOL_HOME/token")
```

1. Before opening panes, register a spec with `POST /api/workflows`:

   ```sh
   curl -fsS -X POST "$BASE/api/workflows" \
     -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
     --data '{"name":"task-workflow","steps":[
       {"id":"build","skills":["programming","debugging"],"together":true,
        "expectTools":["Edit","Bash"],"doneWhen":"Implementation verified"}
     ]}'
   ```

   Names and step IDs are slugs of at most 64 characters: start with a letter or digit, then use letters,
   digits, `.`, `_` or `-`. A spec has 1-50 unique steps, each with a required `skills` array of up to 10
   names (128 characters each). `together` defaults to false: any intended skill satisfies the step;
   true expects all of them. `expectTools` defaults to `[]`; `doneWhen` is optional, at most 500 characters,
   and is descriptive, not an executable completion check. Unknown fields are rejected.

   Equivalent parsed specs return 200 with the same version and `created:false`; changed specs return
   201 with a new version and `created:true`. The response includes `id`, `name`, `version`, `digest`
   and `createdMs`. `GET /api/workflows` lists latest specs; `GET /api/workflows/:name/versions` lists
   a named spec's versions, newest first (404 if unknown).

2. Start the flow with `POST /api/flows` before dispatching work:

   ```sh
   RESPONSE=$(curl -sS -X POST "$BASE/api/flows" \
     -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
     --data "$(jq -n --arg workspaceId "$HERDR_WORKSPACE_ID" --arg tabId "$HERDR_TAB_ID" \
       '{workspaceId:$workspaceId,tabId:$tabId,spec:{name:"task-workflow"},label:"Task run"}')")
   printf '%s\n' "$RESPONSE"
   ```

   A 201 response contains `id`, workspace/tab IDs, label, the resolved spec and `registeredMs`.
   `spec.version` is optional; omitting it selects the latest version. `tabId` and `label` are optional;
   provide the tab ID for tab-scoped orchestration. An unknown spec/version returns 404.

   There is one open flow per workspace/tab pair, including the pair with no tab ID. A second start
   returns 409 with `error:"flow_already_open"` and the existing `flowId` until that flow ends.
   Reconcile that ID with the task ledger before reusing it; do not treat an arbitrary error as a flow ID.
   Keep the successful flow ID as `FLOW_ID` in the ledger.

3. Right after each `herdr pane split`, take the new pane ID from herdr and map it before assigning work
   with `POST /api/flows/:id/steps`. Map reused panes too:

   ```sh
   curl -fsS -X POST "$BASE/api/flows/$FLOW_ID/steps" \
     -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
     --data "$(jq -n --arg paneId "$PANE_ID" '{paneId:$paneId,stepId:"build"}')"
   ```

   The body is exactly `{paneId,stepId}`. A new mapping returns 201; repeating it returns 200 with
   `created:false`. An unknown step returns 400 `unknown_step`; an unknown flow returns 404.
   Tell the agent its intended skills and whether they are together or alternatives, as guidance only.

4. After accounting for the assignments, end the flow with `POST /api/flows/:id/end`:

   ```sh
   curl -fsS -X POST "$BASE/api/flows/$FLOW_ID/end" \
     -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' --data '{}'
   ```

   This returns `id`, `endedMs` and `alreadyEnded`. Repeating it preserves the end time and returns
   `alreadyEnded:true`. A new flow can then start on that tab. End deliberately interrupted runs too;
   do not close unrelated flows.

If tracing is unavailable, continue useful orchestration and record the gap. gisool registration is
observation, not permission to run tools or enforcement of the declared skills.

## Read reports

All these routes require the same bearer token. Reports are computed on read and include `generatedAt`.
Unknown measurements are `null`, not zero.

| Route | Result / bounds |
| --- | --- |
| `GET /api/flows` | Registered flows, herdr workspaces without a registered flow, and the `outside` group (`kind:"outside_herdr"`, label `outside herdr`), newest first. `limit` is 1-100 (default 20); use the returned `nextCursor` for paging. Optional `from`/`to` filter ordering time. |
| `GET /api/flows/:id` | Tree, per-session finding/usage, skill aggregates, spec comparison and excluded sessions. An unregistered workspace is addressed as `ws:<workspaceId>` and has no comparison. Unknown IDs return 404. |
| `GET /api/flows/outside` | Sessions without a pane link (no `pane_sessions` row or only `source:"unlinked"` rows), newest activity first, in `tree.sessions`, with finding and usage, no spec/comparison and no invented panes. Accepts `from`, `to`, `limit` (1-100, default 100), and `automated`. |
| `GET /api/sessions/:id/skill-report` | One session's tree, finding, usage and automation state, even outside herdr. Unknown or excluded sessions return 404. |
| `GET /api/skills/usage` | Per-skill totals over `[from,to)` in epoch milliseconds. Defaults to the last seven days, maximum 366 days. `detail` is 0-100 (default 20) and limits only session details; `sessionCount` and `truncated` describe that list, while skill totals cover all eligible sessions. |

Automated sessions are excluded by default. Pass `automated=include` or `automated=only`; flow comparisons
exclude the same hidden sessions. Invalid limits, ranges and automation filters return 400.

The outside group contains at most 100 eligible sessions, classified before the cap. Its counts and
`sessionIds` describe that bounded population, not a whole-history total. Activity is the latest session
start, end or event timestamp; `[from,to)` selects that activity. With no range, outside sessions use the
last seven days. The group is omitted when no eligible session exists,
and is ordered and cursor-paged alongside flows/workspaces by its newest eligible activity and stable ID
`outside`. Pass the same range and automation filter to its detail report to read the same population.

The existing `GET /api/flow` is the task-to-skill-to-outcome Sankey aggregate (`first_load` or `all_loads`),
not a registered execution. The plural `/api/flows` API is the herdr workflow tree and report surface.
Other existing routes remain separate: `GET /api/sessions`, `GET /api/sessions/:id/trace`, `GET /api/heatmap`,
`GET /api/skill-week`, `GET /api/stats`, `GET /api/skills`, `POST /api/eval-cases`, and `GET /api/events/stream`.
Capture hooks use `POST /ingest/hook/:runtime`; daemon health is `GET /healthz`.

### Finding signals

Per-turn findings include searches, queries, candidates, abstention reasons, `usedSkills` and their
`rankInSearch`, `nativeWithoutSearch`, and `missedLater` (a skill used in a later turn of the same session
that this turn's searches did not surface). A load is ranked against the latest preceding search.
Identical `SKILL.md` digests collapse to one rank; same-named variants are not automatically the same skill.
A native name takes a rank only when it identifies one collapsed candidate group.

Labels, in precedence order:

| Label | Meaning |
| --- | --- |
| `found_top1` | A used skill ranked first. |
| `found_lower` | A used skill had a lower known rank, with no top-one use. |
| `native_without_search` | A native activation preceded any search in the turn, with no ranked use taking precedence. |
| `loaded_outside_results` | A skill was used without a matching preceding result, and no stronger label applies. |
| `searched_none_used` | Searches occurred but no skill use was observed. |
| `no_search` | Neither search nor skill use was observed. |

Abstention and native-use flags remain visible even when another label wins. These labels describe
discovery evidence, not task correctness. Their turn membership relies on the reported/joined/inferred bases above.

### Usage signals

Each span reports `followThrough` (non-gisool tool calls after activation; zero means no action),
`skillToolCalls` (gisool MCP calls, counted separately), `toolFailures` (including failed gisool calls),
`supportingReads`, `durationMs` (activation to turn end), `llmCalls`, tokens, cost and attribution counts/share.
Supporting reads are `reported` for gisool file reads or `heuristic` for native-skill tool argument paths.
Calling a file path a supporting read does not establish that the agent followed its instructions.

Token buckets retain `inputIncludesCache`: Claude input excludes cached tokens; Codex input includes them.
Fields are `inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheCreationTokens`, `cacheWriteTokens`,
`reasoningTokens` and `totalTokens`. Each sums only calls reporting that field; `unknownCalls` counts the
missing measurements. A field no call reports stays null. `totalTokens` is reported, not derived.
`costUsd` is null if there are no model calls or any contributing call lacks cost; `costUnknownCalls`
counts those missing costs. Codex cost is not estimated.

`nextPromptCorrection` is explicitly a word-list heuristic on the next prompt in a later turn of the same
session: `correction`, `no_correction`, or `unknown` with `no_next_prompt` / `text_not_captured`.
It is not a quality verdict. Co-active attribution is shared and must not be read as exclusive skill credit.

### Spec comparison

| Status | Meaning |
| --- | --- |
| `matched` | All intended skills for `together:true`, otherwise at least one; an empty intention with no observed skill also matches. |
| `partial` | Some, but not all, intended skills appeared in a together step. |
| `different` | Skills appeared, but none were intended (including a step intending no skill). |
| `no_skill_used` | Panes were mapped, but no skill use was observed despite intended skills. |
| `not_run` | No pane was mapped to the step; this does not prove that no work happened elsewhere. |

Comparison also reports `extraSkills`, `missingSkills`, `unexpectedTools` and unplanned panes.
`expectTools:[]` leaves unexpected tools empty. Extra skills do not invalidate a match.
`together` compares the skills observed across a step's mapped panes; it does not require simultaneous activation.
Differences are feedback data, never a gate on agent actions.

## Privacy

Data stays in the local store; ingest and API requests use the local bearer token. `captureLevel` applies
to tool arguments as content, just as it does to prompt/search text:

- `full`: keep text as sent.
- `redacted`: mask recognized secret patterns and truncate to 2048 characters; this is not a guarantee that
  every secret is removed.
- `metadata`: retain only the original text's SHA-256 digest and length, not its text.

Missing prompt text makes the correction heuristic unknown, and missing tool arguments removes argument-path
evidence for supporting reads. Trace storage keeps only the join whitelist described above, not arbitrary span
attributes or exported content. Capture levels are content controls, not anonymization of session IDs or paths.
