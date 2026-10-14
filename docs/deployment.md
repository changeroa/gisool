# Deployment

For a self-hosted team OAuth Worker, see [team plugin setup](team-plugin.md). `worker/src/team.ts` serves native MCP tools and OAuth directly from Cloudflare. The Mac mini instructions below cover the personal deployment.

## Worker and private R2

The Worker in this checkout serves `/mcp` directly from `SKILLS_BUCKET`. It has no origin URL, tunnel, SSH connection, or filesystem dependency. `GISUL_BEARER_TOKEN` authenticates MCP readers; `GISUL_WRITE_TOKEN` authenticates read/write clients and `GISUL_GITHUB_TOKEN` lets the Worker commit only through its fixed skill-content API; `GISUL_PUBLISH_TOKEN` authenticates publication. These secrets are separate from the Cloudflare account credentials used by Wrangler. Keep the bucket's public access disabled.

The production machine endpoint is `https://gisul-mcp.changeroa.workers.dev/mcp`; the publication origin is the same URL without `/mcp`. Its stable workers.dev route is enabled on the existing Worker, with bearer authentication enforced by the Worker. The custom domain `gisul.iyendev.com` also routes to this version, but its zone can return a browser challenge to unattended clients. GitHub Actions and the installed plugin use the stable workers.dev endpoint. Do not depend on a preview alias for ongoing publication or disable security across unrelated zone traffic.

Production activation requires a gated real release published by GitHub Actions, actual installed-plugin reads, and matching Langfuse evidence. Structural migration of unchanged content uses Git-byte and manifest parity; model evaluations and human ratings are optional under the 2026-09-21 user policy. Validation, integrity, latest-main and conditional activation remain required. Local fixture tests do not establish those production results.

### Current protocol and client

The direct Worker supports MCP `2026-07-28` with `server/discover`, per-request protocol/capability metadata, matching HTTP headers, and private 30-second cache hints. HTTP responses remain `no-store`; the bridge owns its credential-isolated memory cache and verifies resource digests even on cache hits. Legacy initialization remains available for existing publishers and clients. Browser origins must match the endpoint origin or an explicit comma-separated `GISUL_ALLOWED_ORIGINS` value.

Install the production client over HTTPS:

```sh
node clients/codex/install.mjs --plugin --http-url https://gisul-mcp.changeroa.workers.dev/mcp --bearer-token-file "$HOME/.config/gisul-worker-dev-tools/mcp-bearer"
```

Reader credentials expose search, load and verified file reads. A write credential additionally exposes create_skill, update_skill and get_skill_write_status. Content changes go through `changeroa/gisul-skills` main and its gated `publish-r2.yml` GitHub Actions workflow on Ubuntu. Neither serving nor publishing requires the Mac mini. The Mac mini is only used as an authenticated Wrangler deployment workstation. Its old Node service is retained separately for rollback and is not in the production request path.

### Release contract

An immutable prefix `releases/<full Git commit>/` contains the builder's `release.json`, skill files, `inventory.json`, and a Worker-generated `complete.json`. Inventory schema version 1 contains `commit`, `release`, verbatim skill entries (`uri`, `frontmatter`, `resources`), `aliases`, and `files`. Each file has a relative `path`, `digest` in `sha256:<hex>` form, byte `size`, and an optional canonical resource `uri`. Resource digests must agree with the skill manifests. `inventory.json` and `complete.json` are reserved and do not appear in `files`.

Upload `inventory.json` first. It fixes the allowed paths and their bytes for that commit. Subsequent uploads must match it. Existing objects accept identical retries and reject replacement bytes. Supporting resources are served only through verified manifests.

| Publication endpoint | Method | Purpose |
| --- | --- | --- |
| `/admin/current` | GET | Read current identity and its ETag |
| `/admin/releases/<commit>` | GET | Read a completed release's identity for rollback |
| `/admin/releases/<commit>/<path>` | PUT | Upload an immutable object |
| `/admin/verify` | POST | Complete verification without switching current; supports staged reads by commit |
| `/admin/promote` | POST | Verify and activate a release |
| `/admin/rollback` | POST | Verify and reactivate a retained release |

Verification, promotion and rollback accept `commit`, `release`, `inventory_digest`, `expected_etag` (null only for the first publication), and a positive integer `sequence`. The inventory digest hashes its exact uploaded bytes. Verification checks the builder's per-skill manifest digests, SKILL.md frontmatter, every stored object's size and digest, and the complete object inventory before creating the completion marker. `/admin/verify` leaves current unchanged so the publisher can exercise authenticated MCP reads pinned to the candidate before activation. Rollback requires an existing completion marker and rechecks the retained bytes. Only a successful promotion or rollback conditionally replaces `current.json`. R2's [conditional writes and consistency guarantees](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/#conditional-operations) provide the storage primitive; tests exercise its concurrent behavior in the local Worker runtime.

The pointer records a revision, the latest operation's sequence, and the highest promotion sequence/commit. Rollback preserves the promotion high-water mark but advances the operation sequence, even when its target is already current. A delayed lower-sequence operation cannot undo a newer release or a rollback. An exact retry with the same identity, operation and sequence returns its existing revision. After any uncertain write outcome, reread `/admin/current` and confirm both identity and operation sequence before retrying.

The GitHub Actions publisher must use one fixed production concurrency group with `cancel-in-progress: false`, retain the existing validation/evaluation gates, and check the current high-water commit is an ancestor of the candidate on main before promotion. Use a sequence from that fixed workflow and do not reset it. R2's ETag check is the final concurrency guard; the authenticated publisher is responsible for establishing Git ancestry and successful evaluation. No real-content publication is authorized by a local fixture pass alone.

`skills/get` returns the selected release and commit. The bridge sends `params._meta["io.gisul/commit"]` on subsequent body and directory reads. Those requests use the completed immutable prefix; discovery and new loads read the latest pointer. Retain completed releases while existing connections may use them. Search evidence, load evidence, and file-read evidence carry release/commit for the trace exporter.

### Initial activation

Verify `wrangler whoami`, the configured account, the existing Worker deployment, and the private bucket. Build and test both packages from the repository root before compiling the Worker:

```sh
npm --prefix server ci
npm --prefix server run build
npm --prefix server test
npm --prefix worker ci
npm --prefix worker run typecheck
npm --prefix worker test
cd worker
npx wrangler versions upload --dry-run
```

For migration, upload a candidate Worker version with `--var GISUL_SERVER_VERSION:<full source commit>` and use its preview URL to validate authentication and publish the first gated release. Keep production traffic on the existing version until the actual plugin can search, load, and read verified files from the candidate and release/commit is present in Langfuse. The pre-migration version read the Mac origin; the current production version reads R2 directly. Candidate and future production versions share the R2 bucket and pointer; preview promotion is not an isolated test environment after cutover. Then activate the tested version and record its source commit, Cloudflare version ID, content commit, inventory digest, and permanent checkout paths. [Worker versions and deployments](https://developers.cloudflare.com/workers/versions-and-deployments/) separate uploading a candidate from activating it.

## Mac mini server

Run from a clean, committed checkout:

```sh
scripts/deploy-macmini.sh macmini
```

The host is an SSH alias with BatchMode access. The defaults are the remote user's
`~/gisul` and launchd label `com.iyendev.gisul-mcp`; override them with
`GISUL_DEPLOY_ROOT` and `GISUL_DEPLOY_LABEL`. The target must already have the HTTP
LaunchAgent, its secret files, and the `gisul` executable configured. The script
checks that launchd's working directory matches the target before changing it.

The script runs `npm ci`, build, and the complete server test suite locally. It
rsyncs only tracked server files and the compiled `dist/` to a unique staging
directory, including `package-lock.json`. The remote host installs production
dependencies in staging before replacing the current server. The previous server,
including its dependencies and any extra files, remains in
`~/gisul/.deploy/server.bak-<deployment-id>`.

Only `~/gisul/server` is replaced. Skill content, token stores, LaunchAgents, and
the Cloudflare tunnel are outside the deployment. Existing stdio sessions retain
their running process; fresh sessions use the new build. The HTTP LaunchAgent is
restarted with `launchctl kickstart`.

The launcher must have its executable bit committed. Deployment checks it before
activation. `kickstart` has a 15-second timeout; on failure the script re-queries
the service and reloads the same LaunchAgent with `bootout`/`bootstrap` to clear
macOS spawn throttling. Other LaunchAgents are not restarted.

Smoke checks initialize the actual server over stdio, verify the skills extension,
exercise bridge pagination (`nextOffset`), load and verify a skill, and compare the
authenticated HTTP catalog with stdio. At least two valid skills are required.
Credentials are read from the existing LaunchAgent environment and remain on the
remote host. A failed restart or smoke check restores the previous server and
checks HTTP health. Failed candidates remain available for diagnosis.

`server/deployment.json` records the actual source commit, canonical checkout path,
and hashes and modes of the payload files. Each run also records its state in
`~/gisul/.deploy/<deployment-id>.json`. Repeating an unchanged commit verifies file
hashes and runs the smoke checks without replacing or restarting the server.

## Interrupted deployments

A lost SSH response is not evidence that the write failed. Inspect the journal
and `.deploy/lock/owner.json` before retrying. A concurrent deployment cannot acquire
the same lock. If the journal says `deployed` or `unchanged`, the operation finished.

If a process was interrupted during activation or recovery, confirm its PID is no
longer active before touching the lock. Use the journal's exact `current`, `backup`,
and `stage` paths. Preserve an activated candidate under a new failed-candidate
path, restore the backup to `server`, restart the same LaunchAgent, and verify
`/healthz` and stdio. Only then remove the stale lock and rerun. The two directory
renames have a short interruption window; the journal and retained backup make
that state recoverable. Never discard a backup to make a retry succeed.

Plugin installation is a separate step; see [the Codex client](../clients/codex/README.md).

## Authenticated HTTP skill writes

Set distinct `GISUL_WRITE_TOKEN` and `GISUL_GITHUB_TOKEN` Worker secrets. Keep the reader and publication secrets separate. Prefer a repository-scoped GitHub credential for `changeroa/gisul-skills` with Contents write and Actions read. Configure a writing client with a private token file containing the write token; never embed it in URLs or tracked config.

Writes are limited to `skills/<name>/SKILL.md` and, on creation, supporting text files inside that skill. They cannot change workflows or publication policy. All files are committed together to main using a non-forced reference update. Duplicate creation and stale SHA256 edits fail without overwriting. Existing resources are preserved on update. A lost ref-update response triggers one readback, never an automatic second write.

`accepted` means committed, not published. The existing GitHub Actions pipeline validates, uploads immutable release bytes and conditionally promotes current. Poll get_skill_write_status with the returned commit, then reload and compare content. A later active release may include the commit but may also contain subsequent edits. Reader tokens and the publication token do not grant MCP writes. Body limits are 1 MiB for writers and 64 KiB for readers; skill writes allow 768 KiB total and 128 text files.
