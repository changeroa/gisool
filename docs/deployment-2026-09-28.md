# ARKPOINT registration metadata deployment — 2026-09-28

## Implemented behavior

Native search and load expose only four registration fields: created_by, created_at, updated_by, updated_at. GitHub account logins and team Git history determine the values. Supporting-file edits update the edit information; publication-only changes leave it unchanged. Skill bodies stay unchanged. Prior pinned releases without metadata return null.

- Runtime PR: https://github.com/Ark-Point/gisul/pull/1
- Content PR: https://github.com/Ark-Point/gisul-skills/pull/2
- Decision details: the content repository's docs/registration-metadata.md.

## Deployed sources

- Origin: https://gisul.arkpoint.dev
- Runtime source: c9119529c2b2455247cda683fef1424f72ef18c4
- Cloudflare Worker version: 2f83b483-c540-4c4d-889c-fd3b7c9cd49a
- Content source: dfb9a21a68e8c6cd260e6ec1ffb3163e69246e72
- Content release: 20260928.7
- Canonical runtime workspace: /Users/victor/projects/gisul
- Canonical content workspace: /Users/victor/projects/arkpoint-gisul-skills

Runtime deployment used the existing dev@arkpoint.kr Cloudflare OAuth connection. The invalid inherited API-token environment override was omitted for the deployment command. No new credentials or permissions were provisioned. GitHub Actions deployment remains disabled; content publication continues through its existing gated Actions workflow. No temporary worktree was created.

## Verification

- Runtime CI: 48 server tests, 58 Worker tests, TypeScript checks and deployment compilation passed: https://github.com/Ark-Point/gisul/actions/runs/36361683311
- Content: five registration tests, catalog validation, immutable artifact/integrity checks, staged and live registration comparisons passed: https://github.com/Ark-Point/gisul-skills/actions/runs/36361753716
- Live health matches the deployed runtime commit; OAuth discovery and anonymous denial still pass.
- The connected member's native search and load return changeroa and the original registration/edit timestamps for preserve-decisions.
- A separate read-only CI connection searched and loaded all 39 skills and matched all four fields against freshly derived Git/GitHub history. The executable acceptance check passed against the exact deployed runtime/content commits.
- Publication receipt: content workspace dist/registration-publication-20260928/publication.json (also retained as an Actions artifact).

Previous authentication and provisioning details: [2026-09-23 deployment](deployment-2026-09-23.md).
