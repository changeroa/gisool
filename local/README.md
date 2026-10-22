# gisool

gisool is a local skill router. One daemon on `127.0.0.1` indexes the `SKILL.md` folders already on your machine,
serves them over MCP through `search_skills` and standard `resources/read`, records which skills
each agent session searched, loaded, and read, and shows that history in a local dashboard.

Capture packs cover Claude Code, Codex, Gemini CLI, Cursor, OmO, Gajae Code, and OpenClaw.
MCP connections accept revision 2026-07-28 and, for older clients, the legacy `initialize` handshake
(revisions 2024-11-05 through 2025-11-25, e.g. clients built on `@modelcontextprotocol/sdk` 1.x). Reading skill
bodies needs a host resource reader. Packs configure endpoints and capture hooks only.

## Skills over MCP

The server implements stable SEP-2640: `server/discover` advertises `tools`, `resources`, and
`extensions["io.modelcontextprotocol/skills"]`. `search_skills` is the only tool. Use it to choose a candidate,
then read the returned `SKILL.md` URI through the host's resource reader on this server. Relative references
resolve against the skill root (the directory containing `SKILL.md`); supporting files are read only as needed.
`skills/list` and `skills/get` provide verbatim frontmatter and complete per-file SHA-256/size manifests.
The optional directory-read feature is not advertised; directories can be inferred from the manifest.

Every request, including `server/discover`, carries `params._meta` with
`io.modelcontextprotocol/protocolVersion: "2026-07-28"` and
`io.modelcontextprotocol/clientCapabilities: {}`. Include `io.modelcontextprotocol/clientInfo`
with `{name, version}` for runtime attribution. HTTP additionally requires `MCP-Protocol-Version`,
`Mcp-Method`, and (for tool calls and resource reads) `Mcp-Name`, matching the body.
Use `Accept: application/json, text/event-stream` and the bearer token.
Modern requests need no initialization handshake or protocol session; GET and DELETE on `/mcp` return 405.
The stdio proxy forwards modern requests unchanged.

### Legacy clients (before 2026-07-28)

The server is dual-era. A request without modern `_meta` and without a modern `MCP-Protocol-Version` header
is served under legacy semantics: `initialize` negotiates the requested revision (or answers `2025-11-25`
for unknown ones) with the same capabilities and instructions as `server/discover`. Over HTTP it returns an
`Mcp-Session-Id` whose only state is `clientInfo` for runtime attribution; unknown session IDs (e.g. after a
daemon restart) are served anonymously instead of rejected. Over stdio the proxy keeps `clientInfo` for the
process. Legacy results omit `resultType`, `ttlMs`, `cacheScope`, and the `serverInfo` `_meta`; legacy HTTP
errors are JSON-RPC errors with status 200. `ping` and an empty `resources/templates/list` are answered.
The deprecated HTTP+SSE transport (GET stream) is not offered, so 2024-11-05 clients connect over stdio.

All cacheable results include `resultType: "complete"`, `ttlMs: 60000`, and `cacheScope: "private"`.
List methods use opaque `cursor`/`nextCursor` pagination. The search tool uses its own `offset`/`limit`.
Tool schemas use JSON Schema 2020-12. Search is limited to 120 invocations per minute per daemon.

The catalog rejects invalid Agent Skills names/frontmatter and skills above 512 files or 16 MiB.
Manifests include dotfiles, dependencies, and nested skills. Skills containing symlinks or other non-regular
entries are rejected rather than served incompletely. Duplicate names are retained at distinct URIs so
hosts can disambiguate their configured roots.

A `resources/read` of a published `SKILL.md` is recorded as a dashboard `load` observation; other files
produce `read_file` observations. These do **not** activate skills, confer approval, or grant execution permissions.
Hosts own origin binding, integrity verification, consent, and activation. To join reads to a search, send
its `trace_id` as `_meta["app.gisool/traceId"]`; ordinary vendor session metadata also preserves attribution.
No prior read or connection is required. A changed file fails closed until the catalog refreshes; the host
refreshes `skills/get` and verifies against the new manifest before use.

For Codex builds with gated modern support, enable `features.mcp_2026_07_28` for third-party HTTP servers;
the separate hosted Apps flag does not apply to gisool. Client-wide experimental flags are not edited by the pack.

**Privacy: everything stays on this machine.** The daemon listens on `127.0.0.1` only, every MCP, ingest, and API
request needs the local bearer token, and nothing is sent to any remote service. Prompts, search queries, and skill
usage are stored in a SQLite database under `~/.gisool/`.

## Install

Requires Node.js 24.15 or newer on macOS or Linux.

```sh
npm --prefix local ci && npm --prefix local run build && npm link ./local
```

This puts the `gisool` command on your `PATH`.

## Connect your agents

Preview what would change, without writing anything:

```sh
gisool init --dry-run
```

The dry run prints a diff for every runtime config gisool would touch (MCP registration, OpenTelemetry export to the
daemon, capture hooks) and the service it would install. Then apply it:

```sh
gisool init                          # every detected runtime
gisool init --runtime codex,claude-code
gisool init --no-service             # do not install the LaunchAgent / systemd user unit
```

Every run backs up the files it changes under `~/.gisool/backups/`. Undo with:

```sh
gisool init --rollback               # newest run
gisool init --rollback --all         # every run
```

## Run

`gisool init` installs a LaunchAgent (macOS) or systemd user unit (Linux) that keeps the daemon running. To run it in
the foreground instead:

```sh
gisool serve                         # default port 8799
gisool serve --port 8800
```

Open the dashboard (sessions, per-session trace, flow, and weekday-by-hour heatmap):

```sh
gisool open                          # opens the browser
gisool open --print                  # prints the URL only
```

Check the installation:

```sh
gisool doctor                        # service, daemon, token mode, FTS5, roots, index freshness, hooks, backups
gisool doctor --json
```

Measure search quality against recorded or hand-written cases:

```sh
gisool eval
gisool eval --cases cases.json --json
```

## Skill tracing

herdr is required for skill tracing; `gisool doctor` checks its socket connection. gisool joins agent sessions
to panes and compares observed skill use with registered workflows without restricting agents.
See [Skill tracing](docs/skill-tracing.md) for capture details, attribution limits, and the orchestrator protocol.

## Export and import

Move your gisool setup (skill roots, config, eval cases, aliases) to another machine:

```sh
gisool export ~/gisool-backup                  # settings only
gisool export ~/gisool-backup --with-history   # also sessions, events, and loads
gisool import ~/gisool-backup --dry-run        # preview what would be added
gisool import ~/gisool-backup                  # merge; existing keys are kept
```

Import never overwrites existing settings. Run `gisool init` afterwards to connect the runtimes on the new machine.

### Repair historical load attribution

After an upgrade or history import, explicitly reconcile pending loads against evidence already in the database:

```sh
gisool repair-loads --from 1800000000000 --to 1800000000100 --limit 100 --json
gisool repair-loads --from 1800000000000 --to 1800000000100 --limit 100 --after <next-event-id> --json
```

`--from` and `--to` are required epoch milliseconds, selecting `[from,to)`. Each invocation examines at most
`--limit` pending loads (default 100, maximum 1000), ordered by timestamp and local recording order.
Optional `--session <id>...` restricts the candidate sessions; it does not force attribution to them.
The JSON result contains `examined`, `repaired`, `pending` within this batch, and `next`. Continue with
`--after` while `next` is non-null, keeping the same range and session scope. Cursors also advance past
ambiguous loads; they are event IDs for this database, not portable recording-order guarantees.

Only uniquely supported evidence repairs a load. Missing captured text and multiple candidates remain pending;
retained URI proof survives retention, and later contradictory evidence can still retract an attribution.
Re-running the command is safe. It does not ingest new events, change capture settings, or make GET reports write.

## Settings

`~/.gisool/config.json` (created on first run, mode 0600; `GISOOL_HOME` moves the whole directory):

```json
{
  "port": 8799,
  "captureLevel": "full",
  "retentionDays": null,
  "roots": [{ "id": "agents", "path": "~/.agents/skills" }],
  "runtimes": {}
}
```

- `captureLevel` controls how prompt and search text is stored:
  - `full` (default): the text as sent.
  - `redacted`: secrets (tokens, keys, passwords) are masked and the text is cut to 2048 characters.
  - `metadata`: no text at all, only its SHA-256 digest and length. The dashboard shows "prompt not captured".
- `retentionDays`: `null` keeps history forever; a number deletes sessions older than that many days at startup and
  once a day.
- `roots`: skill folders to index in place. Defaults cover `~/.agents/skills`, `~/.claude/skills`, `~/.codex/skills`,
  `~/.gemini/skills`, `~/.omo/agent/skills`, `~/.gjc/agent/skills`, `~/.openclaw/skills`, and `~/gisul/skills`.
  gisool never copies or edits skill files.

Restart the daemon after editing the config.

## Files

| Path | Purpose |
| --- | --- |
| `~/.gisool/config.json` | settings above |
| `~/.gisool/token` | bearer token (0600) shared with the runtime configs |
| `~/.gisool/gisool.db` | SQLite store: skills index, sessions, events, loads |
| `~/.gisool/logs/daemon.log` | daemon log, rotated at 5 MB |
| `~/.gisool/backups/` | per-run backups used by `gisool init --rollback` |

## Develop

```sh
npm --prefix local run build
npm --prefix local run typecheck
npm --prefix local test              # unit tests plus test/e2e, which spawns the real daemon in a sandbox HOME
node local/bench/search.mjs --check
node local/bench/mcp-mutations.mjs  # each regression is injected in memory; files stay unchanged
```

Architecture: [docs/gisool.md](../docs/gisool.md).
