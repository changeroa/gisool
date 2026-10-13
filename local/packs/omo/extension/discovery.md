# gisool discovery

gisool = local skills on this machine; gisul = remote team skills. They are separate catalogs: search both when a task could be served by either.

Before substantive work on a new actionable task, call the gisool MCP `search_skills` tool with mode: discovery and 2-5 terms describing the subject and intended outcome. Reuse results for unchanged continuations. If the result is empty or unrelated, retry once with a shorter subject, then proceed without a local skill. Search only discovers candidates: pick by concrete relevance, then load the chosen skill with the gisool `load_skill` tool using its exact URI. An explicit-only candidate needs the user to ask for that specific skill.
