# Codex plugin

**Team OAuth installation:** use the [native HTTPS plugin](../../docs/team-plugin.md). It has no local adapter, Node or SSH dependency. The instructions below describe the retained personal/legacy adapter, which is a separate deployment path.

Gisul's Codex adapter exposes `search_skills`, `load_skill`, `read_skill_file`,
`create_skill`, and `update_skill`. A small local `$gisul` skill teaches Codex when and how to use
them. Remote skills stay remote; the catalog is not copied into local skill folders.

## Plugin setup

The plugin source is `plugin/gisul/`. Its manifest bundles the local loader and
an MCP server configuration; the adapter and its npm dependencies are bundled
into a single JavaScript file. The installed plugin does not depend on this
checkout or its `node_modules`. It requires Node 22+ and either an authenticated
HTTPS MCP endpoint or working SSH access to the configured `macmini` alias.

Build the distributable plugin:

```bash
cd server
npm ci
npm run build:codex-plugin
```

Publish the built `clients/codex/plugin/gisul/` directory through a Codex local
marketplace. In this personal setup, the source is `~/plugins/gisul` and the
marketplace is `~/.agents/plugins/marketplace.json`. Install using:

```bash
codex plugin add gisul@personal
```

Start a new Codex thread and select the Gisul skill or ask:

```text
Gisul에서 코드 리뷰에 맞는 스킬을 찾아 적용해줘.
```

For another SSH host, edit both the origin label and SSH host in the plugin's
`.mcp.json` before publishing. Its `cwd: "."` resolves to the installed plugin
directory. On machines outside the Homebrew/Linux standard paths, adjust PATH.

For updates to an existing personal-marketplace installation:

```bash
node clients/codex/install.mjs --plugin --dry-run macmini
node clients/codex/install.mjs --plugin macmini
```

The installer discovers the source through `codex plugin list`, rebuilds the
bundle, uses the plugin-creator helpers to validate the marketplace and update
the version cachebuster, and runs `codex plugin add gisul@<marketplace>`. It keeps
a source backup beside the existing plugin. It then checks the selected version,
enabled state, exact cache file bytes, and fresh MCP discovery/pagination/reads.
Cache, `config.toml`, and marketplace files are managed by Codex's CLI. New
threads pick up the updated tools and skills; a running thread keeps its existing
MCP connection. `codex plugin list --json` reports plugin versions; `codex mcp list`
is not the plugin-version registry.

For a Cloudflare Worker HTTPS endpoint, keep the bearer credential in an absolute
local file outside the plugin and repository (owner-readable only):

```sh
node clients/codex/install.mjs --plugin --dry-run \
  --http-url https://YOUR_WORKER.workers.dev/mcp \
  --bearer-token-file /absolute/private/path/gisul-token
node clients/codex/install.mjs --plugin \
  --http-url https://YOUR_WORKER.workers.dev/mcp \
  --bearer-token-file /absolute/private/path/gisul-token
```

The installed adapter uses Streamable HTTP upstream and starts no SSH process.
It retains local manifest verification, lazy supporting-file reads and Langfuse
event evidence. HTTPS exposes only the three read tools; content publication
continues through the verified Git/release workflow. Credentials are not embedded
in plugin files or URLs. Redirects are rejected. Plain HTTP is accepted only by
the runtime on loopback for tests, not by the public endpoint installer.

The R2 Worker serves immutable releases directly. Confirm the active Worker version,
its private R2 binding, and a successful real release before updating the installed
plugin. The [deployment guide](../../docs/deployment.md) describes those gates.

This update path requires an existing local source in the default personal
marketplace and the plugin-creator skill at
`${CODEX_HOME:-~/.codex}/skills/.system/plugin-creator`. Set `GISUL_PLUGIN_CREATOR`
if that skill is elsewhere. It refuses a competing standalone MCP registration.
After an ambiguous install failure it re-queries the selected version before
reporting an error; inspect that result and the printed backup before retrying.

Check the actual installed bundle and upstream together:

```bash
cd server
node smoke-codex-plugin.mjs /absolute/path/to/installed/gisul
```

This checks discovery, selected-skill loading, and digest-verified reads without
printing skill bodies. It does not test a model's skill-selection decisions.

## Standalone compatibility installer

The earlier `install.mjs` remains available for setups that do not use plugins.
Use either the plugin or standalone registration, not both.

Build on the machine running Codex:

```bash
cd server
npm ci
npm run build
cd ..
node clients/codex/install.mjs --dry-run macmini
node clients/codex/install.mjs macmini
```

The installer registers a local adapter with `codex mcp add` and installs only the
loader in `${CODEX_HOME:-$HOME/.codex}/skills/gisul`. It uses the absolute paths of
the current Node executable and checkout: keep both available after installation.
An existing `gisul` registration or different local skill is never overwritten.
The user-level `.codex/skills` path keeps this loader scoped to Codex's existing
skill setup rather than the cross-client `.agents/skills` directory.

The upstream host must already support noninteractive `ssh macmini gisul` and run
the current server build with the `io.modelcontextprotocol/skills` capability.
Older tool-only gisul deployments fail with an upgrade message. This installer
does not deploy the remote server or restart its services. To use another SSH
alias, replace `macmini` in the install command. SSH uses BatchMode, so configure
the SSH key and known-host entry before starting Codex.

Start a new Codex session, check `/mcp`, and try:

```text
$gisul 찾아서 코드 리뷰에 맞는 스킬을 적용해줘.
```

For a known URI:

```text
$gisul skill://gisul/agents/my-workflow/SKILL.md를 읽고 이 작업에 적용해줘.
```

Only `$gisul` appears as a local skill. Selection of remote guidance is model-driven;
this does not modify Codex itself or guarantee automatic selection for every task.

## Behavior and boundaries

- Search returns compact names, descriptions and exact URIs. Same-named skills remain separate. The loader searches a task subject with `mode: discovery`, checks relevance and invocation policy, and loads only selected results. Legacy mode retains all-literal-word matching and URI order; ranked modes are described below. Search reads all upstream catalog pages before applying `offset` (default 0) and `limit` (default 5, maximum 50).
- Search responses include `totalMatches`, `offset`, and `limit`. When `nextOffset` is present, pass it as `offset` with the same `query` and `limit` to continue; its absence marks the last page. For example, start with `{"query":"review","limit":50}`, then use `{"query":"review","limit":50,"offset":50}` if `nextOffset` is 50. Catalog pages may be reused within the upstream TTL (30 seconds on gisul); additions or removals between refreshes can shift pages; restart from offset 0 if the catalog changes.
- `offset` must be a nonnegative safe integer and `limit` an integer from 1 to 50; invalid values return an MCP tool error. An offset at or beyond `totalMatches` returns an empty page without `nextOffset`, as does a search with no matches.
- Load fetches the current manifest and only `SKILL.md`. Every file read checks
  SHA-256 and size. Frontmatter must match the manifest.
- Load reports `release`, content `commit`, `server_version`, and a reproducible
  `manifest_digest`. Unknown upstream version fields are `null`. A moved skill
  returns its canonical `uri` and `movedFrom`; undeclared and cross-server
  redirects fail verification. Search also matches string entries in frontmatter
  `keywords`, including Korean discovery terms.
- Manifests over 20 files return a compact `files` list folded into immediate
  directories. `read_skill_file` on a returned directory expands its pinned
  children without reading their bodies. File reads still verify exact bytes.
- Supporting files are read lazily against the manifest held for this connection.
  The bridge passes the loaded commit as `params._meta["io.gisul/commit"]` on file
  and directory requests. The R2 Worker retains that version across publication
  and rollback; a fresh load uses current. Files outside the manifest and changed
  bytes fail. Upstreams without commit metadata retain digest checks but cannot
  provide release pinning. Reload explicitly to inspect an update.
- Each response names the configured upstream origin. The adapter has exactly one
  upstream and provides no cross-server reads, disk cache, or script execution.
- Dynamic manifests and binary assets are unsupported in this instruction-only
  adapter. The remote server must supply a complete static manifest.
- The loader preserves user authorization and remote origin. This compatibility
  adapter cannot intercept Codex's other execution tools or implement native
  host-wide consent enforcement. Digest verification establishes consistency,
  not trust in the author. An execution approval is never granted by a tool response.

## Event evidence

The bridge appends JSONL events to
`${CODEX_HOME:-~/.codex}/logs/gisul/events-<YYYYMMDD>.jsonl` (UTC date). Override
the directory with `GISUL_EVENT_LOG_DIR`, for example in isolated tests. Events
include connection lifecycle, searches, loads, reads, and classified errors, with
release/digest, byte count, and duration where available. Skill bodies and bearer
credentials are not recorded. Logging failure is reported on stderr and does not
prevent workflow calls.

Each tool response includes the same `connection_id` as its event records, so
trace exporters can join exact connections. `bridge_cwd` is the bridge process's
directory, often the installed plugin directory; it is not evidence of the user's
project workspace. Codex session IDs are not invented by the bridge.

## Test

```bash
cd server
npm run build
npm test
node bench/search.mjs --check
```

The [search benchmark](../../server/bench/README.md) uses a fixed metadata fixture;
its scores do not describe the current connected catalog or network latency.

To run the adapter directly against an alternative stdio server:

```bash
node server/dist/codex.js --origin my-server -- /absolute/path/to/server arg1
```

To remove the plugin: `codex plugin remove gisul@personal`.
For the standalone setup, remove the MCP registration with `codex mcp remove gisul`. Remove the installed
`skills/gisul/SKILL.md` separately if you no longer want the loader.

## Protocol negotiation and memory cache

The upstream adapter probes `server/discover` with MCP `2026-07-28` metadata.
A compatible modern server receives per-request version/capability metadata;
legacy stdio errors or a bounded probe timeout fall back to `initialize`.
Recognized modern errors and malformed discovery results do not silently downgrade.
HTTP mirrors method, version and resource/tool name into headers and keeps the
SDK's JSON/SSE response parser. The host-facing tool connection remains compatible
with existing clients. Connect events record the actual upstream protocol.

Each bridge owns a bounded in-memory response cache (256 entries / 32 MiB).
It never shares entries across upstream connections or authorization contexts,
even when a server labels content public. Missing, negative or zero TTL does not
cache; expiry is checked on demand without background polling or stale-on-error
fallback. Search caches catalog pages and reads cache resource responses. Each
file, including a cached file, is still checked against the held digest and size.
Explicit `load_skill` clears the cache and always retrieves the current manifest;
write attempts, resource notifications and digest failures also clear it.
In-flight responses cannot repopulate a cache invalidated after they started.
Static directory listings come from the pinned manifest and need no optional
directory RPC or pagination. This does not discover newly added files until reload.
## Opt-in discovery modes and version selection

`search_skills` keeps its original substring matching and URI order when `mode`
is omitted or `legacy`. New clients can opt into `discovery`, `automatic` or `explicit`.
These modes normalize case, Unicode width/composition, punctuation, common Korean
particles and English plurals. They rank exact names, exact keywords and weighted
subject matches, using term rarity and coverage without requiring every narrative
detail to match. Incidental single-word matches in longer requests are excluded.
URI order breaks ties; same-named skills from
different sources remain distinct. Keywords come from the skill's versioned
frontmatter, so adding bilingual discovery terms is a content change.
Tokens match whole words after normalization: `UI` does not match inside `build`,
and `hate` does not match inside `whatever`. Compound names are also tokenized;
exact full names retain priority. There is no embedded map of skill names to queries.

`discovery` searches all candidates but never activates them. Candidates marked
`invocation: explicit` still require an explicit user request before application.
`automatic` excludes entries with `disable-model-invocation: true`.
Both require a nonempty subject. `explicit` includes all candidates for a user-requested workflow.
These modes return `invocation` and the SKILL.md `digest` with each match. This
is a discovery policy, not an authorization boundary. The tool does not schedule
automatic searches or change global Codex instructions.

Continue a result page with the same query, mode, limit and returned `commit`.
Omit commit on a new task to discover the current release. Passing that commit
to `load_skill` selects the same immutable release; an upstream that cannot
honor it fails instead of silently supplying current content.

Each load returns `load_id`. Pass it with `skill_uri` and a listed file or
directory URI to `read_skill_file` to retain that manifest even after reloading
the same skill at a newer commit. Without `load_id`, existing clients continue
using the latest load for that URI in their connection. A load ID belongs to its
connection and the exact skill/declared alias; it cannot read another skill.


Search responses contain description excerpts of at most 240 Unicode code points,
with `descriptionTruncated: true` when shortened. The default page is five items.
Full instructions and frontmatter are available through verified `load_skill`.
This reduces model-facing metadata, not the size of upstream catalog requests.
Default matching/order stays legacy; name/keyword ranking is available in the
explicitly selected modes above. A new task should omit commit; continuation and
selection should carry the returned commit (when non-null).
