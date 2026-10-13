import assert from "node:assert/strict";
import { test } from "node:test";
import { distImport } from "./_helpers.mjs";

const { runtimeFromClientName } = await distImport("ingest/runtimes.js");
const { searchEvent, loadEvent, readFileEvent, errorEvent } = await distImport("ingest/mcp-recorder.js");
const NOW = 1_800_000_000_000;

test("clientInfo name -> RuntimeId table", () => {
  const table = {
    "claude-code": "claude-code", "codex-mcp-client": "codex", "gemini-cli-mcp-client": "gemini", "cursor-vscode": "cursor", cursor: "cursor",
    "senpi-mcp-client": "omo", opencode: "omo", "gjc-coding-agent": "gajae", "my-openclaw-bridge": "openclaw", "random-client": "unknown",
  };
  for (const [name, runtime] of Object.entries(table)) assert.equal(runtimeFromClientName(name), runtime, name);
  assert.equal(runtimeFromClientName(undefined), "unknown");
});

const outcome = { traceId: "tr1", query: "write a commit message", mode: "discovery", elapsedMs: 3,
  candidates: [{ uri: "skill://local/a/commit/SKILL.md", name: "commit", description: "d", score: 0.9, rank: 1, invocation: "automatic", digest: "x", matched: ["commit"] }] };

test("Codex search: threadId -> conversationId, sessionId -> runtimeSessionId, transport session in data", () => {
  const e = searchEvent({ clientName: "codex-mcp-client", mcpSessionId: "mcp-1", meta: { threadId: "t1", sessionId: "t1", callId: "c1" } }, outcome, { total: 1 }, NOW);
  assert.equal(e.kind, "search");
  assert.equal(e.source, "mcp");
  assert.deepEqual(e.ref, { runtime: "codex", clientName: "codex-mcp-client", runtimeSessionId: "t1", conversationId: "t1" });
  assert.equal(e.traceId, "tr1");
  assert.equal(e.text, "write a commit message");
  assert.equal(e.data.mcpSessionId, "mcp-1");
  assert.equal(e.data.total, 1);
  assert.equal(e.data.candidates[0].score, 0.9);
  assert.deepEqual(e.data.chosen, []);
});

test("Claude toolUseId and OpenCode sessionID vendor meta", () => {
  const c = searchEvent({ clientName: "claude-code", meta: { "claudecode/toolUseId": "tu9" } }, outcome, { total: 1 }, NOW);
  assert.equal(c.toolUseId, "tu9");
  assert.deepEqual(c.ref, { runtime: "claude-code", clientName: "claude-code" });
  const o = loadEvent({ clientName: "opencode", meta: { "ai.opencode/sessionID": "ses_1" } }, { uri: "skill://local/a/commit/SKILL.md", loadId: "L1", manifestDigest: "m", traceId: "tr1" }, NOW);
  assert.deepEqual(o.ref, { runtime: "omo", clientName: "opencode", runtimeSessionId: "ses_1" });
  assert.deepEqual([o.kind, o.loadId, o.traceId, o.skillUri, o.data.manifestDigest], ["load", "L1", "tr1", "skill://local/a/commit/SKILL.md", "m"]);
});

test("read_file and error events", () => {
  const r = readFileEvent({ clientName: "gemini-cli-mcp-client" }, { skillUri: "skill://local/a/commit/SKILL.md", uri: "skill://local/a/commit/ref.md", bytes: 42, loadId: "L1" }, NOW);
  assert.deepEqual([r.kind, r.loadId, r.data.bytes, r.ref.runtime], ["read_file", "L1", 42, "gemini"]);
  const err = errorEvent({ clientName: "gjc-coding-agent" }, { code: "skill_changed_since_load", message: "changed", tool: "read_skill_file", loadId: "L1" }, NOW);
  assert.deepEqual([err.kind, err.data.code, err.ref.runtime], ["error", "skill_changed_since_load", "gajae"]);
});
