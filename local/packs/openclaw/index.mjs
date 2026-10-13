// gisool capture plugin: forwards each agent run's prompt to the local gisool daemon.
// Needs plugins.entries.gisool.hooks.allowConversationAccess: true in the OpenClaw config.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const here = new URL(".", import.meta.url);

function loadPort(env) {
  if (env.GISOOL_PORT) return Number(env.GISOOL_PORT);
  try {
    return Number(JSON.parse(readFileSync(new URL("gisool.json", here), "utf8")).port);
  } catch {
    return NaN;
  }
}

/** Fire-and-forget POST; never throws, never awaited by the hook. */
export function forward(payload, env = process.env) {
  try {
    const port = loadPort(env);
    const token = readFileSync(join(env.GISOOL_HOME || join(homedir(), ".gisool"), "token"), "utf8").trim();
    if (!Number.isInteger(port) || !token) return;
    fetch(`http://127.0.0.1:${port}/ingest/hook/openclaw`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(2000),
    }).catch(() => {});
  } catch {
    // capture must never affect the agent run
  }
}

export function register(api, env = process.env) {
  if (typeof api.on === "function") {
    api.on("before_agent_run", (event, ctx) => {
      forward({ event: "before_agent_run", prompt: event?.prompt ?? null, sessionKey: ctx?.sessionKey, sessionId: ctx?.sessionId }, env);
    });
  } else if (typeof api.registerHook === "function") {
    api.registerHook("message:received", (event) => {
      forward({ event: "message_received", via: "message_received", prompt: event?.context?.content ?? null, sessionKey: event?.sessionKey }, env);
    });
  }
}

export default { id: "gisool", name: "gisool", description: "Capture prompts for the local gisool skill router.", register };
