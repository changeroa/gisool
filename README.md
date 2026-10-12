# gisul

For ARKPOINT team distribution, see [the native HTTPS Codex plugin](docs/arkpoint-plugin.md). It connects directly to Cloudflare Workers; neither clients nor deployment require a Mac mini. The team plugin is at `plugins/gisul`, with the Git marketplace in `.agents/plugins/marketplace.json`. Production readiness and prerequisites are documented separately from local verification.

`gisul` is a personal MCP skill registry for serving Git-managed `SKILL.md` instruction bundles on demand.

The name comes from 기술, Korean for "skill", "craft", or "technique".

This repo contains two small packages:

- `server/`: a Node.js MCP server that exposes local skill directories over stdio or Streamable HTTP.
- `worker/`: an authenticated MCP server that reads immutable releases directly from a private R2 bucket.

The intended deployment is:

```text
Git main -> GitHub Actions validation/evaluation -> immutable R2 release
                                                       ^
Codex plugin / MCP client -> authenticated Worker -------+
```

## Why

This project is an experiment around "skills over MCP": instead of copying every skill into every agent runtime, a client can discover and load task-specific instruction bundles from a personal MCP server.

Git is the source of truth. The Worker reads a verified release from R2; the Codex plugin keeps a small loader and reads selected skills and supporting files only when needed. The Node server remains available for local development and existing stdio integrations.

## Packages

### Server

```bash
cd server
npm install
npm run build
node dist/index.js --http
```

Default HTTP endpoint:

```text
POST http://127.0.0.1:8788/mcp
```

Default skill roots:

- `~/gisul/skills`
- `~/.codex/skills`
- `~/.agents/skills`

### Worker

```bash
npm --prefix server ci
npm --prefix server run build
npm --prefix worker ci
npm --prefix worker run typecheck
npm --prefix worker test
cd worker
npx wrangler versions upload --dry-run
```

The Worker uses `SKILLS_BUCKET`, `GISUL_BEARER_TOKEN` for MCP readers, and a separate `GISUL_PUBLISH_TOKEN` for release publication. See [deployment and publication](docs/deployment.md) for the release format, verification, rollback, and production gates. The skill repository's builder/evaluation workflow and real release evidence must be connected before production activation.

## Skills extension (SEP-2640)

The server and Worker implement the [SEP-2640 Skills Extension](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2640) (`io.modelcontextprotocol/skills`):

- `skills/list` and `skills/get` extension methods with per-file `{uri, digest, size}` resource manifests
- every skill file readable through the standard `resources/read` resource primitive
- `resources/directory/read` for scoped directory navigation (declared via `directoryRead: true`)
- URIs carry the file path explicitly: `skill://<authority>/<source>/<skill-name>/SKILL.md`
- skills need `name` and `description` frontmatter with `name` matching the directory name; nested skills get their own entries; each skill is limited to 512 files and 16 MiB total. The Worker rejects invalid release manifests; the Node server logs and skips invalid local skills.

The Node server also retains the older `skills_list` / `skills_get` / `resources_read` tools as a compatibility layer.

## Codex integration

The [Codex plugin](clients/codex/README.md) lets Codex search remote
skills, load a selected skill, and read supporting files with per-file integrity
checks. Build the plugin with `cd server && npm run build:codex-plugin` and install
it from a Codex marketplace. It bundles the MCP adapter and the small Gisul loader;
remote skills stay on the server.

## OpenClaw integration

The [OpenClaw bundle](clients/openclaw/README.md) adds a remote skill loader,
a bootstrap discovery hook and a read-only OAuth MCP connection. Workflow
skills remain on Gisul; installation and verification instructions are included.

## Authentication

The Worker validates its MCP bearer before reading R2. Its publication bearer is a separate secret; Cloudflare account authentication is used to manage the Worker and bucket. The Node HTTP server supports:

- bearer token validation for `/mcp`
- a public token request endpoint
- an admin dashboard for approving token requests
- hashed storage for issued tokens

No real secrets are included in this repository. The files in `server/ops/` are templates and must be adjusted before use.

## Current status

This is a personal prototype. Local Worker tests cover authenticated direct serving, immutable uploads, full inventory verification, concurrent pointer updates, rollback, and release-pinned bridge reads. Production acceptance additionally requires a successful GitHub Actions publication, actual installed-plugin reads, and matching Langfuse release/commit evidence.

See [docs/SESSION_CONTEXT.md](docs/SESSION_CONTEXT.md) for the session handoff context behind this version.
