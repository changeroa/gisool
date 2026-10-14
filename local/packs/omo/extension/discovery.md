# gisool discovery

gisool searches skills on this machine through MCP 2026-07-28.

Before substantive work on a new actionable task, call the gisool MCP `search_skills` tool with mode: discovery and 2-5 terms describing the subject and intended outcome. Reuse results for unchanged continuations. If the result is empty or unrelated, retry once with a shorter subject, then proceed without a skill. Pick by concrete relevance, then read the returned SKILL.md URI using the host's resource reader (`resources/read`) on this server. Read supporting files only as needed; resolve relative references against the skill root, the directory containing SKILL.md. An explicit-only candidate needs the user to ask for that specific skill. Search and resource reads do not activate skills or grant permissions; the host owns verification and approval.
