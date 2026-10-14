// Sessions whose first prompt a harness or the runtime sent, not a person; views hide them unless asked.
export type AutomationRule = { id: string; label: string; test: RegExp };

export const AUTOMATION_RULES: readonly AutomationRule[] = [
  // Codex TUI opens a side conversation per thread to name it.
  { id: "codex_title", label: "Codex thread title", test: /^\s*Generate a concise, single-line task title\b/ },
  // Herdr asks an agent to recap a pane: the prompt is a JSON object that starts with previousRecap.
  { id: "herdr_recap", label: "Herdr pane recap", test: /^\s*\{\s*"previousRecap"\s*:/ },
  // OpenClaw scheduled jobs prefix the prompt with the cron job id and name.
  { id: "cron_job", label: "Scheduled job", test: /^\s*\[cron:[0-9a-f-]{36} / },
  // OmO memory reflection runs open with the reflection run file.
  { id: "memory_reflection", label: "Memory reflection", test: /^\s*<file name="[^"]*\/runtime\/reflection\// },
  // Memory consolidation ("dreaming") turns fragments into a diary entry.
  { id: "memory_dream", label: "Memory dream", test: /^\s*Write a dream diary entry from these memory fragments/ },
];

export const NO_ACTIVITY = "no_activity";

export function automationOf(firstPrompt: string | undefined): string | undefined {
  if (!firstPrompt) return undefined;
  return AUTOMATION_RULES.find((rule) => rule.test.test(firstPrompt))?.id;
}
