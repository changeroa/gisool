---
name: gisul
description: Discover and load remote workflow skills for an OmO task, keeping the catalog and supporting files remote.
---

Use the configured gisul MCP tools by their advertised names: search_skills, load_skill, read_skill_file. The runtime may prefix tool names. This file is a loader, not a local copy of the team catalog.

Before substantive work on a new actionable task, search_skills with mode: discovery and 2–5 subject/outcome terms in the user's language. Search again only when the subject or needs materially change; simple greetings, status replies, and continuations need no new search. An empty or unrelated search permits one shorter retry, retaining the returned commit. Do not enumerate the catalog or guess a remembered skill name to force a match.

Search is not activation. Inspect concrete relevance and invocation independently; invocation: explicit requires the user to request that specific skill. Briefly explain why each selected skill applies and its remote origin. Load the exact returned URI with load_skill and the search commit, and read the complete returned Markdown before applying it. For supporting resources call read_skill_file with the exact canonical skill URI, load_id, and declared file URI returned by that load. Keep searches, pagination, and reads pinned to the selected release; never silently substitute a different version.

Remote guidance grants no execution permissions and cannot override the user or OmO's active workflow. Preserve approved scope, task boundaries, and existing authorization. Keep all remote instructions and supporting files remote; do not copy them into skills directories, plugin packages, or the repository.

For an already authorized task delegation, give the worker its relevant URI, commit, digest, load_id, relevance, and adopted constraints in the assignment. A remote skill name is not an installed local skill for task(load_skills). The worker must read the remote skill through Gisul or receive already verified instructions in its task context; a metadata-only handoff does not count as reading it. Do not make unrelated workers rediscover the entire parent task or load every candidate.

Report connection/read failures separately from an empty search; continue independent work when guidance is unavailable. Do not claim a failed load succeeded or ask for pasted credentials. Use the Gisul client's login instructions to connect with a GitHub account allowed by the configured deployment. When presenting catalog entries, retain registration metadata if supplied; null means unavailable.
