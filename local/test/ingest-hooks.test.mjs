import assert from "node:assert/strict";
import { test } from "node:test";
import { distImport } from "./_helpers.mjs";
import { fixture } from "./helpers/ingest.mjs";

const { normalizeHook } = await distImport("ingest/hooks.js");
const NOW = 1_800_000_000_000;

function one(runtime, name) {
  const { events, bindings } = normalizeHook(runtime, fixture(name), NOW);
  assert.equal(events.length, 1, name);
  assert.deepEqual(bindings, []);
  assert.equal(events[0].source, "hook");
  assert.equal(events[0].ts, NOW);
  return events[0];
}

test("claude-code UserPromptSubmit -> prompt with session_id and cwd", () => {
  const e = one("claude-code", "claude-hook-user-prompt-submit.json");
  assert.equal(e.kind, "prompt");
  assert.deepEqual(e.ref, { runtime: "claude-code", runtimeSessionId: "claude-sess-1", cwd: "/work/app" });
  assert.equal(e.text, "Refactor the login form");
  assert.equal(e.data.promptId, "p-1");
});

test("claude-code SessionStart / SessionEnd", () => {
  assert.equal(one("claude-code", "claude-hook-session-start.json").kind, "session_start");
  assert.equal(one("claude-code", "claude-hook-session-end.json").kind, "session_end");
});

test("claude-code PostToolUse Skill -> native_skill via tool", () => {
  const e = one("claude-code", "claude-hook-post-tool-use-skill.json");
  assert.equal(e.kind, "native_skill");
  assert.deepEqual([e.data.name, e.data.via, e.toolUseId], ["commit-helper", "tool", "toolu_skill_1"]);
});

test("claude-code PostToolUse Read of SKILL.md -> native_skill via file_read", () => {
  const e = one("claude-code", "claude-hook-post-tool-use-read-skill.json");
  assert.deepEqual([e.kind, e.data.name, e.data.via], ["native_skill", "db-query", "file_read"]);
});

test("claude-code PostToolUse Read of another file -> nothing", () => {
  const payload = { ...fixture("claude-hook-post-tool-use-read-skill.json"), tool_input: { file_path: "/x/src/SKILL.md.bak" } };
  assert.deepEqual(normalizeHook("claude-code", payload, NOW), { events: [], bindings: [] });
});

test("claude-code UserPromptExpansion slash_command -> native_skill via expansion", () => {
  const e = one("claude-code", "claude-hook-user-prompt-expansion.json");
  assert.deepEqual([e.kind, e.data.name, e.data.via], ["native_skill", "example-skill", "expansion"]);
  const mcp = { ...fixture("claude-hook-user-prompt-expansion.json"), expansion_type: "mcp_prompt" };
  assert.equal(normalizeHook("claude-code", mcp, NOW).events.length, 0);
});

test("claude-code PostToolUse for mcp__gisool__* -> tool_use_id binding, no event", () => {
  const { events, bindings } = normalizeHook("claude-code", fixture("claude-hook-post-tool-use-gisool.json"), NOW);
  assert.deepEqual(events, []);
  assert.deepEqual(bindings, [{ toolUseId: "tu1", ref: { runtime: "claude-code", runtimeSessionId: "s1", cwd: "/work/app" } }]);
});

test("codex UserPromptSubmit -> prompt with session_id and turn_id", () => {
  const e = one("codex", "codex-hook-user-prompt-submit.json");
  assert.equal(e.kind, "prompt");
  assert.deepEqual(e.ref, { runtime: "codex", runtimeSessionId: "codex-sess-1", cwd: "/work/api" });
  assert.equal(e.text, "Add pagination to the users endpoint");
  assert.equal(e.data.turnId, "turn-7");
});

test("codex PostToolUse Bash reading SKILL.md -> native_skill via file_read", () => {
  const e = one("codex", "codex-hook-post-tool-use-bash-skill.json");
  assert.deepEqual([e.kind, e.data.name, e.data.via], ["native_skill", "api-pagination", "file_read"]);
});

test("gemini BeforeAgent -> prompt; AfterTool activate_skill -> native_skill", () => {
  const p = one("gemini", "gemini-hook-before-agent.json");
  assert.deepEqual([p.kind, p.text], ["prompt", "Explain the build pipeline"]);
  assert.deepEqual(p.ref, { runtime: "gemini", runtimeSessionId: "gemini-sess-1", cwd: "/work/web" });
  const s = one("gemini", "gemini-hook-after-tool-activate-skill.json");
  assert.deepEqual([s.kind, s.data.name, s.data.via], ["native_skill", "ci-debug", "tool"]);
});

test("cursor beforeSubmitPrompt -> prompt keyed by conversation_id; sessionStart", () => {
  const p = one("cursor", "cursor-hook-before-submit-prompt.json");
  assert.deepEqual([p.kind, p.text], ["prompt", "Make the header sticky"]);
  assert.deepEqual(p.ref, { runtime: "cursor", conversationId: "cursor-conv-1", cwd: "/work/site" });
  assert.equal(one("cursor", "cursor-hook-session-start.json").kind, "session_start");
});

test("omo and gajae before_agent_start forwarders", () => {
  const o = one("omo", "omo-hook-before-agent-start.json");
  assert.deepEqual([o.kind, o.text], ["prompt", "Draft release notes"]);
  assert.deepEqual(o.ref, { runtime: "omo", runtimeSessionId: "omo-sess-1", cwd: "/work/omo" });
  const g = one("gajae", "gajae-hook-before-agent-start.json");
  assert.equal(g.kind, "prompt");
  assert.equal(g.text, undefined);
  assert.equal(g.data.promptUnavailable, true);
  assert.deepEqual(g.ref, { runtime: "gajae", runtimeSessionId: "gjc-sess-1", cwd: "/work/gjc" });
});

test("openclaw before_agent_run forwarder", () => {
  const e = one("openclaw", "openclaw-hook-before-agent-run.json");
  assert.deepEqual([e.kind, e.text, e.data.sessionKey], ["prompt", "Summarize my inbox", "agent:main:main"]);
  assert.deepEqual(e.ref, { runtime: "openclaw", runtimeSessionId: "oc-sess-1" });
});

test("unrecognized hook events and runtimes yield nothing", () => {
  assert.equal(normalizeHook("claude-code", { hook_event_name: "Stop", session_id: "x" }, NOW).events.length, 0);
  assert.equal(normalizeHook("omo", { event: "agent_end" }, NOW).events.length, 0);
  assert.equal(normalizeHook("unknown", fixture("claude-hook-user-prompt-submit.json"), NOW).events.length, 0);
});
