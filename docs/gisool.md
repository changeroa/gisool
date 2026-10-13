# gisool architecture

gisool (`local/`) is the on-machine counterpart of gisul. gisul serves team skills from immutable remote releases;
gisool serves the skill folders already on one machine and records how agents use them. Install and usage:
[local/README.md](../local/README.md).

```text
 Claude Code / Codex / Gemini / Cursor / OmO / Gajae / OpenClaw
   |  MCP (Streamable HTTP or `gisool mcp-stdio`)   |  OTLP/HTTP JSON logs   |  hook POSTs
   v                                                v                        v
 +------------------------------ gisool daemon (127.0.0.1) ------------------------------+
 |  api/security (Host/Origin guard, bearer token)                                       |
 |  mcp/ ---- search/ ---- catalog/ (skill roots, in place)                              |
 |    \           ingest/ (normalize -> capture level -> attribute)                      |
 |     \--------------> store/ (SQLite: skills, sessions, events, loads) <--- api/routes  |
 |                                                       dashboard (static) + SSE        |
 +---------------------------------------------------------------------------------------+
```

## Modules

All paths are under `local/src/` unless noted. Shared types live in `types.ts`.

| Module | Responsibility |
| --- | --- |
| `config.ts` | `~/.gisool` (or `GISOOL_HOME`), `config.json`, and the 0600 bearer token. |
| `catalog/` | Scans the configured roots in place, parses SKILL.md frontmatter, digests every file into a manifest, watches for changes, and reports duplicates and families. Skill URIs are `skill://local/<rootId>/<dir>/<file>`. |
| `search/` | Lexical scoring plus SQLite FTS5 trigram recall, fused into ranked candidates; abstains with a reason (`empty_query`, `no_overlap`, `below_threshold`, `explicit_only`). Quality gate: `local/bench/search.mjs --check`. |
| `mcp/` | The three MCP tools and the server instructions; `stdio-proxy.ts` bridges stdio-only runtimes to the daemon. |
| `ingest/` | Turns MCP calls, OTLP log records, and runtime hook payloads into canonical events, applies the capture level, attributes each event to a session, and appends it. |
| `store/` | SQLite schema, writes, dashboard queries (sessions, trace, flow, heatmap, skill-week, stats), export/import, retention. |
| `api/` | HTTP routes, localhost security, SSE hub, dashboard static files. |
| `server.ts` | Composition root: wires catalog, search, store, ingest, MCP, and routes; handles shutdown and retention. |
| `packs/` | One pack per runtime: detect it, plan config edits (MCP entry, OTel export, hooks), and doctor checks. Pack assets live in `local/packs/`. |
| `cli/` | `serve`, `open`, `init` (plan, diff, backup, apply, rollback), `doctor`, `service`, `mcp-stdio`, `export`/`import`, `eval`. |
| `local/dashboard/` | Preact single-page dashboard: sessions list, trace with search candidates, flow Sankey, heatmaps. |

## HTTP surface

The daemon binds `127.0.0.1` only. Every request must carry `Host: 127.0.0.1:<port>` or `localhost:<port>`; a
present `Origin` must match it and `Sec-Fetch-Site: cross-site` is refused. `/mcp` and `/ingest/*` require
`Authorization: Bearer <token>`; `/api/*` also accepts the dashboard cookie set by `gisool open`. Mutations must be
`application/json`.

| Route | Purpose |
| --- | --- |
| `POST /mcp`, `GET /mcp`, `DELETE /mcp` | MCP Streamable HTTP |
| `POST /ingest/otlp/v1/logs` | OTLP/HTTP JSON logs (protobuf gets 415 with a hint to switch to `http/json`) |
| `POST /ingest/hook/:runtime` | raw hook stdin JSON or forwarder payloads |
| `GET /api/sessions?<Filter>` | session rows |
| `GET /api/sessions/:id/trace` | ordered trace steps for one session |
| `GET /api/flow?<Filter>&unit=&top=` | task type -> skill -> adoption state Sankey (`top` default 7, max 15) |
| `GET /api/heatmap?<Filter>&tz=&weekStart=&bucket=` | weekday x hour session counts (bucket 1, 2, or 4 hours) |
| `GET /api/skill-week?<Filter>` | skill x ISO week counts |
| `GET /api/stats` | attribution and abstain rates, unused skills, ingest counters |
| `GET /api/skills` | catalog entries |
| `POST /api/eval-cases` | save a query (and expected skill) for `gisool eval` |
| `GET /api/events/stream` | SSE: `event: session` with the updated session row |
| `GET /healthz` | `{ ok, version }`, no auth |
| `GET /`, `/assets/*` | dashboard |

Filter parameters: `from`, `to` (epoch ms), `runtime`, `skill`, `state` (comma lists), `dow` (0 = Sunday), `hour`,
`hourSpan`, `q` (text search over prompts and queries).

Ingest routes answer 202 immediately and process the body on the next microtask, so a slow store never blocks an
agent. A bad payload is counted as rejected or dropped in `/api/stats` and never surfaces as an agent error.

## Event model

Every input becomes a canonical event: `{ id, ts, kind, source, ref, traceId?, loadId?, skillUri?, text?, textDigest?, textLength?, data }`.

| Kind | Produced by |
| --- | --- |
| `session_start`, `session_end` | runtime hooks and OTel conversation starts |
| `prompt` | Claude `user_prompt` OTel, Codex/Gemini/Cursor/OmO/Gajae/OpenClaw prompt hooks |
| `search` | `search_skills`; carries the query, mode, ranked candidates with scores, abstain reason, and `traceId` |
| `load` | `load_skill`; carries `uri`, `loadId`, `manifestDigest` |
| `read_file` | `read_skill_file`; carries the file uri and bytes |
| `native_skill` | the runtime used a skill without gisool: `via: "tool"` (Skill tool), `"otel"` (Claude `skill_activated`, Codex `codex.skill_invocation`), `"file_read"` (a Read or shell command touching `.../skills/<name>/SKILL.md`), `"expansion"` (slash-command expansion) |
| `error` | a failed MCP tool call, with a stable code |

`source` is `mcp`, `otel`, or `hook`. `ref` identifies the session: `{ runtime, runtimeSessionId?, conversationId?, clientName?, cwd? }`.
The runtime of an MCP call comes from the client name (`claude-code`, `codex-mcp-client`, `gemini-cli-mcp-client`,
`senpi-mcp-client`, `gjc-coding-agent`, `cursor*`, `*openclaw*`).

Capture level is applied before anything is stored: `full` keeps text, `redacted` masks secrets and truncates to
2048 characters, `metadata` keeps only `textDigest` (SHA-256) and `textLength`. Search queries follow the same rule.

`load_skill` returns a `load_id` derived from the skill uri and its manifest digest and persists the manifest, so
`read_skill_file` with that `load_id` keeps working across daemon restarts and refuses files that changed since the
load (`skill_changed_since_load`).

## Attribution rules

Sessions are keyed by `(runtime, runtimeSessionId ?? conversationId)`. Each event is attributed by the first rule
that applies:

1. `runtime_id`: hook and OTel events that carry the runtime's own session or conversation id.
2. `vendor_meta`: MCP calls whose `_meta` carries a vendor session id (Codex `_meta.threadId` maps to
   `conversationId`), or whose Claude `tool_use_id` was already bound to a session by a PostToolUse hook. When the
   hook arrives after the MCP call, the earlier event is re-attributed.
3. `trace_handle`: `load` and `read_file` events joined to an attributed search through `trace_id`, or to an
   attributed load through `load_id`.
4. `window`: exactly one open session of the same runtime active in the last 120 seconds. Never across runtimes.
5. Otherwise `unattributed` with a reason: `no_session`, `ambiguous` (more than one candidate), or `stale`.

A session row reports the method of its earliest attributed event.

## Adoption states

Each session gets one state, by precedence:

| State | Meaning |
| --- | --- |
| `loaded` | at least one `load_skill` |
| `exposed_only` | a search returned candidates but nothing was loaded |
| `no_match` | searches abstained |
| `aborted` | an error followed the first search |
| `not_used` | no gisool search in the session |

The flow view groups sessions as task type (from the loaded or top-ranked skill and the first prompt) -> skill ->
state; `unit=first_load` counts each session once, `unit=all_loads` counts every loaded skill.

## Testing

`npm --prefix local test` runs the unit tests and `local/test/e2e/daemon.test.mjs`, which spawns `gisool serve` in
a throwaway HOME, drives MCP, OTLP, and hook ingest end to end, restarts the daemon, checks the `metadata` capture
level and the 401 path, and asserts that the real runtime configs in the user's home are byte-identical before and
after. CI runs the same commands in `.github/workflows/runtime.yml`.
