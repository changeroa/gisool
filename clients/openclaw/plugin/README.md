# Gisul for OpenClaw

This bundle adds the `gisul` skill, an `agent:bootstrap` discovery hook and a
Gisul MCP connection. It requests only `skills:read`. Selected workflow bodies
and supporting files are read from immutable remote releases; the catalog is
never copied into the plugin or your workspace.

## Install and sign in

Use Node 24+, npm/npx and OpenClaw on macOS or Linux. From the Gisul checkout:

```sh
node clients/openclaw/prepare-oauth.mjs --output /new/gisul-bundle --endpoint https://your-host.example/mcp
openclaw plugins install /new/gisul-bundle
node "$HOME/.openclaw/extensions/gisul-openclaw/scripts/bridge.mjs" --login
```

The login command in the installed bundle downloads the pinned `mcp-remote@0.14.3` package if necessary, opens browser OAuth for a GitHub account allowed by the configured deployment, and lists the remote MCP tools. Complete sign-in before starting the agent. Credentials stay in
`<OpenClaw state directory>/gisul/auth`, outside the replaceable plugin folder.
No credentials are copied from Codex or embedded in the plugin.

The selected endpoint is stored in `gisul-client.json`; login and runtime both use it. `--endpoint` overrides the URL for a single invocation; prefer a prepared bundle for a permanent installation.

For a named profile, keep installation, sign-in and the Gateway together:

```sh
openclaw --profile team plugins install /new/gisul-bundle
node "$HOME/.openclaw-team/extensions/gisul-openclaw/scripts/bridge.mjs" --login
openclaw --profile team plugins inspect gisul-openclaw
```

For `OPENCLAW_STATE_DIR`, use that profile's actual installed script path.
The copied script determines its profile from its installation directory.
The source script also accepts `--state-dir /absolute/profile` for login and
`--dry-run` to show connection arguments without writing files or signing in.
Use a normal copied install; linked installations and Windows have not been
validated. OpenClaw must find both `node` and `npx` in its process PATH.

On the verified OpenClaw `2026.7.1-2` build, restart the relevant Gateway after
installation and begin a new session, when it will not interrupt active work.
Newer builds may apply plugin changes without a restart; follow their native
installation result. Installation is not proof of sign-in or remote tool access.

## Use and inspect

Ask: “Gisul에서 이 작업에 맞는 스킬을 찾아 적용해줘.”

The embedded agent normally sees `gisul__search_skills`, `gisul__load_skill` and
`gisul__read_skill_file`. The loader keeps searches/loads pinned to the returned
commit, checks `invocation: explicit` separately from relevance, and passes the
loaded `load_id` into supporting-file reads. Search results alone do not activate
skills or grant permission to execute their instructions.

```sh
openclaw plugins inspect gisul-openclaw --json
openclaw skills list --json
openclaw hooks list --json
```

The bootstrap hook appends discovery guidance to the in-memory `AGENTS.md`
entry while preserving existing content. It does not edit workspace files or
perform network requests itself. Internal hooks must be enabled by your
OpenClaw configuration for automatic guidance; if disabled, invoke the `gisul`
skill explicitly. Model adherence is not guaranteed.

Existing `plugins.allow`, `hooks.internal`, skill filters and tool policies
continue to apply. If a plugin allowlist is configured, include `gisul-openclaw`
through your normal configuration process while preserving other entries.
The `coding` and `messaging` profiles support bundle MCP tools; a `bundle-mcp`
denial or workspace MCP override can hide them. Diagnose the relevant policy
instead of globally enabling all tools. Other native agent harnesses may expose
different catalogs; this bundle was verified with the embedded bundle loader.

An unavailable tool, a network failure and an empty search are different
outcomes. Retry this profile's login command for sign-in failures. Never paste
credentials into chat or treat network failure as lack of organization
membership. Verify an actual search and pinned load in the session before
relying on discovery.

## Update and remove

Use OpenClaw's plugin manager. Preserve a customized bundle before replacing it;
these instructions do not use `--force`. Inspect the existing installation and
follow your OpenClaw version's supported update commands.

```sh
openclaw plugins uninstall gisul-openclaw
```

Use the same profile/state directory as installation. The OAuth cache is
separate; delete only that profile's `gisul/auth` directory if you also intend
to discard its login. Leave unrelated plugins, settings and workspace files.

This uses OpenClaw's supported Codex-compatible bundle format, not the Codex
runtime. The bridge avoids depending on the host's native HTTP OAuth behavior.
See OpenClaw's [bundle contract](https://docs.openclaw.ai/plugins/bundles),
[internal hooks](https://docs.openclaw.ai/automation/hooks) and
[skills](https://docs.openclaw.ai/tools/skills).
