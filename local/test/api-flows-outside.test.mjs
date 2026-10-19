import assert from "node:assert/strict";
import { join } from "node:path";
import test, { before, after } from "node:test";
import { distImport } from "./_helpers.mjs";
import { bearer, http, jsonHeaders, startTestServer } from "./helpers/api.mjs";
import { DAY, NOW as T } from "./helpers/store.mjs";

const { openDb } = await distImport("store/db.js");
const { createStore } = await distImport("store/index.js");
const AUTO = "Generate a concise, single-line task title for this conversation.";
let server;
let ids;
const socket = process.env.GISOOL_HERDR_SOCKET;
before(async () => {
  process.env.GISOOL_HERDR_SOCKET = "/nonexistent";
  server = await startTestServer();
  const db = openDb(join(server.gisoolHome, "gisool.db"));
  const store = createStore(db, { now: () => T });
  ids = {};
  try {
    for (const [key, ts, prompt] of [
      ["human", T - 500, "debug the service"],
      ["unlinked", T - 400, "check the logs"],
      ["linked", T - 300, "write tests"],
      ...Array.from({ length: 101 }, (_, i) => [`auto-${i}`, T + i, AUTO]),
    ]) {
      const ref = { runtime: "claude-code", runtimeSessionId: key };
      const id = store.upsertSession(ref, ts);
      store.append({ id: `prompt-${key}`, kind: "prompt", ts, text: prompt, textLength: prompt.length,
        source: "hook", data: {}, ref }, { sessionId: id, method: "runtime_id" });
      ids[key] = id;
    }
    // Latest activity, not session start, places this session first among the human sessions.
    store.append({ id: "later-human", kind: "native_skill", ts: T - 200, source: "otel",
      ref: { runtime: "claude-code", runtimeSessionId: "human" },
      data: { name: "debugging" } }, { sessionId: ids.human, method: "runtime_id" });
    db.prepare("INSERT INTO herdr_workspaces (id, created_ms) VALUES ('ws', ?)").run(T - 200);
    db.prepare("INSERT INTO herdr_panes (id, workspace_id) VALUES ('pane', 'ws')").run();
    const link = db.prepare(`INSERT INTO pane_sessions
      (pane_id, agent, source, agent_session_value, session_id) VALUES ('pane', 'claude', ?, ?, ?)`);
    link.run("unlinked", "unlinked", ids.unlinked);
    link.run("herdr:reported", "linked", ids.linked);
  } finally { store.close(); }
});
after(async () => {
  await server?.stop();
  if (socket === undefined) delete process.env.GISOOL_HERDR_SOCKET;
  else process.env.GISOOL_HERDR_SOCKET = socket;
});
const get = (path) => http(server.port, { path, headers: bearer(server.token) });
const range = `from=${T - DAY}&to=${T + DAY}`;

test("ingested sessions appear outside herdr when its socket is unavailable", async () => {
  // Given a daemon with no herdr connection; when the real hooks ingest a session and prompt.
  for (const payload of [
    { hook_event_name: "SessionStart", session_id: "herdr-down" },
    { hook_event_name: "UserPromptSubmit", session_id: "herdr-down", prompt: "fix my service" },
  ]) {
    const res = await http(server.port, { method: "POST", path: "/ingest/hook/claude-code",
      headers: jsonHeaders(server.token), body: JSON.stringify(payload) });
    assert.equal(res.status, 202);
  }
  // Then both the list and the report expose the stored session without inventing a pane or spec.
  const sessions = await get("/api/sessions");
  const id = sessions.json.find((s) => s.firstPrompt === "fix my service").id;
  const list = await get("/api/flows?automated=include");
  const outside = list.json.flows.find((f) => f.id === "outside");
  assert.equal(outside.kind, "outside_herdr");
  assert.ok(outside.sessionIds.includes(id));
  assert.deepEqual(outside.paneIds, []);
  const report = await get("/api/flows/outside?automated=include");
  assert.equal(report.status, 200);
  assert.equal(report.json.spec, null);
  assert.equal(report.json.comparison, null);
  assert.deepEqual(report.json.tree.tabs, []);
  assert.ok(report.json.tree.sessions.some((s) => s.id === id && s.turns.length === 1));
  assert.ok(report.json.finding.sessions.some((s) => s.sessionId === id));
  assert.ok(report.json.usage.sessions.some((s) => s.sessionId === id));
});

test("outside herdr includes only unlinked sessions and filters automation before its cap", async () => {
  // Given more than a page of automated sessions and both linked and unlinked human sessions.
  // When the list excludes automated sessions, older eligible sessions must still be found.
  const list = await get(`/api/flows?${range}`);
  const outside = list.json.flows.find((f) => f.id === "outside");
  assert.deepEqual(outside.sessionIds, [ids.human, ids.unlinked]);
  assert.deepEqual(outside.counts, { panes: 0, sessions: 2 });
  assert.deepEqual(outside.attribution, { reported: 0, inferred: 0, unlinked: 2 });
  const report = await get(`/api/flows/outside?${range}`);
  assert.deepEqual(report.json.tree.sessions.map((s) => s.id), outside.sessionIds);
  for (const mode of ["include", "only"]) {
    const result = await get(`/api/flows?${range}&automated=${mode}`);
    const entry = result.json.flows.find((f) => f.id === "outside");
    assert.equal(entry.sessionIds.length, 100);
    assert.equal(entry.sessionIds[0], ids["auto-100"]);
    assert.ok(!entry.sessionIds.includes(ids.linked));
    const detail = await get(`/api/flows/outside?${range}&automated=${mode}`);
    assert.deepEqual(detail.json.tree.sessions.map((s) => s.id), entry.sessionIds);
  }
});

test("outside herdr shares cursor ordering and half-open activity ranges with other entries", async () => {
  // Given outside and workspace entries with equal ordering times.
  // When paging, the stable id breaks ties without repeating or dropping either entry.
  const first = await get(`/api/flows?${range}&limit=1`);
  assert.deepEqual(first.json.flows.map((f) => f.id), ["outside"]);
  assert.equal(typeof first.json.nextCursor, "string");
  const next = await get(`/api/flows?${range}&limit=1&cursor=${first.json.nextCursor}`);
  assert.deepEqual(next.json.flows.map((f) => f.id), ["ws:ws"]);
  assert.equal(next.json.nextCursor, null);
  const window = `from=${T - 400}&to=${T - 200}`;
  const list = await get(`/api/flows?${window}`);
  assert.deepEqual(list.json.flows.find((f) => f.id === "outside").sessionIds, [ids.unlinked]);
  const detail = await get(`/api/flows/outside?${window}&limit=1`);
  assert.deepEqual(detail.json.tree.sessions.map((s) => s.id), [ids.unlinked]);
  const empty = await get(`/api/flows?from=${T + 200}&to=${T + 300}`);
  assert.deepEqual(empty.json.flows, []);
  const wide = await get(`/api/flows/outside?from=0&to=${T + DAY}`);
  assert.equal(wide.status, 200);
  assert.deepEqual(wide.json.tree.sessions.map((s) => s.id), [ids.human, ids.unlinked]);
});
