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

The first login registers a provider grant for the user's immutable GitHub ID. Active `Ark-Point` membership is checked on login, token refresh, and every authenticated MCP request. Removing GitHub organization access or revoking the GitHub grant denies subsequent requests. Prior content already received by a client cannot be recalled.

Approve the GitHub connection once. The requested read/edit consent is stored in the encrypted OAuth grant and preserved on refresh; there is no separate Gisul editor list, personal writer token, or recurring repository-role synchronization. Writes use the connected member’s GitHub access token, so GitHub still enforces repository access and branch protection. A deliberately read-only client grant remains read-only. The deployed OAuth app requests `read:org repo` for editing (`read:org` for explicitly read-only connections). GitHub’s OAuth `repo` consent includes private repositories; the Worker fixes its write target to `Ark-Point/gisul-skills`. A repository-limited GitHub App mode is supported but is not deployed because its installation route currently returns 404. Existing read-only connections need one reconnection for the new editing approval; ordinary renewals do not require repeated permission setup.

The OAuth provider issues Gisul tokens, validates their audience and PKCE, and stores encrypted upstream-token properties. Codex manages its own OAuth credentials. OAuth access tokens expire after 15 minutes, refresh grants after 30 days. `GISUL_CI_TOKEN` is a separate read-only machine credential used only by content CI to verify staged releases. No credential is distributed in the plugin.

## Provision and deploy (no Mac mini)

Canonical endpoint: `https://gisul.arkpoint.dev/mcp`.

The runtime repository is `Ark-Point/gisul`; content is independently configured by `GISUL_SKILLS_REPOSITORY`, initially `Ark-Point/gisul-skills`. The personal catalog is not automatically exposed to the organization. The team bucket must receive a verified initial release before content reads work.

1. In the intended Cloudflare account, create private R2 bucket `gisul-arkpoint-releases` and one Workers KV namespace for OAuth.
2. Use the organization-owned OAuth App with callback `https://gisul.arkpoint.dev/callback`; set `GITHUB_AUTH_MODE=oauth`. Editing requests `read:org repo` during GitHub approval and uses each member’s token, without a separate writer credential. Alternatively, set `GITHUB_AUTH_MODE=app` after a GitHub App with Contents write, Actions read, Metadata read and organization Members read is installed on `Ark-Point/gisul-skills`. That mode does not request OAuth `repo` scope.
3. Configure the `arkpoint-production` GitHub environment:
   - Variables: `CLOUDFLARE_ACCOUNT_ID`, `GISUL_OAUTH_KV_ID`, `GITHUB_CLIENT_ID`.
   - Secret: `CLOUDFLARE_API_TOKEN`, scoped to the account and required Worker deployment resources.
4. Provision Worker secrets outside the repository: `GITHUB_CLIENT_SECRET`, distinct `GISUL_PUBLISH_TOKEN` and `GISUL_CI_TOKEN`. User write credentials come from the GitHub connection and are stored encrypted by the provider; no `GISUL_GITHUB_TOKEN` server secret is needed for the team entrypoint.
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
| Explicit read-only grant attempts a write | Server rejects it, independent of client UI. |
| Approved write after token renewal | Preserve the saved write grant and use the refreshed member token. |
| GitHub rejects a write | Explain repository access or branch protection; never claim saved or published. |
| New release after load | Supporting reads retain the original `load_id` release. |
| Membership removed or GitHub authorization revoked | Deny subsequent server requests, including existing tokens. |

The native `load_id` is a stateless release/manifest identity, not an authorization credential or evidence of an earlier tool invocation. Authorization is enforced on every request. R2 reads verify bytes against the immutable inventory. There is no client-side Node verifier in the native plugin.

## Verification and deployment evidence

Local acceptance includes a clean Codex-home marketplace installation, native `streamable_http` configuration, Worker OAuth integration tests, staged-version read tests, plugin validation, TypeScript checks and dry-run Worker compilation. Record real deployment commit, Cloudflare version, content release, login/read evidence and canonical paths in a dated deployment record when production activation is complete.

Current activation status and exact deployment evidence: [2026-09-23 deployment](deployment-2026-09-23.md).

## Skill registration details

Native search and load results include `created_by` (등록자), `created_at` (등록일), `updated_by` (최근 수정자), and `updated_at` (수정일). Accounts are GitHub logins and dates are UTC ISO 8601. The content publisher derives them from team Git history, including supporting-file edits; skill frontmatter cannot override them. Registration stays fixed on updates and publication-only changes do not change dates. Pinned older releases without this metadata return null. No origin/source field is added.
