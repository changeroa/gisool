# ARKPOINT deployment — 2026-09-23

## Live deployment

- Canonical origin: https://gisul.arkpoint.dev ; MCP: `/mcp`.
- Cloudflare account: `987134a918e5f8587af6f5251c4b6d2e` (`dev@arkpoint.kr`).
- Worker: `gisul-arkpoint`; custom domain configured, workers.dev disabled.
- Deployed source: `4c7cdb57a61a99c87c6ad5b5f5b0d539628da19d`.
- Worker version: `5e35146e-d1dc-4b28-9c4d-d957ad289dd8`.
- OAuth KV: `bf2df094ed1647b9a8a73cdf75bd91b1`; R2: `gisul-arkpoint-releases`.
- Runtime/plugin: https://github.com/Ark-Point/gisul (private), plugin `0.3.1`.
- Content: https://github.com/Ark-Point/gisul-skills (private), release `20260923.2`, commit `cd59fda439f20ee4b9f23253bab7f24bbbbaaa4c`.
- Content publication: https://github.com/Ark-Point/gisul-skills/actions/runs/35831504792 — passed, including staged and live verified MCP reads.
- Canonical runtime working path: `/Users/victor/projects/gisul`; content: `/Users/victor/projects/arkpoint-gisul-skills`.

This deployment used the local Cloudflare OAuth login. It used no Mac mini, SSH, tunnel, or origin server. The initial Worker deployment was not a GitHub Actions deployment. The content release was published by GitHub Actions.

## Verification

- Server tests: 48 passed; Worker tests: 52 passed, including real OAuth-provider integration in workerd with a mocked GitHub upstream.
- TypeScript checks, plugin and loader validation passed.
- Runtime GitHub Actions passed: https://github.com/Ark-Point/gisul/actions/runs/35831485228 .
- Installed marketplace from `Ark-Point/gisul` in a clean Codex home: plugin `0.3.1`, native `streamable_http`, `https://gisul.arkpoint.dev/mcp`, no local command or embedded bearer credential.
- Live `/healthz` returned the deployed source commit. OAuth discovery advertised the custom domain; anonymous MCP requests returned 401.
- Live native search, load and pinned supporting-file read passed using the separate read-only CI identity against release `20260923.2`. This is not evidence of a real member OAuth login.
- GitHub OAuth app homepage and callback saved as `https://gisul.arkpoint.dev` and `/callback`.

## Remaining activation work

1. GitHub OAuth application `3876557` (`Ov23liXVEPk25CPgvJJH`) requires GitHub Confirm access before generating its client secret. Complete reauthentication at https://github.com/organizations/Ark-Point/settings/applications/3876557 ; provision `GITHUB_CLIENT_SECRET` directly into Worker secrets. Do not paste secrets into chat or commit them. Until then login intentionally returns setup-required 503.
2. Create a scoped Cloudflare deployment API token and set `CLOUDFLARE_API_TOKEN` in the runtime repository's `arkpoint-production` environment. Public deployment variables are already configured. Then set repository variable `GISUL_DEPLOY_ENABLED=true` and run `Deploy ARKPOINT Worker`. The job is currently skipped, not a successful automated deployment.
3. Complete an actual member OAuth login and native search/load/read before announcing team availability.
4. Editing is disabled until a content-repository credential and explicit `GISUL_WRITER_IDS` are configured. Members default to read access.
5. The Mac mini's installed client and any existing personal services have not been changed. Use the same team plugin there after actual login verification, then remove its duplicate old connection.

Machine publication/read credentials exist in Worker secrets and content Actions secrets. A local recovery copy is mode 0600 under `~/.config/gisul-arkpoint/`; no values are stored here. Personal skill content and the existing personal plugin were not changed.
