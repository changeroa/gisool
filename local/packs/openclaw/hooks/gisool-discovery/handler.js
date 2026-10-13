import { join } from "node:path";

export const marker = "<gisool-discovery>";
export const guidance = `${marker}
Before substantive work on a new actionable task, use the gisool search_skills tool
(MCP server "gisool") with 2-5 subject/outcome terms. Search is not activation:
check relevance and invocation, then load only a relevant result's exact URI and
read its complete instructions. If results are empty or unrelated, retry once with
a shorter subject, then proceed. Greetings and unchanged-task continuations need no
new search. Respect a user ban on skill lookup. If the tools are unavailable, say so
briefly and continue.
</gisool-discovery>`;

export default function handler(event) {
  if (event.type !== "agent" || event.action !== "bootstrap") return;
  const files = event.context?.bootstrapFiles;
  if (!Array.isArray(files)) return;
  if (files.some(file => file.content?.includes(marker))) return;
  const index = files.findIndex(file => file.name === "AGENTS.md");
  if (index >= 0) {
    const file = files[index];
    files[index] = { ...file, content: [file.content, guidance].filter(Boolean).join("\n\n"), missing: false };
  } else if (event.context.workspaceDir) {
    files.push({ name: "AGENTS.md", path: join(event.context.workspaceDir, "AGENTS.md"), content: guidance, missing: false });
  }
}
