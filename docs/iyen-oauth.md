# IYEN Gisul OAuth

The IYEN Worker can serve read-only MCP clients through GitHub OAuth at
`https://gisul.iyendev.com/mcp`. OAuth is enabled only when `GISUL_PUBLIC_URL`
is set. The ordinary Wrangler config retains the existing token-only behavior.

OAuth uses Cloudflare's pinned provider, S256 PKCE, explicit browser consent,
cookie-bound expiring login state, single-use authorization flow, short-lived
access tokens and refresh tokens. Only `skills:read` is accepted. GitHub login
requests no organization or repository scope. `GISUL_GITHUB_USER_IDS` is a
comma-separated allowlist of stable numeric GitHub IDs; account access is
checked at login, MCP requests and refresh. The initial deployment permits
`changeroa` (`65930387`). Changing a username does not transfer access.


## Compatibility

Existing reader/writer bearer credentials retain their original MCP behavior
on both the custom domain and workers.dev route. Publication still requires its
separate publisher token. OAuth grants cannot write skills or publish releases.
Native search/load/read tools are enabled for authenticated OAuth connections;
they preserve immutable commit and load identity across release changes.

## Configuration and deployment

`worker/wrangler.oauth.jsonc` explicitly targets account
`8277c1acc712e4a9d00479255015c200`, Worker `gisul-mcp`, the existing
`gisul-skills-releases` bucket and dedicated `gisul-iyen-oauth` KV namespace.
The personal GitHub OAuth app is
[IYEN Gisul](https://github.com/settings/applications/3896163), with homepage
`https://gisul.iyendev.com` and callback `https://gisul.iyendev.com/callback`.
Provision `GITHUB_CLIENT_SECRET` as a Worker secret through stdin or a private
file. Never commit it or print the secret/config contents during verification.

Build and test from a clean, committed checkout:

```sh
npm --prefix server ci
npm --prefix worker ci
npm --prefix server run build
npm --prefix server test
npm --prefix worker run typecheck
npm --prefix worker test
cd worker
npx wrangler deploy --config wrangler.oauth.jsonc --dry-run
```

Push the verified commit and check its PR/CI before deployment. Deploy that
exact source using `--config wrangler.oauth.jsonc` and
`--var GISUL_SERVER_VERSION:<commit>`. Keep the old deployment version and
machine connection until the new OAuth client completes a live search, pinned
load and supporting read. A health response or metadata endpoint alone does
not verify login or tool calls.

The OpenClaw loader in [PR #8](https://github.com/changeroa/gisul/pull/8)
supports preparing a full OAuth bundle with this endpoint. Authenticate the
OpenClaw profile, then remove only the superseded standalone Gisul MCP entry,
refresh the Gateway and test a fresh agent session. Other servers and settings
remain unchanged.

## Verification state

Local server tests: 49 passed. Worker tests: 59 passed, including 14 OAuth
integration tests and the existing reader/writer/publication compatibility
tests. Type checking, search benchmark and OAuth deployment dry run passed.
Production OAuth was deployed on 2026-10-01 from source
`3af736e8161152504fd339f496b474eb47ba258c`, after its PR CI passed.
Cloudflare version: `5d67e2f4-1173-412f-9fdb-1df356aefbd0`.
The canonical deployed checkout is retained on the Mac mini at
`/Users/iyen/dev-tools/gisul-iyen-oauth/releases/3af736e8161152504fd339f496b474eb47ba258c`.
The previous version, `baef02cb-a827-4cf3-98d4-cdc79dac9a92`, is recorded for rollback.

Live health and OAuth metadata checks passed, and the pre-existing bearer
connection still exposed its three read tools. GitHub browser login completed.
An independently started native OpenClaw MCP runtime then reused the OAuth
cache and completed discovery, commit-pinned load and load-bound supporting
read, verifying both SHA-256 digests without using the legacy bearer token.

Mac mini OpenClaw `2026.9.3` now uses the full bundle built from client source
`b5eddedfa03e94dde8791e01934f5d8014ca6564`, installed at
`/Users/iyen/.openclaw/extensions/gisul-openclaw`, targeting the IYEN endpoint.
Only the standalone `mcp.servers.gisul` registration was removed; a semantic
comparison verified that all other configuration was preserved. The original
configuration and bundle remain in the private `pre-oauth-backup` directory
under `/Users/iyen/.local/share/dev-tools/openclaw-gisul-oauth/b5eddedfa03e94dde8791e01934f5d8014ca6564`.

After a graceful Gateway restart, its health check, an installed-bundle-only
native test and a fresh agent session all passed. The agent's terminal receipt
records successful search/load/read calls against IYEN release `20260929.38`,
commit `cb56c1ade59bd999e8ae859bd19d0b030ab8c03c`. No channel delivery was requested.
Sanitized evidence is in PR #8's
`docs/evidence/openclaw-20261001/macmini-oauth.json`. This verifies a requested
smoke workflow, not automatic skill-selection compliance on every future task.

For headless SSH login, keep stdin open (for example, use an interactive SSH
terminal) until the client lists tools and exits successfully, and forward its
reported callback port to the browser machine. An exit code alone does not
prove authentication: verify token persistence and a new MCP process. The
first detached login in this deployment ended before those checks; retrying
with stdin held open completed login and the independent checks above.
