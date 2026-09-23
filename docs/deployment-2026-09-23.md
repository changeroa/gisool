# ARKPOINT deployment — 2026-09-23

## Live deployment

- Canonical origin: https://gisul.arkpoint.dev ; MCP: `/mcp`.
- Cloudflare account: `987134a918e5f8587af6f5251c4b6d2e` (`dev@arkpoint.kr`).
- Worker: `gisul-arkpoint`; custom domain configured, workers.dev disabled.
- Deployed source: `33c1c449359feb70f00c7d3e9ff1f2490ca94a8e`.
- Worker version: `cb489694-bca6-447b-aebb-f8d4d9fd73b5`.
- OAuth KV: `bf2df094ed1647b9a8a73cdf75bd91b1`; R2: `gisul-arkpoint-releases`.
- Runtime/plugin: https://github.com/Ark-Point/gisul (private), plugin `0.3.1`.
- Content: https://github.com/Ark-Point/gisul-skills (private), release `20260923.4`, commit `db4826479707c8abd1a09b817bc79b12b9fee424`.
- Content publication: https://github.com/Ark-Point/gisul-skills/actions/runs/35837776286 — passed; actual member OAuth update and published bytes verified.
- Canonical runtime working path: `/Users/victor/projects/gisul`; content: `/Users/victor/projects/arkpoint-gisul-skills`.

This deployment used the local Cloudflare OAuth login. It used no Mac mini, SSH, tunnel, or origin server. The initial Worker deployment was not a GitHub Actions deployment. The content release was published by GitHub Actions.

## Verification

- Server tests: 48 passed; Worker tests: 52 passed, including real OAuth-provider integration in workerd with a mocked GitHub upstream.
- TypeScript checks, plugin and loader validation passed.
- Runtime GitHub Actions passed: https://github.com/Ark-Point/gisul/actions/runs/35833377119 .
- Installed marketplace from `Ark-Point/gisul` in a clean Codex home: plugin `0.3.1`, native `streamable_http`, `https://gisul.arkpoint.dev/mcp`, no local command or embedded bearer credential.
- Live `/healthz` returned the deployed source commit. OAuth discovery advertised the custom domain; anonymous MCP requests returned 401.
- Live native search, load and pinned supporting-file read passed using the separate read-only CI identity against release `20260923.2`. This is not evidence of a real member OAuth login.
- GitHub OAuth app homepage and callback saved as `https://gisul.arkpoint.dev` and `/callback`.

## Initial read-only activation (superseded by editing deployment below)

GitHub OAuth client secret was provisioned into Worker secrets. Actual Codex plugin login succeeded using the official Codex client metadata document and S256 PKCE, with GitHub member `changeroa` and Ark-Point organization access. Requested write scope was correctly downscoped to `skills:read`. Native search, load and pinned supporting-file reads passed with that OAuth access token against release `20260923.2`, not the CI credential.

Real browser verification exposed two consent-navigation failures: `no-referrer` suppressed the form request Origin, and a self-only `form-action` blocked the GitHub redirect. The deployed fix uses `strict-origin` and limits form destinations to self, GitHub, and the validated client callback origin. Both first authorization and a subsequent login with an existing GitHub grant completed successfully. Final runtime CI passed; anonymous access remains denied.

## Remaining operations

1. Create a scoped Cloudflare deployment API token and set `CLOUDFLARE_API_TOKEN` in the runtime repository’s `arkpoint-production` environment. Public deployment variables are configured. Then set repository variable `GISUL_DEPLOY_ENABLED=true` and run `Deploy ARKPOINT Worker`. This is future Worker deployment automation; it does not block current member logins or content publication.
2. Existing read-only connections need one reconnect to approve editing. New read/edit grants preserve scope through refresh. There is no writer-ID registry or user-supplied token.
3. The Mac mini's installed client and any existing personal services have not been changed. Use the same team plugin there after actual login verification, then remove its duplicate old connection.

Machine publication/read credentials exist in Worker secrets and content Actions secrets. A local recovery copy is mode 0600 under `~/.config/gisul-arkpoint/`; no values are stored here. Personal skill content and the existing personal plugin were not changed.

## Persistent editing consent — initial implementation history

The user confirmed that the single grant surface is the initial GitHub connection approval. Commit `98e43911b52f751dab1fefb132f6fe5cf4be6cec` removes the separate editor registry, preserves approved write scope on refresh, keeps explicit read-only consent read-only, and sends actual writes with the member’s GitHub App user token. There is no recurring repository-role synchronization. GitHub still enforces actual repository access on writes, and revoked authentication and organization membership remain checked. The team publication workflow is `publish.yml`.

Verification: 55 Worker tests passed, TypeScript checks passed, LSP reported no diagnostics, and [runtime CI passed](https://github.com/Ark-Point/gisul/actions/runs/35835756802). The approved-write test performs a write after refresh; GitHub write rejection and explicit read-only consent are covered. These use a mocked GitHub upstream. Actual member editing and publication have **not** yet been verified. Runtime deployment automation remains skipped until its Cloudflare credential is configured.

The org-owned GitHub App [ARKPOINT Gisul](https://github.com/organizations/Ark-Point/settings/apps/arkpoint-gisul) was created with App ID `5043564` and client ID `Iv23li8MwNc6ZMMAJVnS`. Intended access is Contents write, Actions read, Metadata read, and organization Members read, installed only on `Ark-Point/gisul-skills`. Credentials and a bootstrap private key are retained with mode 0600 under `~/.config/gisul-arkpoint/`; the Worker uses user tokens, not that private key.

Installation is blocked: GitHub’s own Install navigation reaches `https://github.com/apps/arkpoint-gisul-registry/installations/new/permissions?target_id=235220714&target_type=Organization`, which returns 404. App IDs were freshly confirmed in settings. JWT-authenticated `GET /app` and `GET /app/installations` also returned 404 `Integration not found`, using either the App ID or client ID as issuer. The root cause is unconfirmed. No installation ID exists; no new app credential or source was deployed. The existing OAuth app and live read-only service remain in place.

The initial plan to wait for GitHub App installation was superseded by the deployment below. No temporary worktree is retained.

## Editing deployment completed

The user explicitly requested deployment despite the GitHub App installation blocker. The deployed runtime uses the existing organization-owned OAuth App (`Ov23liXVEPk25CPgvJJH`) with `GITHUB_AUTH_MODE=oauth`. GitHub App mode remains supported but is not enabled. The installation error was not resolved by renaming or re-saving the unused GitHub App; its temporary public visibility was restored to private, and its final slug is `arkpoint-gisul`. It has no installation and no runtime role.

GitHub OAuth editing consent requests `read:org repo`. This GitHub scope covers public and private repositories; the Worker fixes its actual write target to `Ark-Point/gisul-skills`, uses each member’s token, and retains organization checks and explicit read-only restrictions. No separate editor registry, recurring repository-role synchronization, user-supplied PAT, or shared writer credential was introduced. The broader OAuth consent was disclosed before deployment.

Deployed source `33c1c449359feb70f00c7d3e9ff1f2490ca94a8e`, Worker version `cb489694-bca6-447b-aebb-f8d4d9fd73b5`; canonical source remains `/Users/victor/projects/gisul`. All 56 Worker tests, TypeScript and LSP checks passed. [Runtime CI passed](https://github.com/Ark-Point/gisul/actions/runs/35837421820). Live health matched the source commit; discovery and anonymous rejection checks passed.

An isolated Codex client completed actual GitHub OAuth with `changeroa`; Ark-Point organization access was allowed. It received `skills:read skills:write` and all six native tools. Refresh retained both scopes. Using the renewed credential, `update_skill` accepted a real onboarding-skill update as commit `db4826479707c8abd1a09b817bc79b12b9fee424`. `get_skill_write_status` returned `published`, release `20260923.4`; a fresh `load_skill` returned the exact submitted Markdown and digest `sha256:ae4e98f264d958b17af858a06aa3481ac8c25c47074216ed1270a4231135daf4`. The original `load_id` still read its supporting file from release `20260923.3`. [Content publication CI passed](https://github.com/Ark-Point/gisul-skills/actions/runs/35837776286). The content checkout was fast-forwarded to the deployed content commit, with no outstanding edit.

A second Codex sign-in completed without another GitHub permission approval, retained both scopes, and exposed the editing tools. Test OAuth credentials were logged out, the isolated Codex home and task-owned browser tab were removed. Existing personal client configuration was preserved.
