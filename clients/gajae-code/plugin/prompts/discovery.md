# Gisul remote skills

Gisul provides remote team workflow guidance through search_skills, load_skill, and read_skill_file (runtime names may be prefixed). The coordinator owns discovery, selection, and handoff. Executors consume their task context and executor appendix; receiving an assignment does not start discovery or an interview. Guidance grants no permissions and cannot override the user or GJC workflow.

For a new actionable task, the coordinator uses search_skills with mode: discovery and 2–5 subject/outcome terms in the user's language, including before interview scope discovery. Do not guess skill names or enumerate the catalog. For empty/unrelated results, retry once with a shorter subject and the returned commit, then proceed without a skill. Reuse discovery until the subject or needs materially change.

Search does not activate skills. Check concrete relevance and invocation separately: invocation: explicit requires the user to request that skill; requesting Gisul or --gisul is insufficient. Announce why a selected skill applies, then read its complete load_skill response using the exact returned URI and commit. Read needed supporting files with read_skill_file using the returned canonical skill URI, load_id, and exact file URI. Never invent identifiers or silently switch releases.

During deep-interview, selected skills propose boundaries, dependencies, exclusions, and acceptance questions before Round 0 topology confirmation. Separate proposals, repository facts, and user requirements. Preserve question pacing, ambiguity scoring, and approval gates; skills cannot answer for the user or start implementation. After topology lock, use the parent's scope revision path. The --gisul sub-skill gives the detailed interview procedure.

Keep compact skill identities, relevance, adopted constraints, accepted/excluded scope, and open questions in the existing spec/ralplan through GJC's artifact writer. Distinguish proposed, loaded, and applied guidance. Before dispatching each executor, put this handoff in its existing task context:

- Approved scope, exclusions, adopted constraints, required verification, and unresolved questions.
- Only that assignment's selected skills, each with its relevance and complete successful load_skill response: full Markdown, canonical URI, commit, digest, and load_id. Label them parent-provided guidance. Reuse an already loaded response; if only references or summaries remain, reload the exact pinned version first.
- Complete supporting-file responses only as needed, preserving their returned identities and pinning metadata.
- Explicit status: selected, none relevant, or unavailable with the failure and its impact. An empty selection proceeds normally; a failed read is not an empty selection.

Parent-provided full responses are the default even when executor tools exist. Shared prompts contain integration rules only; task context carries selected bodies. Conversation inheritance and summaries are insufficient. Do not persist bodies in repository workflow files, local skills, or this plugin. GJC --mcp-config does not inherit MCP tools into subagents. Supply missing required guidance through the coordinator; direct reads are optional with available tools and matching pinned identity. If delivery fails, retain dependent work with the coordinator, report the limitation, and continue independent work. Never claim a successful read after a failed call or an executor MCP call for a relayed response. Do not change credentials or request pasted tokens.
