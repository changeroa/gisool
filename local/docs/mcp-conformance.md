# MCP 2026-07-28 and Skills conformance

Audit date: October 14, 2026. Paths below are relative to `local/`.
Implementation revision: `3318fb1` - Serve gisool over modern MCP with standard skill resources.

Understood scope: replace the initialization-based MCP implementation, serve skill bytes only through
standard resources, retain search and dashboard observations, and leave installed agents and the running
user daemon untouched. This is a server implementation and a transparent stdio transport bridge, not a
skill-activating host.

## Specification and SDK decision

The normative Skills source is `specification/stable/skills.mdx` at
`modelcontextprotocol/ext-skills@167da6c0d42c247a8f8470228a10ca711e3f6c45`.
Its `docs/decisions.md` was read in full. The stable page takes precedence over superseded decisions
(notably: `resources: "dynamic"` rather than omitted resources; no archives or index resource;
required cache attributes on both Skills results).

Sources:

- https://raw.githubusercontent.com/modelcontextprotocol/ext-skills/167da6c0d42c247a8f8470228a10ca711e3f6c45/specification/stable/skills.mdx
- https://raw.githubusercontent.com/modelcontextprotocol/ext-skills/167da6c0d42c247a8f8470228a10ca711e3f6c45/docs/decisions.md
- https://modelcontextprotocol.io/specification/2026-07-28/basic
- https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning
- https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http
- https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio
- https://modelcontextprotocol.io/specification/2026-07-28/server/discover
- https://modelcontextprotocol.io/specification/2026-07-28/server/resources
- https://modelcontextprotocol.io/specification/2026-07-28/server/tools
- https://modelcontextprotocol.io/specification/2026-07-28/server/utilities/pagination
- https://modelcontextprotocol.io/specification/2026-07-28/server/utilities/caching
- https://agentskills.io/specification

`npm view @modelcontextprotocol/sdk versions --json` reported 1.32.1 as newest. The published
1.32.1 `dist/esm/types.js` still defines `LATEST_PROTOCOL_VERSION = '2025-11-25'`; its published
client and server implementations have no `server/discover`, and its package inventory has no
modern-era implementation. The newer SDK repository's split-package documentation is not evidence
that this npm package supports the revision. The legacy dependency and its 25 exclusive dependencies
were removed. The seven requested RPCs are implemented directly over Express and stdio.

SDK evidence: `https://unpkg.com/@modelcontextprotocol/sdk@1.32.1/dist/esm/types.js`,
`https://unpkg.com/@modelcontextprotocol/sdk@1.32.1/dist/esm/client/index.js`,
`https://unpkg.com/@modelcontextprotocol/sdk@1.32.1/dist/esm/server/index.js`.

## Server-side Skills MUST/SHOULD checklist

Each row covers the stated server obligation, including repeated obligations in the stable page.
Host-only obligations are separated below rather than claimed as implemented by the server.

| Normative obligation | Status and implementation |
| --- | --- |
| Every request MUST carry required base `_meta`. | PASS: `src/mcp/protocol.ts:35`, `src/mcp/protocol.ts:52`, `src/mcp/http.ts:33`, `src/mcp/stdio-proxy.ts:35`. |
| Declaring Skills MUST implement `skills/list` and `skills/get`. | PASS: `src/mcp/dispatch.ts:22`, `src/mcp/dispatch.ts:38`, `src/mcp/dispatch.ts:41`. |
| Declaring Skills MUST also declare Resources. | PASS: `src/mcp/dispatch.ts:22`. |
| A server declaring `directoryRead: true` MUST implement directory reading for every directory. | NOT APPLICABLE: the setting is omitted, meaning false; `src/mcp/dispatch.ts:22`. Unknown directory methods receive `-32601`. |
| Served skills MUST conform to Agent Skills format. | PASS: required fields and optional-field types/lengths in `src/catalog/fields.ts:74`; root file and matching directory in `src/catalog/scanner.ts:84`. Unknown author fields remain intact. |
| Every skill MUST contain root `SKILL.md`, beginning with YAML frontmatter with name/description. | PASS: `src/catalog/scanner.ts:84`, `src/catalog/fields.ts:8`, `src/catalog/fields.ts:74`. Invalid/non-JSON frontmatter is not published. |
| Servers SHOULD use `skill://`; final path segment MUST equal the name and satisfy its naming rules. | PASS: `src/catalog/uri.ts:7`, `src/catalog/fields.ts:76`, `src/catalog/scanner.ts:137`. Unicode lowercase alphanumerics and single hyphens are accepted; names are 1-64 characters. URI segments are percent-encoded. |
| Authority SHOULD be a valid reg-name; prefixes SHOULD be valid URI segments. | PASS: fixed `local` authority, encoded path segments: `src/catalog/uri.ts:4`, `src/catalog/uri.ts:7`. |
| Every file is exposed as a resource; supporting files remain inside the skill's directory. | PASS: complete traversal in `src/catalog/scanner.ts:33`, mapping in `src/catalog/scanner.ts:120`, canonical URI/path checks in `src/catalog/uri.ts:13`, `src/catalog/scanner.ts:180`. Unaddressable organizational prefixes reject the whole skill at `src/catalog/scanner.ts:85`. |
| SKILL.md resource MIME SHOULD be Markdown, name/description SHOULD come from frontmatter. | PASS: `src/mcp/skills-extension.ts:12`, `src/mcp/skills-extension.ts:40`. |
| Additional resource `_meta` SHOULD use the reserved Skills prefix; intermediary annotations MUST use their own prefix. | NOT APPLICABLE: no additional resource `_meta` or provenance annotations are emitted. Server identity uses the base protocol's own key. |
| Nested files are supporting content in the enclosing manifest; nested publication is flat. | PASS: `src/catalog/scanner.ts:33`, `src/catalog/scanner.ts:61`, `src/mcp/skills-extension.ts:29`. Both entries include the same nested bytes. Reading either is only an observation. |
| Frontmatter MUST be identical in content to SKILL.md, not a selected subset. | PASS: YAML parsing in `src/catalog/fields.ts:8`, JSON representability check in `src/catalog/scanner.ts:125`, unchanged wire mapping in `src/mcp/skills-extension.ts:24`. |
| Unknown `metadata` keys under `io.modelcontextprotocol/` SHOULD be ignored. | PASS: metadata is validated/preserved but never interpreted: `src/catalog/fields.ts:79`. No permissions are derived from it. |
| Names SHOULD be unique within a listing, but are not guaranteed unique. | DELIBERATE SHOULD EXCEPTION: configured roots may contain same-named skills. Renaming breaks the name/directory rule; silently dropping one loses a configured skill. Preserve distinct URIs and let hosts disambiguate. `src/catalog/index.ts:119` reports cross-root duplicates. |
| Every entry MUST carry `resources`, complete and exactly once per file, including its SKILL.md. | PASS: `src/catalog/scanner.ts:33`, `src/catalog/scanner.ts:116`, `src/mcp/skills-extension.ts:24`. No dotfile or dependency-directory exclusions. A skill with symlinks, non-regular entries or unaddressable paths is rejected as a whole, never truncated. |
| Every manifest URI MUST identify SKILL.md or a file within its skill directory. | PASS: `src/catalog/scanner.ts:120`, `src/catalog/uri.ts:7`; directory traversal and aliases are rejected by `src/catalog/uri.ts:13`. |
| Every resource MUST carry raw-byte size and a lowercase SHA-256 digest. | PASS: `src/catalog/scanner.ts:23`, `src/catalog/scanner.ts:117`. Nested files count in both manifests. |
| Dynamic content MUST use `"dynamic"` rather than omit resources. | NOT APPLICABLE: only static filesystem skills with publishable digests are served; all entries use complete arrays. |
| Servers SHOULD NOT serve skills over 512 resources or 16 MiB. | PASS, inclusive boundaries: `src/catalog/scanner.ts:11`, `src/catalog/scanner.ts:48`, `src/catalog/scanner.ts:128`. Entire oversize skills are rejected. |
| `skills/list` MUST exist and return `resultType: "complete"`. | PASS: `src/mcp/dispatch.ts:38`, `src/mcp/dispatch.ts:53`. |
| List pagination follows cursor/nextCursor; entries/manifests remain atomic. | PASS: `src/mcp/pagination.ts:6`, `src/mcp/skills-extension.ts:29`. Cursors are stable, method-scoped, and stateless; invalid/stale cursors give `-32602`. |
| `skills/list` MUST carry CacheableResult fields. | PASS: `src/mcp/skills-extension.ts:31`, `src/mcp/protocol.ts:8`. Every page carries the same private scope. |
| `skills/get` MUST return a complete result and answer for every served skill by its SKILL.md URI, including skills absent from a page. | PASS: direct catalog lookup in `src/mcp/skills-extension.ts:34`, common result envelope in `src/mcp/dispatch.ts:53`. No pagination cursor is returned. |
| `skills/get` of a non-skill URI MUST return `-32602`. | PASS: `src/mcp/skills-extension.ts:36`; an existing supporting file is not treated as a skill. |
| `skills/get` MUST carry CacheableResult fields. | PASS: `src/mcp/skills-extension.ts:37`. |
| Skill content is read with standard `resources/read`, without skill-specific loading semantics. | PASS: `src/mcp/dispatch.ts:47`, `src/mcp/skills-extension.ts:54`. No tool-based loading path or prior-load requirement remains. |
| Unknown skill-file reads MUST return `-32602`; internal failures MUST return `-32603`. | PASS: `src/mcp/skills-extension.ts:61`, `src/mcp/protocol.ts:69`. Stale digest failures fail closed with `-32603` and a refresh hint. No legacy resource error is emitted. |
| Protocol errors MUST be standard JSON-RPC errors; messages SHOULD explain the cause. | PASS: `src/mcp/protocol.ts:65`, `src/mcp/skills-extension.ts:36`, `src/mcp/skills-extension.ts:64`. |

## Base protocol and delivery checks

| Requirement | Implementation / evidence |
| --- | --- |
| Modern revision only; unsupported versions return `-32022` with requested/supported values. | `src/mcp/protocol.ts:3`, `src/mcp/protocol.ts:58`. |
| No initialize/session handshake; discovery is optional before ordinary requests. | `src/mcp/dispatch.ts:19`, `src/mcp/dispatch.ts:51`; fresh direct calls are tested. Legacy initialize errors name 2026-07-28. |
| Per-request identity/capabilities; no connection carries prior client context. | `src/mcp/dispatch.ts:15`, `src/mcp/stdio-proxy.ts:35`. Vendor metadata survives forwarding. |
| String/integer non-null IDs, one message per POST, same response ID, JSON-RPC errors. | `src/mcp/protocol.ts:16`, `src/mcp/protocol.ts:26`, `src/mcp/http.ts:20`. |
| Every success has resultType and SHOULD identify serverInfo. | `src/mcp/dispatch.ts:53`. |
| HTTP version/method/name headers are mandatory and body-validated; malformed/mismatched headers give 400 / `-32020`. | `src/mcp/protocol.ts:94`; Base64 sentinel and UTF-8/BOM handling in `src/mcp/protocol.ts:76`. |
| Missing request metadata gives 400 / `-32602`; unknown methods give 404 / `-32601`. | `src/mcp/protocol.ts:52`, `src/mcp/http.ts:43`. |
| Origin validation, loopback binding, bearer authentication and body limits remain enforced. | `src/api/security.ts:38`, `src/server.ts:35`, `src/server.ts:138`, `src/mcp/http.ts:12`, `src/mcp/http.ts:19`; composed-server security tests cover MCP. |
| Accepted notifications get 202 with no body; GET/DELETE get 405; legacy session/replay headers do not create state. | `src/mcp/http.ts:26`, `src/mcp/http.ts:47`. |
| stdio uses newline-delimited JSON and preserves request metadata; no SDK initialization upstream. | `src/mcp/stdio-proxy.ts:5`, `src/mcp/protocol.ts:112`. |
| stdio cancellation aborts the request fetch and suppresses later replies; EOF/signals abort pending requests. | `src/mcp/stdio-proxy.ts:10`, `src/mcp/stdio-proxy.ts:26`, `src/mcp/stdio-proxy.ts:49`. Filesystem reads already in progress can finish; no messages are sent after cancellation. |
| Cacheable discovery, tool list, resource list/read, and both Skills results carry nonnegative TTL and scope. | `src/mcp/protocol.ts:8`, `src/mcp/dispatch.ts:19`, `src/mcp/skills-extension.ts:29`. Every list page stays private. |
| Only search is a tool; deterministic listing, validated inputs, rate limiting, JSON-safe results. | `src/mcp/tools.ts:29`, `src/mcp/tools.ts:38`, `src/mcp/tools.ts:46`, `src/mcp/dispatch.ts:26`. JSON Schema 2020-12 is emitted; no custom parameter-header annotations or remote `$ref`s are used. |
| Resource MIME and byte integrity; binary data encoded correctly; no empty success for missing resources. | `src/mcp/skills-extension.ts:78`, `src/catalog/index.ts:100`. |
| Required client capabilities cannot be assumed. | No sampling, elicitation, roots or other client-side feature is requested; no `-32021` condition is required by these handlers. |
| Dashboard loads/read_file events survive standard resource reads. | `src/mcp/skills-extension.ts:68`, `src/ingest/mcp-recorder.ts:38`; load events explicitly carry `observationOnly: true`. Trace, flow and heatmap assertions pass. |
| Configuration writers do not synthesize a protocol handshake. | Writers contain endpoint/transport/auth configuration only. `src/cli/init.ts:118` states the new requirement; `src/packs/codex.ts:146` explains the relevant Codex feature. No client-wide flags or real user configurations were edited. |

## Host responsibilities and optional features

The stable page's host MUST/SHOULD rules remain host responsibilities: server-scoped identity and caches,
origin labels, collisions across origins, URI rather than name identity, no DNS interpretation of authorities,
frontmatter/digest/size verification, held-manifest membership, lazy retrieval, relative reference resolution,
consent and nested-skill reapproval, permission gating, code-execution approval, and cache isolation.
gisool does not impersonate a host or claim a resource read activates a skill. Its `load` event is dashboard
terminology for an observed published SKILL.md read, not a host acting window. `allowed-tools` is never executed
or granted by gisool.

Directory reading, dynamic manifests, list-change subscriptions, MRTR, remote-reference schema validation,
and custom tool-parameter headers are not advertised or used. They are not missing declared capabilities.
The only intentional server SHOULD exception is duplicate skill labels described above; no known server MUST
gap remains in the supported surface.

## Client-facing breaking changes

- Only MCP 2026-07-28 is accepted. Legacy initialize clients cannot fall forward, and GET/DELETE session
  mechanics no longer exist. This includes the inspected OmO/Senpi source using SDK 1.29.0, Gemini CLI's
  upstream core using SDK 1.23.0, and OpenClaw's upstream SDK 1.32.1 client.
- Codex's third-party HTTP connections can use modern negotiation when its `mcp_2026_07_28` feature is enabled;
  legacy mode cannot connect. The separate hosted Apps feature does not apply to gisool. The pack reports
  the requirement rather than silently editing an agent-wide experimental feature.
- Recent Claude Code upstream changelog entries describe modern negotiation for direct HTTP and stdio.
  Those builds are not categorically broken. Older builds and `MCP_SDK_GENERATION=v1` /
  `MCP_PROTOCOL_NEGOTIATION=legacy` configurations cannot use this server.
- Cursor and Gajae installed-version negotiation behavior was not established. Any legacy build fails;
  no product-wide claim is made from a pack's existence.
- Custom skill-loading tools and load handles are gone from the MCP surface. Clients must expose a
  standard resource reader to the model and implement the host's Skills verification/approval path.
- Invalid skill names/frontmatter, oversized skills, and skills whose full manifests cannot be served
  are no longer published. Hidden and dependency files now count toward limits and digests.

Compatibility evidence retrieved on the audit date, not claims of launching these installed agents:

- Locally inspected OmO/Senpi sibling checkout: `packages/coding-agent/package.json`, SDK 1.29.0.
- https://raw.githubusercontent.com/google-gemini/gemini-cli/main/packages/core/package.json
- https://raw.githubusercontent.com/google-gemini/gemini-cli/main/packages/core/src/tools/mcp-client.ts
- https://raw.githubusercontent.com/openclaw/openclaw/main/package.json
- https://raw.githubusercontent.com/openai/codex/main/codex-rs/rmcp-client/src/protocol_mode.rs
- https://raw.githubusercontent.com/openai/codex/main/codex-rs/app-server/README.md
- https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md

## Verification

- `npm run build`, `npm run typecheck`, `npm test`: exit 0; 269 tests pass.
- `node bench/search.mjs --check`: exit 0; all eight benchmark gates pass. Its own reported limitation
  remains: these are maintainer-authored regression cases, not an independent search-quality holdout.
- `node bench/mcp-mutations.mjs`: exit 0; 45/45 mutants killed by assertions.
  Each mutant is injected by a Node module hook only in memory.
  An assertion failure is required; syntax errors, target misses and timeouts do not count.
  Source and compiled files remain unchanged.
- `test/e2e/daemon.test.mjs` starts the real CLI daemon on an ephemeral non-8799 port, drives
  discover -> sole tool -> search -> SKILL.md read -> supporting read, verifies the manifest digest,
  queries load/read_file events and dashboard trace/flow/heatmap, rejects initialize, and tears down.
  Sandbox HOME is created before deriving GISOOL_HOME; GISOOL_NO_CLI disables runtime registration.
- A separate isolated-HOME run passed all three daemon tests; `npm ci --ignore-scripts --dry-run`
  also accepted the pruned lockfile without installing or changing dependencies.
- The user daemon on 8799, installed packages, and user configurations were not modified or restarted.
