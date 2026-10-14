# Self-hosted team OAuth plugin

Gisul's team Worker serves native MCP tools over HTTPS. It checks GitHub organization membership for OAuth access and reads immutable skill releases from R2. Each deployment supplies its own organization, content repository, Cloudflare resources, and HTTPS origin. A personal catalog is not automatically available to the team Worker.

## Configure the Worker

Create a private R2 bucket and Workers KV namespace for OAuth, and register a GitHub OAuth App with callback `https://your-host.example/callback`. Set the Worker secret `GITHUB_CLIENT_SECRET`; if publication or other server paths are enabled, provision their documented secrets separately. The GitHub OAuth App must be allowed to check organization membership. Edit access uses each member's GitHub token and is still constrained by repository permissions and branch protection.

`worker/wrangler.team.jsonc` is a template. Generate a deployable config with these environment variables:

| Variable | Meaning |
| --- | --- |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare account ID |
| `GISUL_OAUTH_KV_ID` | OAuth KV namespace ID |
| `GISUL_SKILLS_BUCKET` | Private release bucket name |
| `GISUL_PUBLIC_URL` | Production HTTPS origin, without `/mcp` |
| `GISUL_GITHUB_ORG` | GitHub organization whose active members may connect |
| `GISUL_SKILLS_REPOSITORY` | Content repository, in `owner/repo` form |
| `GITHUB_CLIENT_ID` | GitHub OAuth App client ID |
| `GISUL_WORKER_NAME` | Optional Worker name; defaults to `gisul-team` |

Set `GISUL_SERVER_VERSION` to the verified source commit (or use `GITHUB_SHA` in CI). The generator binds the custom domain from `GISUL_PUBLIC_URL`. Run `node scripts/team-config.mjs` to create the ignored `worker/wrangler.team.generated.json`. Review its nonsecret values and deploy it from `worker/` only after tests and release checks pass. The source repository does not deploy automatically.

## Configure clients

The checked-in Codex plugin at `plugins/gisul` contains the inert placeholder `https://gisul.example.invalid/mcp`. Before publishing your marketplace, set `plugins/gisul/.mcp.json` to your actual `https://your-host.example/mcp`, and set the marketplace metadata to your operator identity as desired. Check it with `node scripts/check-team-plugin.mjs` after updating the expected endpoint in that check or by supplying `GISUL_MCP_URL` to the check. The checked-in placeholder cannot reach a service.

Gajae Code and OmO installers and login commands require `GISUL_MCP_URL` in their environment. For example, run `export GISUL_MCP_URL=https://your-host.example/mcp` in the shell before using the copied commands in their guides. Use the same value during installation and login. OpenClaw users should prepare a bundle with `node clients/openclaw/prepare-oauth.mjs --output /new/bundle --endpoint https://your-host.example/mcp`; its source bridge also accepts `GISUL_MCP_URL`. Clients use `skills:read` by default. The Codex plugin requests `skills:read` and `skills:write`; GitHub permissions decide whether a connected member can edit.

After deploying, run `GISUL_PUBLIC_URL=https://your-host.example node scripts/smoke-team.mjs` for health, discovery, and anonymous rejection. That check does not prove an actual member can sign in or read a release; complete a member OAuth search, pinned load, and supporting-file read against your published content before treating the deployment as ready.
