import { readFileSync } from "node:fs";

const guidance = readFileSync(new URL("./discovery.md", import.meta.url), "utf8").trim();
const marker = "<gisul-discovery>";

// OmO 5's Senpi engine discovers extensions, but no longer discovers
// APPEND_SYSTEM.md. Chain the current prompt so other extensions keep their work.
export default function gisul(pi) {
  pi.on("before_agent_start", event => {
    if (event.systemPrompt.includes(marker)) return;
    return { systemPrompt: `${event.systemPrompt}\n\n${marker}\n${guidance}\n</gisul-discovery>` };
  }, { previewSafe: true });
}
