# Gisul for OpenClaw

Install the [OpenClaw bundle and follow its login instructions](plugin/README.md).
The bundle contains a small skill loader, an in-memory discovery hook and a
read-only OAuth MCP bridge. Team workflow skills remain on Gisul.

From the repository root, for the default profile:

```sh
node clients/openclaw/prepare-oauth.mjs --output /absolute/new/gisul-team --endpoint https://your-host.example/mcp
openclaw plugins install /absolute/new/gisul-team
node "$HOME/.openclaw/extensions/gisul-openclaw/scripts/bridge.mjs" --login
```

Use the same profile for installation, login and the Gateway. No existing user
configuration changes merely by checking out this client.

For any OAuth deployment, prepare a full bundle with its endpoint:

```sh
node clients/openclaw/prepare-oauth.mjs --output /absolute/new/gisul-other --endpoint https://other-host.example/mcp
openclaw plugins install /absolute/new/gisul-other
node "$HOME/.openclaw/extensions/gisul-openclaw/scripts/bridge.mjs" --login
```

The selected endpoint is kept in the installed bundle's `gisul-client.json`, so
login and MCP startup use the same server. The output directory must be new.
When migrating an existing installation, privately back up its configuration and
bundle, verify the OAuth connection first, then remove only the independently
registered `mcp.servers.gisul` entry so it cannot override the bundle connection.
Keep other servers and the previous files for rollback. Refresh the Gateway and
verify a new session after the switch.

If the host already has a working `mcp.servers.gisul` registration, preserve it
and prepare a loader-only bundle instead of adding the default OAuth bridge:

```sh
node clients/openclaw/prepare-existing.mjs --output /absolute/new/gisul-existing
openclaw plugins install /absolute/new/gisul-existing
openclaw mcp probe gisul --json
```

The output directory must be new and its parent must exist. This variant has no
`.mcp.json` or bridge script. Existing endpoint, credentials, event logging and
tool policy remain owned by the host's MCP registration. Its adapter must expose
the three Gisul read tools. Use a fresh agent session for live search/load/file
verification; the bundle-only live script below targets the default OAuth mode.

Check the existing adapter's schemas as well as its tool names. Older adapters
can expose all three names while lacking `search_skills.mode`,
`load_skill.commit` and `read_skill_file.load_id`. In that case, build the
current adapter with `npm --prefix server ci` and
`npm --prefix server run build:codex-plugin`. Stage
`clients/codex/plugin/gisul/runtime/codex.mjs` in a versioned host directory and
test it against the existing endpoint before changing only the adapter argument
in `mcp.servers.gisul.args`. Preserve the host's command, other arguments, cwd,
environment, credential file and tool filter. Keep a private config backup and
the previous adapter for rollback; the loader preparation step does not perform
this migration. Refresh the Gateway using the host's normal graceful restart
procedure and verify a fresh session. Do not claim pinned reads from tool names
alone.

Verification:

```sh
node --test server/test/openclaw-client.test.mjs
node scripts/check-openclaw-client.mjs --openclaw-root /path/to/installed/openclaw
```

On 2026-10-01 both passed against OpenClaw `2026.7.1-2` (`0790d9f`). The native
smoke creates and removes an isolated OpenClaw home/state/config, installs a
copied bundle, checks the model-visible skill and plugin hook, resolves the MCP
script through OpenClaw's own loader, and dispatches a real `agent:bootstrap`
hook without modifying the workspace file. Unit tests also cover credential
profile selection, repeat injection, no-write dry runs, protocol-clean stdout
and propagation of child failure status.

Live verification on 2026-10-01 also completed OAuth sign-in and an actual local
OpenClaw agent turn: search → pinned skill load → supporting-file read, with
three tool calls and no tool errors. That profile uses the Codex harness, so a
separate native MCP test loaded **only the installed OpenClaw bundle** in an
empty workspace to exclude inherited Codex connections. It exposed exactly the
three read tools and verified both returned bodies against their SHA-256 digests.
The observed release was `20261001.19` at commit
`054052e608b6ea35eea59480917121a8ee30f3e0`.

After installing and signing in, reproduce the bundle-only live test:

```sh
node scripts/check-openclaw-live.mjs \
  --openclaw-root /path/to/installed/openclaw \
  --plugin-root "$HOME/.openclaw/extensions/gisul-openclaw"
```

Use your actual profile path. This makes read-only network calls and prints
metadata/digests, never credentials or remote workflow bodies. It uses the
already installed bundle and its OAuth cache; it does not sign in, rewrite
OpenClaw configuration, restart a Gateway, or send channel messages.

Sanitized evidence: [native bundle calls](../../docs/evidence/openclaw-20261001/native-mcp.json)
and [agent tool calls](../../docs/evidence/openclaw-20261001/agent-calls.json).
The agent reported an unrelated unresolved Slack secret during message-tool
catalog discovery; no Slack action was requested and all three Gisul calls
succeeded. General model compliance on future tasks is not established by one
explicit smoke. Existing Gateway sessions were not restarted or validated.

Mac mini verification on the same day used OpenClaw `2026.9.3` and the
existing-MCP variant. The plugin was installed at
`/Users/iyen/.openclaw/extensions/gisul-openclaw`. Its existing personal Worker,
token file, event logging, command, cwd and tool filter were preserved. The old
adapter exposed the three tool names but lacked discovery mode, commit inputs
and `load_id`; only its executable argument was replaced with the adapter built
from source commit `37357fecbfddab8236a688c2e5273c7bf37b0654`.

The adapter and installation source are retained permanently under
`/Users/iyen/.local/share/dev-tools/openclaw-gisul-loader/37357fecbfddab8236a688c2e5273c7bf37b0654/`.
The Gateway was gracefully restarted with its service definition preserved.
Its skill catalog shows Gisul as model-visible, its discovery hook is loadable,
and RPC health passed. An isolated native MCP check and a fresh Gateway agent
session both completed discovery → commit-pinned load → `load_id`-bound file
read against release `20260929.38`. No remote service was deployed and no
channel messages were delivered. Evidence:
[installation](../../docs/evidence/openclaw-20261001/macmini-install.json),
[native calls](../../docs/evidence/openclaw-20261001/macmini-native.json),
[agent receipt and events](../../docs/evidence/openclaw-20261001/macmini-agent.json).

Compatibility scripts use private exports only in their test adapters; the
plugin has no dependency on OpenClaw's internal module paths. Run the checks
after an OpenClaw upgrade; format changes may require updating the adapters.

Later on 2026-10-01, the Mac mini was migrated to the full OAuth bundle targeting
`https://gisul.iyendev.com/mcp`, after IYEN's own OAuth server was deployed.
The installed client source is `b5eddedfa03e94dde8791e01934f5d8014ca6564`;
the deployed server source is `3af736e8161152504fd339f496b474eb47ba258c`.
GitHub login, OAuth cache reuse from a new process, installed-bundle-only native
calls and a fresh Gateway agent session all passed. Only the superseded
standalone Gisul MCP entry changed in the user config. Other settings were
verified equal, and the previous config/bundle remain privately backed up.
The agent receipt includes all three successful Gisul calls and no channel
delivery was requested. See [OAuth migration evidence](../../docs/evidence/openclaw-20261001/macmini-oauth.json).

When logging in over SSH, keep stdin open until the login client lists tools
and exits; forward its reported loopback callback port to the browser machine.
Verify a fresh MCP connection after login. A detached command that exits before
listing tools is insufficient evidence of saved authentication.
