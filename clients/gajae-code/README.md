# Gisul for Gajae Code

Gisul extends GJC's existing workflow: remote skills inform the deep interview's scope and help the executor carry out the approved assignment. It does not replace the bundled `deep-interview` or `executor`, or install remote workflow bodies as local skills.

## Install and connect

With Node 24+, npm/npx, and a GJC version supporting native plugin bundles installed, run from this checkout:

```sh
node clients/gajae-code/install.mjs --dry-run
node clients/gajae-code/install.mjs
node clients/gajae-code/login.mjs
gjc --mcp-config "$HOME/.gjc/agent/mcp.json"
```

The login command opens OAuth for your Ark-Point GitHub account and checks the MCP connection. Complete it before starting the GJC session so browser interaction does not compete with its MCP startup deadline. The connection requests `skills:read` and stores its credentials privately under this profile's `gisul/auth`; no token is copied from Codex or embedded in configuration. The first login/start downloads the pinned `mcp-remote@0.14.3` package through npx.

The default destination is `~/.gjc/agent`. Both commands accept `--agent-dir PATH` and respect `GJC_CODING_AGENT_DIR` / `PI_CODING_AGENT_DIR`, as well as the home-relative `GJC_CONFIG_DIR` / `PI_CONFIG_DIR` default. Launch GJC with the same profile, for example `GJC_CODING_AGENT_DIR=/absolute/profile gjc`. An installer override does not change your shell's runtime profile.

On the installed GJC 0.16.7 interactive build, a plain launch did not expose the registered MCP tools. The explicit `--mcp-config /absolute/profile/mcp.json` launch connected all three Gisul read tools and is the verified launch path. For another profile, pass its actual config path; this flag selects that file's MCP tools instead of conventional discovery. Existing sessions can retain their history with `gjc --resume SESSION_ID --mcp-config /absolute/profile/mcp.json`. Confirm tool visibility in the live session before relying on discovery; parsing the config alone is insufficient.

Start an interview with:

```text
/skill:deep-interview --gisul 팀 고객지원 도구의 범위를 정하고 싶어
```

Ordinary tasks also receive discovery guidance through the system appendix. `--gisul` explicitly adds the detailed interview procedure; it does not activate all remote search results. Executors receive their own appendix automatically, including when the task did not start with an interview.

## How skills help each stage

| Stage | Gisul contribution | What remains authoritative |
| --- | --- | --- |
| Before Round 0 topology confirmation | Search the user's domain/outcome; use relevant skills to propose components, boundaries, dependencies, exclusions, and acceptance questions | User intention and GJC's interview pacing/topology gates |
| Interview after topology lock | Use skill evidence to expose material gaps through the parent's scope revision path | User-confirmed boundaries; skill recommendations cannot silently expand scope |
| Spec and ralplan handoff | Preserve chosen URI, commit, digest, load_id, relevance, adopted constraints, accepted/excluded scope, and open questions in the existing artifact | GJC's artifact writer and ordinary approval/transition rules |
| Executor | Receive the selected skills' complete pinned responses and adopted constraints from the coordinator in task context; apply their implementation and verification guidance | Approved plan, task boundaries, and existing user authorization |

For example, a support workflow skill might suggest clarifying escalation ownership, history retention, or failure handling. Those become proposed interview questions, not automatically added requirements. Once the user agrees on scope, the executor receives those decisions and the complete relevant skill responses. Search hits alone do not constitute applied guidance or verification evidence.

The coordinator owns discovery and selection. Each search uses `mode: discovery`, 2–5 subject/outcome terms, and at most one shorter retry pinned to the returned commit. Selection checks relevance and invocation independently: `invocation: explicit` requires the user to request that particular skill. Unchanged interview answers reuse prior discovery. The executor does not repeat discovery or the interview; new skill or scope needs return to the coordinator.

Each executor handoff contains the approved scope, exclusions, adopted constraints, required verification, and open questions; only that assignment's selected skills, their relevance and complete successful load responses (Markdown, URI, commit, digest, `load_id`); and any needed supporting-file responses. The coordinator reuses the already loaded pinned response, or reloads that exact version before dispatch if only a summary remains. An explicit `none relevant` selection proceeds normally; an unavailable required skill is reported separately and its dependent work remains with the coordinator. The spec/plan keeps compact references and decisions, while full responses travel only through the existing task context.

## Integration surfaces

The installer calls GJC's own `plugin install ... --user` for the [prompt bundle](plugin/gajae-plugin.json), so GJC owns registry writes, hashing, collisions, and quarantine:

- `system_appendix`: discovery, scope discipline, and handoff guidance.
- `subskills`: `deep-interview` / `interviewing` / `--gisul`.
- `agent-appendix`: short executor rules for consuming the handoff, respecting scope, and reporting provenance and verification.

The MCP registration is separate in the native `<agentDir>/mcp.json`. GJC currently has no public MCP OAuth authorization entrypoint. Its bundle MCP surface cannot carry the OAuth bridge's environment settings and limits stdio launching by platform; therefore the prompt bundle contains no MCP. The native loose registration launches the pinned OAuth stdio proxy, with a positive 120-second timeout so GJC can finish connecting in the background after its bounded startup wait.

Conventional sessions can share their MCP manager with subagents, but the verified `--mcp-config` launch deliberately uses a tools-only manager that is not inherited. Parent-provided full responses are the default in both cases, so a complete handoff does not require another executor read. If required guidance is missing, the executor requests it from the coordinator; optional direct reads require available tools and matching pinned identity. The result identifies parent-provided guidance versus direct reads. Bodies remain remotely managed and are never installed or copied into repository workflow files. A missing executor tool must not be reported as an empty catalog or a successful independent load.

There are no custom execution hooks, top-level workflow replacements, or vendored remote skills. Discovery/selection behavior is model guidance; the installer does not guarantee that every model follows it. Runtime tests cover actual configuration and prompt injection, and transport tests cover remote calls and release pinning.

## Diagnose, update, and remove

Use `gjc plugin list --json --user` to inspect the prompt bundle, and `gjc mcp list` to inspect the native registration. GJC has no supported `/mcp auth` command; rerun this client's login command for its connection. If a project overrides or disables `gisul`, or disables project/user configuration, that runtime policy still applies. Missing tools are a connection/configuration problem, not evidence that the skill catalog is empty.

Dry runs write nothing and need no GJC executable. Existing unrelated MCP settings are preserved and backed up before merging; conflicting Gisul registrations fail before plugin installation. Identical prompt bundles and MCP registrations can be reinstalled without replacement. A different, disabled, or quarantined bundle is not silently overwritten. For a reviewed update, use `gjc plugin upgrade gisul --user` with the same profile and original checkout, then rerun this installer. If GJC rejects a sub-skill parent/phase collision with another plugin, the installer leaves MCP configuration untouched.

If plugin installation succeeds but a concurrent MCP edit prevents the config write, the error reports that partial state. Correct the conflict and rerun; the already installed identical bundle is reused.

To remove it, use `gjc plugin uninstall gisul --user` for the prompt bundle and `gjc mcp remove gisul` for the native registration in the same profile. Remove this profile's `gisul/auth` only if you also intend to discard its sign-in. Start a new session after configuration changes.

Compatibility evidence and reproducible checks: [runtime client verification](../../docs/runtime-clients-2026-09-29.md).
