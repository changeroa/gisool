export const SEARCH_TOOL_GUIDANCE =
  "Rewrite the user's task as a short English intent sentence using skill vocabulary (Korean is accepted). Do not pass skill bodies. Use mode=discovery.";

export const ABSTAIN_HINTS = {
  empty_query: "Describe the task as an intent sentence",
  no_overlap: "No skill shares vocabulary with this query; rewrite it with skill vocabulary or continue without a skill",
  below_threshold: "Matches are too weak; rephrase as a short intent sentence or continue without a skill",
  explicit_only: "Only explicit-invocation skills matched; ask the user or search with mode=explicit",
} as const;
