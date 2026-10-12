---
name: gisul-interview
binds_to: deep-interview
phase: interviewing
activation_arg: gisul
description: Use remote team skills to reveal interview scope, boundaries, assumptions, and acceptance questions before scope is agreed.
---

Use Gisul to inform the extent of this interview. Preserve the parent deep-interview workflow, its question pacing, topology confirmation, ambiguity scoring, artifact writer, and execution approval gates.

1. Before Round 0 topology confirmation, search the user's domain and desired outcome with search_skills, mode: discovery, and 2–5 subject/outcome terms. Reuse relevant search/load results already available for this unchanged task. An empty or unrelated search permits one shorter retry pinned to the returned commit; then continue the ordinary interview.
2. Inspect each candidate's description and invocation. Load only concretely relevant skills, and only after an explicit user request if invocation is explicit. Announce the relevance, call load_skill with the exact URI and commit, and read its complete Markdown. Request supporting files only when needed with the returned canonical skill URI, load_id, and exact file URI. --gisul selects this integration, not all remote skills.
3. Extract only what helps clarify the user's intention: possible components and their boundaries, actors, dependencies, domain constraints, failure cases, non-goals, and evidence for acceptance. Treat an implementation skill's prerequisites as possible interview questions, not a command to implement. A search result or skill recommendation is not a user requirement or evidence that a requirement is satisfied.
4. Compare each finding with repository facts and existing user answers. Present the few material gaps through the parent's next question or topology confirmation. Label each new boundary as a proposal with its source. Respect explicit exclusions. Do not expand the task merely because more skills exist; do not ask questions already answered. After topology lock, use the parent's explicit scope revision mechanism for material additions.
5. In the existing interview spec, record accepted boundaries, exclusions, unanswered questions, and concise Gisul references: URI, commit, digest, load_id, relevance, and the constraints actually adopted. Mark recommendations that were not adopted. Use GJC's sanctioned artifact writer. Do not persist whole remote SKILL.md bodies or supporting files locally.
6. Hand these references and decisions to ralplan. When execution is authorized, the coordinator selects guidance for each approved assignment and supplies its complete pinned load responses and needed supporting responses in the existing executor task context, alongside accepted constraints, exclusions, and required verification. This is the default handoff even when executor MCP tools exist; the spec/plan retains only compact references and decisions. Mark an assignment with no relevant skill explicitly, and report unavailable guidance separately. Discovery during the interview never starts execution; preserve the ordinary handoff and approval gates.

If a pinned release cannot be read, state that limitation and continue questions that can be answered from available evidence. Do not replace a previously agreed skill version without explaining the change and reconciling its effect on scope.
