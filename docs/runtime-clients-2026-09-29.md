# OmO and Gajae Code client verification — 2026-09-29

## Implementation

Canonical source: `/Users/victor/projects/gisul`. This adds installable client integrations and their checks; no runtime server deployment is needed. The subsequent Herdr test installed both clients into the user's existing profiles and completed real read-scope OAuth. The new `contribute` workflow was published separately through Gisul.

| Client | Implemented surface |
| --- | --- |
| [oh-my-openagent](../clients/oh-my-openagent/README.md) | Native stdio OAuth bridge registration, a `before_agent_start` discovery extension, and a small Gisul loader |
| [Gajae Code](../clients/gajae-code/README.md) | Native loose stdio registration using `mcp-remote@0.14.3`, a profile-scoped login command, and a native prompt bundle |

The GJC bundle exposes a `deep-interview` sub-skill at phase `interviewing` with activation argument `gisul`, plus a system appendix and a short executor appendix. Interview guidance treats skill-derived boundaries as proposals, preserves topology/approval gates, and carries accepted scope and pinned references through the existing spec/plan. In bundle 0.1.2 the coordinator supplies each executor's selected skills as complete pinned responses in task context by default, together with approved constraints and verification requirements. Executors reuse that handoff, return missing guidance or new scope needs to the coordinator, and report provenance separately from implementation and verification. Direct reads are optional for missing guidance when tools are available. Remote workflow bodies are not distributed or installed locally.

Installers support dry runs and explicit agent directories, preserve unrelated MCP configuration, reject conflicting Gisul files/registrations, and create private backups when merging an existing config. GJC owns its plugin registry and hashing. A rerun reuses an identical installed bundle, including after a partial MCP setup failure.

## Upstream contracts checked

- OmO source: [`1b3bb502b89fc5b6412d454d18d8425893477f10`](https://github.com/code-yeongyu/oh-my-openagent/tree/1b3bb502b89fc5b6412d454d18d8425893477f10), native package version 5.1.0. Its [agent directory resolver](https://github.com/code-yeongyu/oh-my-openagent/blob/1b3bb502b89fc5b6412d454d18d8425893477f10/packages/omo-native/bin/lib/agent-dir.js) and [MCP import writer](https://github.com/code-yeongyu/oh-my-openagent/blob/1b3bb502b89fc5b6412d454d18d8425893477f10/packages/omo-native/bin/lib/setup-assets-import.js) establish the native persistence paths. The [package manifest](https://github.com/code-yeongyu/oh-my-openagent/blob/1b3bb502b89fc5b6412d454d18d8425893477f10/packages/omo-native/package.json) pins `@code-yeongyu/senpi` to `2026.9.28-7`.
- Senpi's published `2026.9.28-7` package was inspected and used for the real MCP config-loader check. Its `docs/mcp.md` documents native OAuth, `oauth.scopes`, and `/mcp auth`; `docs/extensions.md` documents the chained `before_agent_start` API. Its `dist/core/resource-loader.js` explicitly removes automatic `APPEND_SYSTEM.md` discovery, so this integration uses an extension.
- GJC source: [`7e54f9cbcf712cfa7f633d3c8da58a6d89f7f301`](https://github.com/Yeachan-Heo/gajae-code/tree/7e54f9cbcf712cfa7f633d3c8da58a6d89f7f301), package version 0.18.1. Reviewed [plugin surfaces](https://github.com/Yeachan-Heo/gajae-code/blob/7e54f9cbcf712cfa7f633d3c8da58a6d89f7f301/docs/gjc-plugins.md), [MCP startup and OAuth boundaries](https://github.com/Yeachan-Heo/gajae-code/blob/7e54f9cbcf712cfa7f633d3c8da58a6d89f7f301/docs/standalone-mcp.md), workflow phases, sub-skill activation/injection, and executor prompt composition. Executable compatibility checks used the installed GJC 0.16.7 package and CLI; 0.18.1 was source-reviewed, not executed.
- [`mcp-remote`](https://github.com/punkpeye/mcp-remote#static-oauth-client-metadata) supplies browser OAuth for both clients. Version 0.14.3 is pinned in client arguments and as a test-only server dependency. Static metadata requests `skills:read`; the login helper and proxy share the same profile-local OAuth cache and metadata.
- Live Senpi `2026.9.27-4` testing exposed a native authorizer limitation: despite configured `oauth.scopes: ["skills:read"]`, its authorization URL requested both advertised scopes. Its `beginAuthorization` delegates to SDK `auth` without an explicit scope override. The client now uses the pinned bridge; its actual authorization URL requests only `skills:read`. The native credential created during this test was logged out before switching, and both bridges use separate profile caches. Updated native-loader checks passed on the installed Senpi `2026.9.27-4` and GJC `0.16.7`.

## Verification

Environment: Node 24.18.0, Bun 1.4.2, macOS. Automated installation checks use disposable profiles. The later Herdr exercise additionally uses the existing Senpi and GJC user profiles.

| Check | Result |
| --- | --- |
| `npm --prefix server run build` | Passed |
| `npm --prefix server test` | 55 tests passed, including six installer/discovery tests |
| `npm --prefix worker run typecheck` | Passed |
| `npm --prefix worker test` | 60 tests passed |
| `node scripts/check-team-plugin.mjs` | Existing Codex plugin check passed |
| `scripts/check-runtime-clients.mjs` with native runtime packages | Passed: GJC install/reinstall, bundle compiler, interview advertisement, phase-scoped body injection, executor-only appendix, native config loaders, and OmO extension prompt composition |
| LSP diagnostics and `git diff --check` | No reported diagnostics/whitespace errors |

The transport regression test starts the actual pinned `mcp-remote` proxy against a local Worker/R2 fixture. It also exercises direct HTTP. Both paths list native tools, search by subject, load the selected immutable release after a new release is activated, read the old supporting file by `load_id`, and preserve tool errors for an invalid load identity. Existing Worker OAuth tests cover consent, PKCE, read-only grants, refresh, and membership checks.

Reproduce the native compatibility check with installed runtime package roots and `gjc` on PATH:

```sh
bun scripts/check-runtime-clients.mjs \
  --gajae-source /absolute/path/to/@gajae-code/coding-agent \
  --senpi-source /absolute/path/to/@code-yeongyu/senpi
```

The script uses runtime code from those explicitly supplied paths and removes its profiles in `finally`. It does not launch a model or initiate a browser login. CI runs the installer and transport regressions through the ordinary server/Worker suites; the native source compatibility check is separately reproducible.

## Limits and activation

The automated tests establish installation, configuration, prompt delivery, and transport behavior; they do not establish that every model follows the guidance. Live OAuth completed in both profiles. A real bridge connection to production listed exactly `search_skills`, `load_skill`, and `read_skill_file`; OmO's session status also reported three Gisul tools. The existing production Worker already serves the required native read tools. IronClaw contribution worktrees created for the Herdr exercise are tracked separately in the task's handoff record while their agents remain active.

The GJC 0.16.7 interactive build did not expose Gisul tools on the first conventional launch, despite a valid config and a successful standalone bridge connection. Resuming the same session with `--mcp-config /Users/victor/.gjc/agent/mcp.json` displayed `3 MCP tools connected`. This explicit path is now the documented launch command; source-loader smoke tests alone do not establish conventional autoload in an installed interactive build.

A real GJC executor task revealed a separate boundary: exact-file sessions use a tools-only MCP manager, and `src/task/index.ts` deliberately excludes that manager from subagent inheritance. The executor's tool search had no Gisul tools; its incomplete result is not evidence of a successful skill load. Prompt bundle 0.1.1 therefore supports parent-provided guidance: the coordinator relays the complete pinned load response through the task context, and the executor labels that provenance instead of claiming an independent MCP call. Native bundle/compiler/phase checks passed again after this change. Conventional-manager inheritance is source-reviewed, not established by this exact-file interactive test.

The follow-up executor `2-RootGuidedPatchReview` completed and returned its result through GJC's task surface. It received the full coordinator-loaded `contribute` response at `08053594d7bfcdcdabf36cdab8beb6886ac35c1c`, identified the exact digest/load_id, explicitly stated that it did not call MCP, and reviewed only the assigned CLI/config patch without running builds or modifying files. Its result correctly left executable verification with the parent. The coordinator supplied this response after the running GJC connection returned `MCP lease releasing`; that error is not treated as a successful GJC reload.

## Executor handoff update — bundle 0.1.2

The parent-provided path is now the default for every executor assignment, including when the executor has MCP tools. The shared executor appendix is 188 words and contains consumption, scope, missing-guidance, and provenance rules. The coordinator selects and passes complete pinned responses for that assignment, alongside adopted constraints and required verification. Explicitly selecting no relevant skill allows ordinary execution; failed reads remain a separate unavailable state. The spec/plan preserves references and decisions, while full bodies stay in task context. Interview guidance uses the same handoff.

GJC also renders its system appendix for subagents, so the shared discovery rules explicitly assign discovery and selection to the coordinator and exempt executors from restarting them. This is prompt guidance, not a deterministic task-payload transformer or a change to GJC's MCP inheritance.

Validation after the update:

- The native compatibility script passed with GJC `0.16.7` and Senpi `2026.9.27-4`, including installation/reinstallation, interview activation and phase injection, executor appendix, and native MCP configuration. Disposable profiles were removed in `finally`.
- All six installer regression tests passed.
- `gjc plugin upgrade gisul --user` updated `/Users/victor/.gjc/agent` to `0.1.2` from the canonical `/Users/victor/projects/gisul/clients/gajae-code/plugin` checkout. Reinstallation reported both the bundle and MCP registration unchanged. The actual user-profile native renderer returned the current coordinator and executor bodies and no executor appendix for `architect`.

The existing Herdr agents were not restarted. New sessions load the updated bundle. No new live model or deep-interview run was performed for 0.1.2; the earlier successful relay review establishes the feasibility of parent-provided guidance, while these checks establish delivery of the revised instructions. There is no server deployment for this prompt-only update.
