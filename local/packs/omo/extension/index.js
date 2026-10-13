import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const RUNTIME = "omo";
const MARKER = "<gisool-discovery>";
const readText = url => { try { return readFileSync(url, "utf8"); } catch { return ""; } };

const guidance = readText(new URL("./discovery.md", import.meta.url)).trim();
let configured = {};
try { configured = JSON.parse(readText(new URL("./config.json", import.meta.url))); } catch {}
const port = process.env.GISOOL_PORT || configured.port || 8799;
const url = `http://127.0.0.1:${port}/ingest/hook/${RUNTIME}`;
// Read once at module load; never on the agent path.
const token = readText(join(process.env.GISOOL_HOME || join(homedir(), ".gisool"), "token")).trim();

function forward(event, ctx) {
  const prompt = typeof event.prompt === "string" ? event.prompt : null;
  const body = {
    event: "before_agent_start",
    prompt,
    sessionId: ctx?.sessionManager?.getSessionId?.(),
    cwd: ctx?.cwd ?? process.cwd(),
  };
  if (prompt === null) body.promptUnavailable = true;
  // Fire-and-forget: the agent path never waits on gisool.
  fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(2000),
  }).catch(() => {});
}

export default function gisool(pi) {
  pi.on("before_agent_start", (event, ctx) => {
    if (!event || event.preview === true) return event;
    try { forward(event, ctx); } catch {}
    if (guidance && typeof event.systemPrompt === "string" && !event.systemPrompt.includes(MARKER)) {
      event.systemPrompt = `${event.systemPrompt}\n\n${MARKER}\n${guidance}\n</gisool-discovery>`;
    }
    return event;
  }, { previewSafe: true });
}
