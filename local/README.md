# gisool

gisool is a local skill router. One daemon on `127.0.0.1` indexes the `SKILL.md` folders already on your machine,
serves them to your coding agents over MCP (`search_skills`, `load_skill`, `read_skill_file`), records which skills
each agent session searched, loaded, and read, and shows that history in a local dashboard.

Supported runtimes: Claude Code, Codex, Gemini CLI, Cursor, OmO, Gajae Code, and OpenClaw.

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
gisool init --disable-remote         # also turn off a remote gisul registration
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

## Export and import

Move your gisool setup (skill roots, config, eval cases, aliases) to another machine:

```sh
gisool export ~/gisool-backup                  # settings only
gisool export ~/gisool-backup --with-history   # also sessions, events, and loads
gisool import ~/gisool-backup --dry-run        # preview what would be added
gisool import ~/gisool-backup                  # merge; existing keys are kept
```

Import never overwrites existing settings. Run `gisool init` afterwards to connect the runtimes on the new machine.

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
```

Architecture: [docs/gisool.md](../docs/gisool.md).
