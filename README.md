<p align="center"><a href="README.md">English</a> · <a href="README.ko.md">한국어</a></p>

# gisool

gisool is a local skill router. One daemon on `127.0.0.1` serves the `SKILL.md` folders already on your machine to your coding agents over MCP. It records which skills each session searched, loaded, and read, and shows that in a local dashboard. Nothing leaves the machine.

The name comes from 기술, Korean for "skill", "craft", or "technique".

## Start in 30 seconds

Requires Node.js 24.15 or newer on macOS or Linux.

```sh
npm --prefix local ci && npm --prefix local run build && npm link ./local
gisool init --dry-run    # preview every config change; writes nothing
gisool init              # connect detected runtimes and install the background service
gisool open              # open the dashboard
```

`gisool init` installs a LaunchAgent (macOS) or systemd user unit (Linux) that keeps the daemon running on port `8799`. Use `gisool init --no-service` and `gisool serve` to run it in the foreground instead.

## Supported runtimes

| Runtime | `--runtime` id |
| --- | --- |
| Claude Code | `claude-code` |
| Codex | `codex` |
| Gemini CLI | `gemini` |
| Cursor | `cursor` |
| OmO | `omo` |
| Gajae Code | `gajae` |
| OpenClaw | `openclaw` |

`gisool init` detects which are installed. Connect only some with `gisool init --runtime codex,claude-code`. Each runtime gets an MCP entry, OpenTelemetry log export to the daemon, and capture hooks.

MCP connections require protocol revision 2026-07-28 and a host resource reader. Clients that use the legacy `initialize` handshake cannot connect. Details: [local/README.md](local/README.md).

## What is recorded, and where

- Prompts, skill searches (query and ranked candidates), skill loads, and supporting-file reads, per agent session.
- Skills a runtime used natively, without gisool, when its hooks or telemetry report it.

Everything is stored in SQLite under `~/.gisool/` (`GISOOL_HOME` moves it). The daemon listens on `127.0.0.1` only, every request needs the local bearer token, and nothing is sent to a remote service. Skill folders are indexed in place; gisool never copies or edits them.

Set `captureLevel` in `~/.gisool/config.json` to `full` (default), `redacted` (secrets masked, text cut to 2048 characters), or `metadata` (no text, only digest and length). `retentionDays` deletes old sessions.

| Path | Purpose |
| --- | --- |
| `~/.gisool/config.json` | settings: port, capture level, retention, skill roots |
| `~/.gisool/token` | bearer token (0600) |
| `~/.gisool/gisool.db` | skills index, sessions, events, loads |
| `~/.gisool/logs/daemon.log` | daemon log |
| `~/.gisool/backups/` | per-run config backups for rollback |

## Dashboard

```sh
gisool open              # opens the browser
gisool open --print      # prints the URL only
```

Sessions, a per-session trace with search candidates, a task -> skill -> outcome flow, and a weekday-by-hour heatmap.

## Check, undo, move

```sh
gisool doctor                                  # service, daemon, token, FTS5, roots, index, hooks, backups
gisool doctor --json
gisool init --rollback                         # undo the newest init run
gisool init --rollback --all                   # undo every run
gisool export ~/gisool-backup                  # settings only
gisool export ~/gisool-backup --with-history   # also sessions and events
gisool import ~/gisool-backup --dry-run        # preview; import never overwrites existing keys
gisool eval                                    # measure search quality
```

Full CLI, settings, and protocol notes: [local/README.md](local/README.md). Architecture: [docs/gisool.md](docs/gisool.md).

## Remote registry (optional)

This repo also contains gisul, an authenticated remote registry for team distribution. Use it only when skills must be shared across machines; gisool does not need it. `gisool init --disable-remote` turns off a remote gisul registration in connected runtimes.

- `server/`: a Node.js MCP server that exposes skill directories over stdio or Streamable HTTP (default `http://127.0.0.1:8788/mcp`).
- `worker/`: an authenticated Cloudflare Worker that serves immutable releases from a private R2 bucket.

```text
Git main -> GitHub Actions validation/evaluation -> immutable R2 release
                                                       ^
Codex plugin / MCP client -> authenticated Worker -------+
```

| Runtime | Client | Connection |
| --- | --- | --- |
| Codex | [ARKPOINT plugin](docs/arkpoint-plugin.md) | Native HTTPS + OAuth |
| oh-my-openagent / OmO 5 (`omo-ai`) | [Installer and loader](clients/oh-my-openagent/README.md) | OAuth stdio bridge, discovery extension |
| Gajae Code (`gjc`) | [Installer and workflow integration](clients/gajae-code/README.md) | OAuth stdio bridge |
| OpenClaw | [Bundle and loader](clients/openclaw/README.md) | OAuth stdio bridge, bootstrap discovery hook |

Both servers implement the [SEP-2640 Skills Extension](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2640). The Worker uses `SKILLS_BUCKET`, `GISUL_BEARER_TOKEN` for readers, and a separate `GISUL_PUBLISH_TOKEN` for publication. No real secrets are in this repository; `server/ops/` holds templates.

- Deployment, release format, rollback, production gates: [docs/deployment.md](docs/deployment.md)
- Codex plugin: [clients/codex/README.md](clients/codex/README.md)
- Session handoff context: [docs/SESSION_CONTEXT.md](docs/SESSION_CONTEXT.md)

The remote registry is a personal prototype. Production acceptance needs a successful GitHub Actions publication, installed-plugin reads, and matching release evidence.

## License

[MIT](LICENSE)
