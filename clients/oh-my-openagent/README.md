# Gisul for oh-my-openagent (OmO 5)

This client targets the standalone `omo` command (`omo-ai`), backed by Senpi. It registers a native stdio MCP server backed by the pinned `mcp-remote@0.14.3` OAuth bridge. The older OpenCode edition has a different configuration contract and is not the target of this installer.

## Install and connect

With Node 24+ and OmO installed, run from this checkout:

```sh
node clients/oh-my-openagent/install.mjs --dry-run
node clients/oh-my-openagent/install.mjs
node clients/oh-my-openagent/login.mjs
omo
```

The login command opens OAuth for your Ark-Point GitHub account. Finish it before launching OmO; `/mcp status` reports the connection. Then ask:

> Gisul에서 이 작업에 맞는 스킬을 찾아 적용해줘.

The grant requests `skills:read`. Credentials remain in this profile's private `gisul/auth` directory. These clients discover and consume skills; the existing Codex plugin remains available for editing the remote catalog.

The bridge is intentional: live testing of Senpi `2026.9.27-4` showed its native HTTP authorizer requesting all server-advertised scopes despite `oauth.scopes: ["skills:read"]`. The bridge sends the requested read scope in the actual authorization URL. Use this client's login command, not `/mcp auth`, for this stdio registration.

The default destination is `~/.omo/agent`. Both installer and login accept `--agent-dir PATH`; otherwise they follow `OMO_CODING_AGENT_DIR`, `SENPI_CODING_AGENT_DIR`, then `PI_CODING_AGENT_DIR`. Launch OmO with the same profile, for example `OMO_CODING_AGENT_DIR=/absolute/profile omo`. Existing Senpi-based OmO users can pass `--agent-dir ~/.senpi/agent` to both commands and launch their usual `senpi`/`pi` command. An installer override does not change your shell's runtime profile.

## Installed files and behavior

| File below the agent directory | Purpose |
| --- | --- |
| `mcp.json` → `mcpServers.gisul` | Native stdio registration of the OAuth bridge to `https://gisul.arkpoint.dev/mcp`, with read scope |
| `extensions/gisul/index.js`, `discovery.md` | Append discovery guidance to the current turn prompt through `before_agent_start` |
| `skills/gisul/SKILL.md` | Small loader explaining selection, pinned reads, errors, and task handoff |

The extension makes discovery guidance available before work begins and preserves the prompt assembled by OmO and other extensions. Search does not activate every result: relevance and `invocation: explicit` are checked independently. An empty search gets one shorter retry, retaining its commit. Remote content stays on Gisul.

Workers receive only relevant pinned references and adopted constraints in their assignment. Gisul skill names are remote identities, so they must not be passed as if they were installed local `task(load_skills)` entries.

OmO 5's current engine no longer discovers `APPEND_SYSTEM.md` automatically; the installer uses its extension API instead. Do not put this registration in `omo.jsonc`, which configures OmO orchestration rather than the engine's MCP catalog.

## Existing configuration and removal

Dry runs write nothing. The installer preserves other MCP registrations/settings, creates a private backup before merging an existing config, and does not print its existing contents. Identical installation is a no-op. Conflicting Gisul files or registrations cause an error before any files are changed. Review and preserve a customized loader before replacing it; there is no blind force option.

To remove this integration, remove only `mcpServers.gisul` from this profile's `mcp.json` and the installed `skills/gisul` and `extensions/gisul` files listed above. Remove `gisul/auth` only if you also intend to discard its sign-in. Keep any other files you placed in those directories. Restart the session after installation/removal. Project MCP overrides and runtime options disabling extensions/skills still apply.

Compatibility evidence and reproducible checks: [runtime client verification](../../docs/runtime-clients-2026-09-29.md).
