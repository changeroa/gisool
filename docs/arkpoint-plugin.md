# ARKPOINT Gisul

## Install

Use a current Codex desktop app or CLI with plugin support. A shared OpenAI team workspace is not required for this Git-backed marketplace. Private repository access and Gisul server authorization are separate.

```sh
codex plugin marketplace add Ark-Point/gisul
codex plugin add gisul@arkpoint
```

Connect Gisul from the plugin's connection UI and sign in with the GitHub account that belongs to `Ark-Point`. If the client does not open login during installation:

```sh
codex mcp login gisul --scopes skills:read,skills:write
```

Start a new conversation and ask:

> Gisul에서 이 작업에 맞는 스킬을 찾아 적용해줘.

The plugin contains a small loader and a native HTTPS MCP configuration. No Node installation, checkout, SSH configuration, token file, or Mac mini server is needed on a client. Mac mini clients use exactly the same installation. Skills remain remote.

If another Gisul plugin or standalone MCP server is already enabled, resolve the duplicate before enabling this one. Keep the existing connection until team login and reads have been verified. This task does not stop or uninstall an existing server on another machine.

Update the marketplace with `codex plugin marketplace upgrade arkpoint`, install the new plugin version, and start a new conversation. Content publication does not require a plugin upgrade; new searches and loads see the active content release.

## Architecture and identity

```text
Codex plugin ── HTTPS + individual OAuth ── Worker ── private R2 releases
                  browser login              │
                  GitHub / Ark-Point         └── OAuth KV (encrypted grant props)

GitHub Actions ── Cloudflare API ── Worker deployment
Skill-content main ── GitHub Actions ── verified immutable R2 publication
```

`worker/src/team.ts` is the team entrypoint. `worker/src/index.ts` and the existing personal deployment retain their previous authentication behavior. The team entrypoint never depends on either the personal origin server or SSH.

The first login registers a provider grant for the user's immutable GitHub ID. Active `Ark-Point` membership is checked on login, token refresh, and every authenticated MCP request. Removing GitHub organization access, revoking the GitHub grant, or adding the ID to `GISUL_BLOCKED_IDS` denies subsequent requests. Prior content already received by a client cannot be recalled.

Members can read. `GISUL_WRITER_IDS` is an explicit comma-separated list of immutable GitHub user IDs permitted to edit; a scoped content-repository credential must also be configured. A member requesting write scope does not receive write access. Refresh cannot elevate a previously read-only grant; sign in again after an administrator grants editing rights.

The OAuth provider issues Gisul tokens, validates their audience and PKCE, and stores encrypted upstream-token properties. Codex manages its own OAuth credentials. OAuth access tokens expire after 15 minutes, refresh grants after 30 days. `GISUL_CI_TOKEN` is a separate read-only machine credential used only by content CI to verify staged releases. No credential is distributed in the plugin.

## Provision and deploy (no Mac mini)

Canonical endpoint: `https://gisul.arkpoint.dev/mcp`.

The runtime repository is `Ark-Point/gisul`; content is independently configured by `GISUL_SKILLS_REPOSITORY`, initially `Ark-Point/gisul-skills`. The personal catalog is not automatically exposed to the organization. The team bucket must receive a verified initial release before content reads work.

1. In the intended Cloudflare account, create private R2 bucket `gisul-arkpoint-releases` and one Workers KV namespace for OAuth.
2. Register an organization-owned GitHub OAuth application with callback `https://gisul.arkpoint.dev/callback`. Configure its organization access policy. The login requests `read:org`, not repository access.
3. Configure the `arkpoint-production` GitHub environment:
   - Variables: `CLOUDFLARE_ACCOUNT_ID`, `GISUL_OAUTH_KV_ID`, `GITHUB_CLIENT_ID`.
   - Optional variables: `GISUL_WRITER_IDS`, `GISUL_BLOCKED_IDS`.
   - Secret: `CLOUDFLARE_API_TOKEN`, scoped to the account and required Worker deployment resources.
4. Provision Worker secrets outside the repository: `GITHUB_CLIENT_SECRET`, distinct `GISUL_PUBLISH_TOKEN` and `GISUL_CI_TOKEN`, and `GISUL_GITHUB_TOKEN` only when enabling edits. The content credential should be limited to the fixed content repository (Contents write, Actions read).
5. Set repository variable `GISUL_DEPLOY_ENABLED=true` after its Cloudflare API token is configured, then run `Deploy ARKPOINT Worker`. It builds and tests, generates only nonsecret config, deploys through GitHub Actions, then verifies source identity and OAuth discovery. It never runs SSH.
6. Connect the content repository's gated publication workflow to the new origin. Set its publication secret and use the CI reader token for staged/live read verification. Preserve main ancestry, latest-main, inventory integrity, immutable bytes, conditional promotion and sequence fencing. Keep model evaluations and human ratings optional.
7. Complete an actual member login and search/load/read before announcing availability. A build or `/healthz` alone is not this acceptance check.

If the endpoint changes, update the plugin URL, Worker public URL, GitHub callback URL, smoke check and provider metadata together. Do not use a preview URL as the permanent endpoint.

## Connection states checked

| State | User action / expected behavior |
| --- | --- |
| Not connected | Codex starts OAuth; the server does not serve skills to an anonymous request. |
| Login not configured | Explain that the administrator must finish setup; no success claim or retry loop. |
| Consent pending | Show client name, callback destination, organization and requested actions. |
| Canceled or expired | Keep the plugin installed; restart login from Codex. |
| Organization access unavailable | Accept the org invitation or allow the app's organization access. |
| GitHub outage/rate limitation | Report verification failure; do not mislabel it as an empty catalog or membership denial. |
| Connected, no search matches | Return a normal empty search; change the query. |
| Connected, no published release | Report publication unavailable; administrator publishes the initial catalog. |
| Reader attempts a write | Server rejects it, independent of client UI. |
| New release after load | Supporting reads retain the original `load_id` release. |
| Membership removed or account blocked | Deny subsequent server requests, including existing tokens. |

The native `load_id` is a stateless release/manifest identity, not an authorization credential or evidence of an earlier tool invocation. Authorization is enforced on every request. R2 reads verify bytes against the immutable inventory. There is no client-side Node verifier in the native plugin.

## Verification and deployment evidence

Local acceptance includes a clean Codex-home marketplace installation, native `streamable_http` configuration, Worker OAuth integration tests, staged-version read tests, plugin validation, TypeScript checks and dry-run Worker compilation. Record real deployment commit, Cloudflare version, content release, login/read evidence and canonical paths in a dated deployment record when production activation is complete.
