import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { distImport, makeSandbox } from "./_helpers.mjs";
import { http, jsonHeaders } from "./helpers/api.mjs";
import { modernClient } from "./helpers/mcp.mjs";

const { openDb } = await distImport("store/db.js");
const { startHerdrSync } = await distImport("herdr/sync.js");
const { resolveHerdrSocket, createHerdrClient } = await distImport("herdr/client.js");
const { startServer } = await distImport("server.js");
// Deadlines remain real when recovery tests advance the production retry clock.
const deadlineTimeout = globalThis.setTimeout;
const cancelDeadline = globalThis.clearTimeout;

function signal(emitter, event, predicate = () => true, action = () => {}) {
  return new Promise((resolve, reject) => {
    const timer = deadlineTimeout(() => { cleanup(); reject(new Error(`No ${event} signal`)); }, 8_000);
    const cleanup = () => { cancelDeadline(timer); emitter.off(event, listener); };
    const listener = (...args) => {
      try {
        if (!predicate(...args)) return;
        cleanup();
        resolve(args);
      } catch (error) { cleanup(); reject(error); }
    };
    emitter.on(event, listener);
    action();
  });
}

const pane = (id, extra = {}) => ({ pane_id: id, workspace_id: "w1", tab_id: "w1:t1", ...extra });
const topology = (panes) => ({
  workspaces: [{ workspace_id: "w1", label: "QA" }],
  tabs: [{ tab_id: "w1:t1", workspace_id: "w1", label: "tests" }],
  panes,
});

async function fakeHerdr(t, snapshot) {
  // A short /tmp path stays below macOS sockaddr_un's 104-byte limit.
  const dir = mkdtempSync("/tmp/gst-herdr-");
  const path = join(dir, "s");
  const events = new EventEmitter();
  const sockets = new Set();
  const requests = [];
  let server;
  let current = snapshot;
  let corrupt = false;
  let hold = false;
  const held = [];
  const send = (socket, id, result) => {
    const line = `${JSON.stringify({ id, result })}\n`;
    if (result.type === "subscription_started") socket.write(line);
    else socket.end(line);
  };
  const start = async () => {
    server = createServer((socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      socket.on("error", () => {});
      let buffer = "";
      socket.setEncoding("utf8");
      socket.on("data", (chunk) => {
        buffer += chunk;
        let i;
        while ((i = buffer.indexOf("\n")) !== -1) {
          const req = JSON.parse(buffer.slice(0, i));
          buffer = buffer.slice(i + 1);
          requests.push(req);
          switch (req.method) {
            case "ping": send(socket, req.id, { type: "pong" }); break;
            case "events.subscribe":
              send(socket, req.id, { type: "subscription_started" });
              break;
            case "session.snapshot": {
              const result = { type: "session_snapshot", snapshot: structuredClone(current) };
              if (hold) held.push(() => send(socket, req.id, result));
              else if (corrupt) {
                socket.write("garbage\nnull\n{\"event\":4}\n{\"id\":");
                socket.end(`${JSON.stringify(req.id)},\"result\":${JSON.stringify(result)}}\n`);
              } else send(socket, req.id, result);
              break;
            }
            default: assert.fail(`Mutating or unexpected method: ${req.method}`);
          }
          events.emit("request", req);
        }
      });
    });
    const listening = once(server, "listening");
    server.listen(path);
    await listening;
  };
  const stop = async () => {
    for (const socket of sockets) socket.destroy();
    if (server?.listening) await new Promise((resolve) => server.close(resolve));
  };
  await start();
  t.after(async () => { await stop(); rmSync(dir, { recursive: true, force: true }); });
  return {
    path, events, requests, start, stop,
    set snapshot(value) { current = value; },
    set corrupt(value) { corrupt = value; },
    set hold(value) { hold = value; },
    release() { for (const sendHeld of held.splice(0)) sendHeld(); },
    push(event, data) { for (const socket of sockets) socket.write(`${JSON.stringify({ event, data })}\n`); },
  };
}

async function follower(t, fake) {
  const db = openDb(":memory:");
  const changes = new EventEmitter();
  db.function("herdr_test_change", () => { changes.emit("change"); return 0; });
  for (const table of ["herdr_workspaces", "herdr_tabs", "herdr_panes", "pane_sessions"]) {
    for (const op of ["INSERT", "UPDATE"]) db.exec(`CREATE TEMP TRIGGER ${table}_${op} AFTER ${op} ON ${table} BEGIN SELECT herdr_test_change(); END`);
  }
  const logs = new EventEmitter();
  const messages = [];
  const connected = signal(logs, "log", (message) => message === "herdr connected");
  const sync = startHerdrSync(db, { env: { GISOOL_HERDR_SOCKET: fake.path }, log(message) { messages.push(message); logs.emit("log", message); } });
  t.after(() => { sync.close(); db.close(); });
  await connected;
  return { db, sync, changes, logs, messages };
}

function session(db, id, { runtime = "codex", runtimeId = null, conversation = null, cwd = null, start = Date.now() } = {}) {
  db.prepare("INSERT INTO sessions (id, runtime, runtime_session_id, conversation_id, cwd, started_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(id, runtime, runtimeId, conversation, cwd, start);
}

async function followedServer(t, fake, discoveryDir) {
  const sb = makeSandbox();
  const previous = Object.fromEntries(["GISOOL_HERDR", "GISOOL_HERDR_SOCKET", "PATH"].map((key) => [key, process.env[key]]));
  process.env.GISOOL_HERDR = "on";
  if (discoveryDir) {
    process.env.PATH = discoveryDir;
    delete process.env.GISOOL_HERDR_SOCKET;
  } else process.env.GISOOL_HERDR_SOCKET = fake.path;
  let server, db;
  t.after(async () => {
    db?.close();
    await server?.close();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    sb.cleanup();
  });
  const logs = new EventEmitter(), messages = [];
  const ready = signal(logs, "log", (message) => message === (discoveryDir ? "herdr unreachable" : "herdr connected"));
  server = await startServer({ port: 0, captureLevel: "full", retentionDays: null, roots: [], runtimes: {} }, {
    gisoolHome: sb.env.GISOOL_HOME, handleSignals: false, fsWatchdog: { intervalMs: 1e9 },
    log(message) { messages.push(message); logs.emit("log", message); },
  });
  await ready;
  db = openDb(join(sb.env.GISOOL_HOME, "gisool.db"));
  const token = readFileSync(join(sb.env.GISOOL_HOME, "token"), "utf8").trim();
  return { server, db, token, logs, messages };
}

test("discovery recovers when herdr appears after startup and resolves a new socket on reconnect", async (t) => {
  // Given a healthy daemon with no override and no discoverable executable.
  const fake = await fakeHerdr(t, topology([pane("late")]));
  const dir = mkdtempSync("/tmp/gst-discovery-");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const { server, db, logs, messages } = await followedServer(t, fake, dir);
  assert.equal((await http(server.port, { path: "/healthz" })).status, 200);
  assert.equal(fake.requests.length, 0);
  assert.match(messages.find((message) => message.startsWith("herdr failure:")), /ENOENT/);
  // When discovery becomes available without restarting the daemon.
  const executable = join(dir, "herdr");
  writeFileSync(executable, `#!/bin/sh\nprintf 'socket: ${fake.path}\\n'\n`, { mode: 0o700 });
  assert.equal(await resolveHerdrSocket(), fake.path);
  await signal(logs, "log", (message) => message === "herdr connected", () => t.mock.timers.tick(120_000));
  // Then the recovered snapshot is stored, and the next reconnect rediscovers a moved socket.
  assert.equal(db.prepare("SELECT id FROM herdr_panes WHERE closed_ms IS NULL").get().id, "late");
  const moved = await fakeHerdr(t, topology([pane("moved")]));
  writeFileSync(executable, `#!/bin/sh\nprintf 'socket: ${moved.path}\\n'\n`, { mode: 0o700 });
  const unreachable = signal(logs, "log", (message) => message === "herdr unreachable");
  await fake.stop();
  await unreachable;
  await signal(logs, "log", (message) => message === "herdr connected", () => t.mock.timers.tick(1_000));
  assert.equal(db.prepare("SELECT id FROM herdr_panes WHERE closed_ms IS NULL").get().id, "moved");
  assert.deepEqual(messages.filter((message) => message.startsWith("herdr ")),
    [messages.find((message) => message.startsWith("herdr failure:")), "herdr unreachable", "herdr connected", "herdr unreachable", "herdr connected"]);
});

test("binding-only hook links reported and cwd sessions before any ordinary event", async (t) => {
  // Given a reported identity and a cwd-only pane, with reconciliation frozen.
  const fake = await fakeHerdr(t, topology([
    pane("reported", { agent_session: { agent: "claude", kind: "id", source: "hook", value: "binding-first" } }),
    pane("cwd", { agent: "claude", cwd: "/binding", created_ms: 0 }),
  ]));
  t.mock.timers.enable({ apis: ["setInterval"] });
  const { server, db, token } = await followedServer(t, fake);
  // When a supported binding-only PostToolUse arrives before its MCP event.
  const res = await http(server.port, { method: "POST", path: "/ingest/hook/claude-code", headers: jsonHeaders(token),
    body: JSON.stringify({ hook_event_name: "PostToolUse", tool_name: "mcp__gisool__search_skills",
      tool_use_id: "unseen-tool", session_id: "binding-first", cwd: "/binding" }) });
  // Then the reported identity wins despite no event publication, new snapshot, or SessionStart.
  assert.equal(res.status, 202);
  const row = db.prepare("SELECT id FROM sessions WHERE runtime_session_id = 'binding-first'").get();
  assert.ok(row);
  assert.deepEqual(db.prepare("SELECT pane_id, session_id FROM pane_sessions ORDER BY pane_id").all().map((r) => ({ ...r })),
    [{ pane_id: "reported", session_id: row.id }]);
  assert.equal(db.prepare("SELECT count(*) n FROM events").get().n, 0);
  assert.equal(fake.requests.filter((r) => r.method === "session.snapshot").length, 1);
});

test("binding-only hook links cwd when it updates an existing session", async (t) => {
  // Given a session whose cwd has not arrived yet and a matching cwd-only pane.
  const fake = await fakeHerdr(t, topology([pane("cwd", { cwd: "/updated", created_ms: 0 })]));
  t.mock.timers.enable({ apis: ["setInterval"] });
  const { server, db, token } = await followedServer(t, fake);
  session(db, "existing", { runtime: "claude-code", runtimeId: "binding-first", start: 1 });
  // When a binding supplies the missing cwd but publishes no event.
  const res = await http(server.port, { method: "POST", path: "/ingest/hook/claude-code", headers: jsonHeaders(token),
    body: JSON.stringify({ hook_event_name: "PostToolUse", tool_name: "mcp__gisool__search_skills",
      tool_use_id: "unseen-tool", session_id: "binding-first", cwd: "/updated" }) });
  // Then the existing session, not a replacement session, is linked immediately.
  assert.equal(res.status, 202);
  assert.equal(db.prepare("SELECT count(*) n FROM sessions").get().n, 1);
  assert.equal(db.prepare("SELECT session_id FROM pane_sessions WHERE pane_id = 'cwd'").get().session_id, "existing");
  assert.equal(fake.requests.filter((r) => r.method === "session.snapshot").length, 1);
});

test("ingest batch revisits its touched session outside the recent pane window", async (t) => {
  // Given a stored session and pane whose lifetime ended more than 24 hours ago.
  const fake = await fakeHerdr(t, topology([pane("old", { cwd: "/old", created_ms: 0 })]));
  t.mock.timers.enable({ apis: ["setInterval"] });
  const { server, db, token } = await followedServer(t, fake);
  db.prepare("UPDATE herdr_panes SET closed_ms = ?, last_seen_ms = ? WHERE id = 'old'").run(200, 200);
  session(db, "old-session", { runtime: "claude-code", runtimeId: "old-runtime", start: 100 });
  // When a binding-only ingest supplies that session's cwd, without a topology refresh.
  const res = await http(server.port, { method: "POST", path: "/ingest/hook/claude-code", headers: jsonHeaders(token),
    body: JSON.stringify({ hook_event_name: "PostToolUse", tool_name: "mcp__gisool__search_skills",
      tool_use_id: "old-tool", session_id: "old-runtime", cwd: "/old" }) });
  // Then the batch's session id is forwarded through server coalescing to the bounded linker.
  assert.equal(res.status, 202);
  assert.equal(db.prepare("SELECT session_id FROM pane_sessions WHERE pane_id = 'old'").get()?.session_id, "old-session");
  assert.equal(fake.requests.filter((r) => r.method === "session.snapshot").length, 1);
});

for (const channel of ["otlp", "mcp"]) {
  test(`${channel} ingest links a new session without waiting for reconciliation`, async (t) => {
    // Given an unlinked reported identity and no clock-driven reconciliations.
    const id = `${channel}-session`;
    const fake = await fakeHerdr(t, topology([pane("reported", {
      agent_session: { agent: "claude", kind: "id", source: "hook", value: id },
    })]));
    t.mock.timers.enable({ apis: ["setInterval"] });
    const { server, db, token } = await followedServer(t, fake);
    // When a session is created through the actual HTTP ingestion surface.
    if (channel === "otlp") {
      const body = JSON.parse(readFileSync(new URL("./fixtures/ingest/claude-otlp-user-prompt.json", import.meta.url), "utf8"));
      body.resourceLogs[0].scopeLogs[0].logRecords[0].attributes.find((a) => a.key === "session.id").value.stringValue = id;
      const res = await http(server.port, { method: "POST", path: "/ingest/otlp/v1/logs", headers: jsonHeaders(token), body: JSON.stringify(body) });
      assert.equal(res.status, 202);
    } else {
      const result = await modernClient(server.port, token, "claude-code").callTool({
        name: "search_skills", arguments: { query: "review", mode: "discovery" }, _meta: { sessionId: id },
      });
      assert.notEqual(result.isError, true);
    }
    // Then the link exists without another snapshot or an unrelated hook.
    const row = db.prepare("SELECT s.runtime_session_id FROM pane_sessions ps JOIN sessions s ON s.id = ps.session_id").get();
    assert.equal(row?.runtime_session_id, id);
    assert.equal(fake.requests.filter((r) => r.method === "session.snapshot").length, 1);
  });
}

test("30 second reconcile repairs all pending links even for panes absent from the new snapshot", async (t) => {
  // Given stored pending reported and inferred links, and a cwd-only live pane.
  const fake = await fakeHerdr(t, topology([
    pane("reported", { agent_session: { agent: "claude", kind: "id", source: "hook", value: "later" } }),
    pane("inferred", { cwd: "/inferred", created_ms: 0 }),
    pane("live-cwd", { cwd: "/live", created_ms: 0 }),
  ]));
  t.mock.timers.enable({ apis: ["setInterval"] });
  const { db, changes } = await follower(t, fake);
  db.prepare("INSERT INTO pane_sessions (pane_id, source, agent_session_value) VALUES ('inferred', 'inferred:cwd_time', 'later-inferred')").run();
  session(db, "later-reported", { runtime: "claude-code", runtimeId: "later" });
  session(db, "later-inferred", { cwd: "/inferred", start: 1 });
  session(db, "later-cwd", { cwd: "/live", start: 1 });
  fake.snapshot = topology([pane("live-cwd", { cwd: "/live", created_ms: 0 })]);
  // When reconciliation runs without any ingest notification or pushed event.
  await signal(changes, "change", () => db.prepare("SELECT count(*) n FROM pane_sessions WHERE session_id IS NOT NULL").get().n === 3,
    () => t.mock.timers.tick(30_000));
  // Then historical pending rows and the live cwd fallback are all linked.
  assert.deepEqual(db.prepare("SELECT pane_id, session_id FROM pane_sessions ORDER BY pane_id").all().map((r) => ({ ...r })), [
    { pane_id: "inferred", session_id: "later-inferred" },
    { pane_id: "live-cwd", session_id: "later-cwd" },
    { pane_id: "reported", session_id: "later-reported" },
  ]);
});

test("snapshot stores two panes and links a reported identity arriving after the snapshot", async (t) => {
  // Given two live panes, only one reports a usable session id.
  const fake = await fakeHerdr(t, topology([
    pane("w1:p1", { agent: "codex", agent_session: { agent: "codex", source: "otel", kind: "id", value: "codex-id" } }),
    pane("w1:p2", { agent: "pi" }),
  ]));
  const { db, sync } = await follower(t, fake);
  assert.equal(db.prepare("SELECT count(*) n FROM herdr_panes").get().n, 2);
  assert.equal(db.prepare("SELECT label FROM herdr_workspaces").get().label, "QA");
  assert.equal(db.prepare("SELECT label FROM herdr_tabs").get().label, "tests");
  assert.equal(db.prepare("SELECT session_id FROM pane_sessions").get().session_id, null);
  // When ingest supplies either supported identifier, linking no longer needs a socket event.
  session(db, "gisool-id", { conversation: "codex-id" });
  sync.linkSessions();
  // Then the foreign key points at the gisool session, not the herdr identity.
  assert.deepEqual({ ...db.prepare("SELECT session_id, source FROM pane_sessions").get() }, { session_id: "gisool-id", source: "herdr:otel" });
  const subs = fake.requests.find((r) => r.method === "events.subscribe").params.subscriptions;
  assert.equal(subs.length, 13);
  assert.ok(subs.some((s) => s.type === "pane.agent_status_changed"));
  assert.ok(subs.every((s) => !["pane.output_matched", "pane.scroll_changed"].includes(s.type)));
});

test("preseeded runtime identity links on the first snapshot", async (t) => {
  const fake = await fakeHerdr(t, topology([pane("w1:p1", { agent_session: { agent: "codex", kind: "id", source: "herdr:hook", value: "reported" } })]));
  const db = openDb(":memory:");
  session(db, "preseeded", { runtimeId: "reported" });
  const logs = new EventEmitter();
  const done = signal(logs, "log", (message) => message === "herdr connected");
  const sync = startHerdrSync(db, { env: { GISOOL_HERDR_SOCKET: fake.path }, log: (message) => logs.emit("log", message) });
  t.after(() => { sync.close(); db.close(); });
  await done;
  assert.equal(db.prepare("SELECT session_id FROM pane_sessions").get().session_id, "preseeded");
  assert.equal(db.prepare("SELECT source FROM pane_sessions").get().source, "herdr:hook");
});

test("matching or unknown agents link by cwd within lifetime, never without cwd", async (t) => {
  const fake = await fakeHerdr(t, topology([
    pane("claude", { agent: "claude", cwd: "/claude", created_ms: 100 }),
    pane("unknown", { cwd: "/unknown", created_ms: 100 }),
    pane("codex", { agent: "codex", cwd: "/codex", created_ms: 100, agent_session: { agent: "codex", kind: "path", source: "file", value: "/not-an-id" } }),
    pane("no-cwd", { agent: "codex" }),
    pane("reported", { cwd: "/claude", agent_session: { agent: "codex", kind: "id", source: "hook", value: "unmatched" } }),
  ]));
  const { db, sync } = await follower(t, fake);
  session(db, "too-old", { cwd: "/claude", start: 99 });
  for (const agent of ["claude", "unknown", "codex"]) session(db, `${agent}-session`, {
    runtime: agent === "claude" ? "claude-code" : "codex", cwd: `/${agent}`, start: 101,
  });
  sync.linkSessions();
  assert.deepEqual(db.prepare("SELECT pane_id, session_id, source FROM pane_sessions WHERE source = 'inferred:cwd_time' ORDER BY pane_id").all().map((r) => ({ ...r })), [
    { pane_id: "claude", session_id: "claude-session", source: "inferred:cwd_time" },
    { pane_id: "codex", session_id: "codex-session", source: "inferred:cwd_time" },
    { pane_id: "unknown", session_id: "unknown-session", source: "inferred:cwd_time" },
  ]);
  assert.equal(db.prepare("SELECT count(*) n FROM pane_sessions WHERE pane_id = 'no-cwd'").get().n, 0);
  assert.equal(db.prepare("SELECT session_id FROM pane_sessions WHERE pane_id = 'reported'").get().session_id, null);
});

const linkedPairs = (db) => db.prepare("SELECT pane_id, session_id, source FROM pane_sessions WHERE session_id IS NOT NULL ORDER BY pane_id, session_id")
  .all().map((row) => ({ ...row }));
const reportedIdentity = (value) => ({ agent: "codex", kind: "id", source: "hook", value });

test("two sequential Claude SessionStart hooks free a reused inferred pane", async (t) => {
  // Given a Claude pane with no reported identity and its first session still open.
  const fake = await fakeHerdr(t, topology([
    pane("reuse", { agent: "claude", cwd: "/reuse", created_ms: 0 }),
    pane("reserved", { agent: "claude", cwd: "/reuse", created_ms: 0,
      agent_session: { agent: "claude", kind: "id", source: "hook", value: "not-reported-yet" } }),
  ]));
  t.mock.timers.enable({ apis: ["setInterval"] });
  const { server, db, token } = await followedServer(t, fake);
  for (const key of ["first", "second"]) {
    const res = await http(server.port, { method: "POST", path: "/ingest/hook/claude-code", headers: jsonHeaders(token),
      body: JSON.stringify({ hook_event_name: "SessionStart", session_id: key, cwd: "/reuse" }) });
    assert.equal(res.status, 202);
    if (key === "first") db.exec("UPDATE sessions SET started_at = 1");
  }
  // Then both sessions are linked and the earlier reservation ends at the successor's start.
  const rows = db.prepare(`SELECT s.runtime_session_id AS key, s.started_at, s.ended_at, ps.pane_id
    FROM sessions s JOIN pane_sessions ps ON ps.session_id = s.id ORDER BY s.started_at`).all();
  assert.deepEqual(rows.map((row) => [row.key, row.pane_id]), [["first", "reuse"], ["second", "reuse"]]);
  assert.equal(rows[0].ended_at, rows[1].started_at);
  assert.equal(rows[1].ended_at, null);
});

test("SessionEnd ingestion sets ended_at and releases the inferred reservation", async (t) => {
  // Given a linked Claude session.
  const fake = await fakeHerdr(t, topology([pane("ended", { agent: "claude", cwd: "/ended", created_ms: 0 })]));
  const { server, db, token } = await followedServer(t, fake);
  for (const hook of ["SessionStart", "SessionEnd"]) {
    const res = await http(server.port, { method: "POST", path: "/ingest/hook/claude-code", headers: jsonHeaders(token),
      body: JSON.stringify({ hook_event_name: hook, session_id: "ended", cwd: "/ended", reason: "prompt_input_exit" }) });
    assert.equal(res.status, 202);
  }
  // Then the real hook event timestamp, not an invented timeout, is persisted as the end.
  const row = db.prepare(`SELECT s.ended_at, e.ts FROM sessions s JOIN events e ON e.session_id = s.id
    WHERE e.kind = 'session_end'`).get();
  assert.equal(row.ended_at, row.ts);
  assert.equal(typeof row.ended_at, "number");
  assert.equal(db.prepare("SELECT count(*) n FROM pane_sessions").get().n, 1);
});

for (const exit of ["pane_exited", "pane_agent_status_changed", "snapshot-agent-removed"]) {
  test(`${exit} ends the old session and frees the pane for later telemetry`, async (t) => {
    // Given an inferred session with no SessionEnd hook.
    const fake = await fakeHerdr(t, topology([pane("exit", { agent: "claude", cwd: "/exit", created_ms: 0 })]));
    const { db, sync, changes } = await follower(t, fake);
    session(db, "old", { runtime: "claude-code", cwd: "/exit", start: 100 });
    sync.linkSessions();
    // When herdr reports the agent's exit while retaining the pane.
    if (exit === "snapshot-agent-removed") {
      fake.snapshot = topology([pane("exit", { agent: null, cwd: "/exit", created_ms: 0 })]);
      await sync.reconcile();
    } else {
      await signal(changes, "change", () => db.prepare("SELECT ended_at FROM sessions WHERE id = 'old'").get().ended_at !== null,
        () => fake.push(exit, { pane_id: "exit", agent_status: "exited" }));
      await sync.reconcile();
    }
    const ended = db.prepare("SELECT ended_at FROM sessions WHERE id = 'old'").get().ended_at;
    assert.equal(typeof ended, "number");
    // Then a successor without a lifecycle hook can use the pane, and historical membership survives.
    session(db, "new", { runtime: "claude-code", cwd: "/exit", start: ended });
    sync.linkSessions();
    assert.deepEqual(linkedPairs(db).map((row) => [row.pane_id, row.session_id]), [["exit", "new"], ["exit", "old"]]);
  });
}

for (const order of [[0, 1], [1, 0]]) {
  test(`same-cwd sessions stay exclusive when reported identities arrive ${order.join(" then ")}`, async (t) => {
    // Given two same-cwd panes and overlapping sessions started three seconds apart.
    const base = Date.now() - 20_000;
    const panes = [
      pane("r2:p1", { cwd: "/r2", created_ms: base }),
      pane("r2:p2", { cwd: "/r2", created_ms: base + 3_000 }),
    ];
    const fake = await fakeHerdr(t, topology(panes));
    const { db, sync } = await follower(t, fake);
    session(db, "session-one", { cwd: "/r2", start: base + 6_000, runtimeId: "runtime-one" });
    sync.linkSessions();
    session(db, "session-two", { cwd: "/r2", start: base + 9_000, conversation: "runtime-two" });
    sync.linkSessions();
    assert.deepEqual(linkedPairs(db), []);
    // When reported identities correct the initially plausible but wrong inference, in either order.
    for (const index of order) {
      panes[index].agent_session = reportedIdentity(index === 0 ? "runtime-one" : "runtime-two");
      fake.snapshot = topology(panes);
      await sync.reconcile();
      const pairs = linkedPairs(db);
      assert.equal(pairs.filter((r) => r.session_id === (index === 0 ? "session-one" : "session-two")).length, 1);
      assert.equal(pairs.filter((r) => r.pane_id === panes[index].pane_id).length, 1);
    }
    // Then only fixture-known reported pairs remain across repeated reconcile and late ingest passes.
    const expected = [
      { pane_id: "r2:p1", session_id: "session-one", source: "herdr:hook" },
      { pane_id: "r2:p2", session_id: "session-two", source: "herdr:hook" },
    ];
    assert.deepEqual(linkedPairs(db), expected);
    await sync.reconcile();
    sync.linkSessions();
    assert.deepEqual(linkedPairs(db), expected);
  });
}

test("sequential sessions reuse one pane but overlapping sessions stay unlinked", async (t) => {
  // Given one pane, an ended session, its successor, and an overlapping third session.
  const fake = await fakeHerdr(t, topology([pane("sequential", { cwd: "/seq", created_ms: 100 })]));
  const { db, sync } = await follower(t, fake);
  session(db, "first", { cwd: "/seq", start: 101 });
  db.prepare("UPDATE sessions SET ended_at = 200 WHERE id = 'first'").run();
  session(db, "second", { cwd: "/seq", start: 200 });
  session(db, "overlapping", { cwd: "/seq", start: 201 });
  // When linking is repeated after all sessions have arrived.
  sync.linkSessions();
  sync.linkSessions();
  // Then sequential history remains and the overlapping session has no pane.
  assert.deepEqual(linkedPairs(db), [
    { pane_id: "sequential", session_id: "first", source: "inferred:cwd_time" },
    { pane_id: "sequential", session_id: "second", source: "inferred:cwd_time" },
  ]);
  assert.equal(db.prepare("SELECT count(*) n FROM pane_sessions WHERE session_id = 'overlapping'").get().n, 0);
});

test("equally close panes leave a session unlinked rather than guess", async (t) => {
  // Given two equally close candidates, including a pane first observed without a creation time.
  const clock = t.mock.method(Date, "now", () => 100);
  const fake = await fakeHerdr(t, topology([
    pane("tie:p1", { cwd: "/tie", created_ms: 100 }), pane("tie:p2", { cwd: "/tie" }),
  ]));
  const { db, sync } = await follower(t, fake);
  session(db, "tie-session", { cwd: "/tie", start: 101 });
  // When a late ingest pass and subsequent snapshot retry the ambiguous attribution.
  clock.mock.mockImplementation(() => 200);
  sync.linkSessions();
  await sync.reconcile();
  // Then no guessed relation is stored, and first-observed time remains stable.
  assert.deepEqual(linkedPairs(db), []);
  assert.equal(db.prepare("SELECT created_ms FROM herdr_panes WHERE id = 'tie:p2'").get().created_ms, 100);
});

test("late earlier sessions do not resolve ambiguous same-cwd panes by recency", async (t) => {
  // Given a later session ingested first with two eligible panes.
  const fake = await fakeHerdr(t, topology([
    pane("late:p1", { cwd: "/late-order", created_ms: 100 }),
    pane("late:p2", { cwd: "/late-order", created_ms: 200 }),
  ]));
  const { db, sync } = await follower(t, fake);
  session(db, "later", { cwd: "/late-order", start: 400 });
  sync.linkSessions();
  // When an earlier session arrives late.
  session(db, "earlier", { cwd: "/late-order", start: 300 });
  sync.linkSessions();
  // Then ambiguity remains regardless of ingest order.
  assert.deepEqual(linkedPairs(db), []);
});

for (const [name, first, second, expected] of [
  ["older matching agent beats newer shell", { agent: "claude" }, {}, "older"],
  ["matching runtime beats another agent", { agent: "claude" }, { agent: "codex" }, "older"],
  ["agent-session detection beats shell", { agent_session: { agent: "claude", kind: "path", source: "file", value: "/session" } }, {}, "older"],
  ["two matching agents remain ambiguous", { agent: "claude" }, { agent: "claude" }, null],
  ["two unmatched agents remain ambiguous", { agent: "codex" }, { agent: "pi" }, null],
  ["two shells remain ambiguous", {}, {}, null],
  ["unmatched agent plus shell abstains", { agent: "pi" }, {}, null],
  ["wrong known runtime plus shell abstains", { agent: "codex" }, {}, null],
]) {
  test(`same-cwd inference: ${name}`, async (t) => {
    // Given two simultaneously live panes with different creation times.
    const fake = await fakeHerdr(t, topology([
      pane("older", { cwd: "/same", created_ms: 100, ...first }),
      pane("newer", { cwd: "/same", created_ms: 200, ...second }),
    ]));
    const { db, sync } = await follower(t, fake);
    session(db, "s", { runtime: "claude-code", cwd: "/same", start: 300 });
    // When the session is inferred from its cwd and runtime.
    sync.linkSessions(["s"]);
    // Then agent evidence wins only if it uniquely identifies a pane.
    assert.deepEqual(linkedPairs(db).map((row) => row.pane_id), expected ? [expected] : []);
  });
}

test("an occupied matching agent never redirects a concurrent session to a shell", async (t) => {
  // Given a matching Claude pane, a shell, and a linked session that has not ended.
  const fake = await fakeHerdr(t, topology([
    pane("matching", { agent: "claude", cwd: "/occupied", created_ms: 100 }),
    pane("shell", { cwd: "/occupied", created_ms: 100 }),
  ]));
  const { db, sync } = await follower(t, fake);
  session(db, "first", { runtime: "claude-code", cwd: "/occupied", start: 200 });
  sync.linkSessions();
  assert.deepEqual(linkedPairs(db).map((row) => [row.pane_id, row.session_id]), [["matching", "first"]]);
  // When a second concurrent session has no explicit successor-start or end signal.
  session(db, "second", { runtime: "claude-code", cwd: "/occupied", start: 300 });
  sync.linkSessions(["second"]);
  // Then the first attribution survives and the second remains unlinked, rather than taking the shell.
  assert.deepEqual(linkedPairs(db).map((row) => [row.pane_id, row.session_id]), [["matching", "first"]]);
});

test("a detected nonmatching runtime leaves a sole pane unlinked", async (t) => {
  // Given a pane whose detected runtime contradicts the session.
  const fake = await fakeHerdr(t, topology([pane("wrong", { agent: "codex", cwd: "/wrong", created_ms: 100 })]));
  const { db, sync } = await follower(t, fake);
  session(db, "claude", { runtime: "claude-code", cwd: "/wrong", start: 200 });
  // When no matching or unknown-runtime candidate exists.
  sync.linkSessions();
  // Then cwd alone does not override the detected runtime.
  assert.deepEqual(linkedPairs(db), []);
});

test("changed same-cwd topology reconsiders active links without rebuilding ended history", async (t) => {
  // Given one unambiguous matching pane and an active inferred session.
  const original = pane("original", { agent: "claude", cwd: "/changed", created_ms: 100 });
  const fake = await fakeHerdr(t, topology([original]));
  const { db, sync } = await follower(t, fake);
  session(db, "active", { runtime: "claude-code", cwd: "/changed", start: 300 });
  sync.linkSessions();
  assert.deepEqual(linkedPairs(db).map((row) => row.pane_id), ["original"]);
  // When a delayed snapshot reveals another matching pane inside that session's lifetime.
  fake.snapshot = topology([original, pane("other", { agent: "claude", cwd: "/changed", created_ms: 200 })]);
  await sync.reconcile();
  // Then the new ambiguity invalidates the active inference rather than leaving a stale guess.
  assert.deepEqual(linkedPairs(db), []);
});

test("connection failures log each distinct cause once across retries", async (t) => {
  // Given a reachable server whose connection initialization fails repeatedly.
  const fake = await fakeHerdr(t, topology([]));
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const events = new EventEmitter(), messages = [];
  const errors = ["schema mismatch", "schema mismatch", "bad snapshot"];
  const disconnected = signal(events, "disconnect");
  const client = createHerdrClient({
    env: { GISOOL_HERDR_SOCKET: fake.path },
    log(message) { messages.push(message); },
    async onConnect() { throw new Error(errors.shift()); },
    onDisconnect() { events.emit("disconnect"); },
    onEvent() {},
  });
  t.after(() => client.close());
  await disconnected;
  // When retrying the same cause and then encountering a different one.
  await signal(events, "disconnect", () => true, () => t.mock.timers.tick(1_000));
  await signal(events, "disconnect", () => true, () => t.mock.timers.tick(2_000));
  // Then the logger preserves both root causes without repeated-cause spam.
  assert.deepEqual(messages, ["herdr failure: schema mismatch", "herdr unreachable", "herdr failure: bad snapshot"]);
});

test("discovery rejections log the actual command or protocol cause", async (t) => {
  // Given discovery failing first to execute, then to parse a successful command.
  const dir = mkdtempSync("/tmp/gst-log-discovery-");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const events = new EventEmitter(), messages = [];
  const failed = signal(events, "log", (message) => message === "herdr unreachable");
  const client = createHerdrClient({
    env: { PATH: dir },
    log(message) { messages.push(message); events.emit("log", message); },
    async onConnect() {}, onDisconnect() {}, onEvent() {},
  });
  t.after(() => client.close());
  await failed;
  assert.match(messages[0], /ENOENT/);
  writeFileSync(join(dir, "herdr"), "#!/bin/sh\nprintf 'status: running\\n'\n", { mode: 0o700 });
  // When a retry rejects a malformed discovery reply.
  await signal(events, "log", (message) => message.includes("no socket: line"), () => t.mock.timers.tick(1_000));
  // Then both discovery causes reach the injected logger.
  assert.equal(messages.filter((message) => message.startsWith("herdr failure:")).length, 2);
});

test("pane.closed is applied before a subsequent snapshot can answer", async (t) => {
  const fake = await fakeHerdr(t, topology([pane("w1:p1")]));
  const { db, changes } = await follower(t, fake);
  fake.hold = true;
  await signal(changes, "change", () => db.prepare("SELECT closed_ms FROM herdr_panes").get().closed_ms !== null,
    () => fake.push("pane_closed", { pane_id: "w1:p1" }));
  assert.equal(typeof db.prepare("SELECT closed_ms FROM herdr_panes").get().closed_ms, "number");
});

test("garbage and fragmented NDJSON do not prevent a valid snapshot", async (t) => {
  const fake = await fakeHerdr(t, topology([pane("w1:p1")]));
  fake.corrupt = true;
  const { db } = await follower(t, fake);
  assert.equal(db.prepare("SELECT id FROM herdr_panes").get().id, "w1:p1");
});

test("reconnect takes a fresh snapshot and closes rows missing during the outage", async (t) => {
  const fake = await fakeHerdr(t, topology([pane("old")]));
  const { db, logs, messages } = await follower(t, fake);
  const disconnected = signal(logs, "log", (message) => message === "herdr unreachable");
  await fake.stop();
  await disconnected;
  fake.snapshot = topology([pane("new")]);
  const reconnected = signal(logs, "log", (message) => message === "herdr connected");
  await fake.start();
  await reconnected;
  assert.notEqual(db.prepare("SELECT closed_ms FROM herdr_panes WHERE id = 'old'").get().closed_ms, null);
  assert.equal(db.prepare("SELECT closed_ms FROM herdr_panes WHERE id = 'new'").get().closed_ms, null);
  assert.deepEqual(messages, ["herdr connected", "herdr unreachable", "herdr connected"]);
});

test("a snapshot overtaken by pane.updated cannot overwrite the newer state", async (t) => {
  const fake = await fakeHerdr(t, topology([pane("w1:p1", { cwd: "/old" })]));
  const { db, sync } = await follower(t, fake);
  fake.hold = true;
  const requested = signal(fake.events, "request", (req) => req.method === "session.snapshot");
  const refresh = sync.reconcile();
  await requested;
  fake.snapshot = topology([pane("w1:p1", { cwd: "/new" })]);
  const eventRead = signal(fake.events, "request", (req) => req.method === "session.snapshot");
  fake.push("pane_updated", { pane_id: "w1:p1" });
  // The event precedes the stale response on the same ordered socket.
  fake.hold = false;
  fake.release();
  await eventRead;
  await refresh;
  assert.equal(db.prepare("SELECT cwd FROM herdr_panes").get().cwd, "/new");
});

test("30 second reconciliation recovers a missed topology event", async (t) => {
  const fake = await fakeHerdr(t, topology([pane("old")]));
  t.mock.timers.enable({ apis: ["setInterval"] });
  const { db, changes } = await follower(t, fake);
  fake.snapshot = topology([pane("new")]);
  await signal(changes, "change", () => Boolean(db.prepare("SELECT id FROM herdr_panes WHERE id = 'new'").get()),
    () => t.mock.timers.tick(30_000));
  assert.notEqual(db.prepare("SELECT closed_ms FROM herdr_panes WHERE id = 'old'").get().closed_ms, null);
});

test("daemon stays healthy while herdr is down and disables discovery when off", async (t) => {
  const sb = makeSandbox();
  const old = { mode: process.env.GISOOL_HERDR, socket: process.env.GISOOL_HERDR_SOCKET };
  process.env.GISOOL_HERDR = "on";
  process.env.GISOOL_HERDR_SOCKET = join(sb.home, "absent.sock");
  const logs = new EventEmitter();
  const unreachable = signal(logs, "log", (message) => message === "herdr unreachable");
  const config = { port: 0, captureLevel: "full", retentionDays: null, roots: [], runtimes: {} };
  const server = await startServer(config, { gisoolHome: sb.env.GISOOL_HOME, handleSignals: false, log: (message) => logs.emit("log", message) });
  t.after(async () => {
    await server.close();
    process.env.GISOOL_HERDR = old.mode;
    if (old.socket === undefined) delete process.env.GISOOL_HERDR_SOCKET;
    else process.env.GISOOL_HERDR_SOCKET = old.socket;
    sb.cleanup();
  });
  await unreachable;
  assert.equal((await http(server.port, { path: "/healthz" })).status, 200);
  await server.close();
  process.env.GISOOL_HERDR = "off";
  const messages = [];
  const disabled = await startServer(config, { gisoolHome: sb.env.GISOOL_HOME, handleSignals: false, log: (message) => messages.push(message) });
  assert.equal((await http(disabled.port, { path: "/healthz" })).status, 200);
  await disabled.close();
  assert.ok(messages.every((message) => !message.startsWith("herdr ")));
});

test("server ingest links a stored reported identity without waiting for reconciliation", async (t) => {
  const fake = await fakeHerdr(t, topology([pane("w1:p1", {
    agent_session: { agent: "claude", kind: "id", source: "hook", value: "ingested-id" },
  })]));
  const sb = makeSandbox();
  const oldMode = process.env.GISOOL_HERDR;
  const oldSocket = process.env.GISOOL_HERDR_SOCKET;
  process.env.GISOOL_HERDR = "on";
  process.env.GISOOL_HERDR_SOCKET = fake.path;
  const logs = new EventEmitter();
  const connected = signal(logs, "log", (message) => message === "herdr connected");
  const server = await startServer({ port: 0, captureLevel: "full", retentionDays: null, roots: [], runtimes: {} },
    { gisoolHome: sb.env.GISOOL_HOME, handleSignals: false, log: (message) => logs.emit("log", message) });
  t.after(async () => {
    await server.close();
    process.env.GISOOL_HERDR = oldMode;
    if (oldSocket === undefined) delete process.env.GISOOL_HERDR_SOCKET;
    else process.env.GISOOL_HERDR_SOCKET = oldSocket;
    sb.cleanup();
  });
  await connected;
  const token = readFileSync(join(sb.env.GISOOL_HOME, "token"), "utf8").trim();
  const before = fake.requests.filter((r) => r.method === "session.snapshot").length;
  const res = await http(server.port, { method: "POST", path: "/ingest/hook/claude-code", headers: jsonHeaders(token),
    body: JSON.stringify({ hook_event_name: "SessionStart", session_id: "ingested-id", cwd: "/qa" }) });
  assert.equal(res.status, 202);
  const db = openDb(join(sb.env.GISOOL_HOME, "gisool.db"));
  try {
    const row = db.prepare("SELECT ps.session_id, s.runtime_session_id FROM pane_sessions ps JOIN sessions s ON s.id = ps.session_id").get();
    assert.equal(row.runtime_session_id, "ingested-id");
    assert.equal(fake.requests.filter((r) => r.method === "session.snapshot").length, before);
  } finally { db.close(); }
});

test("socket resolution uses override, rejects misleading success, and bounds hung status commands", async (t) => {
  const dir = mkdtempSync("/tmp/gst-status-");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.equal(await resolveHerdrSocket({ GISOOL_HERDR_SOCKET: "/override", PATH: "" }), "/override");
  const bin = join(dir, "herdr");
  writeFileSync(bin, "#!/bin/sh\nprintf 'status: running\\n'\n", { mode: 0o700 });
  await assert.rejects(resolveHerdrSocket({ PATH: dir }), /no socket/);
  writeFileSync(bin, "#!/bin/sh\nprintf 'socket: /tmp/valid.sock\\n'\n", { mode: 0o700 });
  assert.equal(await resolveHerdrSocket({ PATH: dir }), "/tmp/valid.sock");
  // exec avoids a surviving shell child when execFile's timeout kills the command.
  writeFileSync(bin, `#!${process.execPath}\nsetInterval(() => {}, 1000);\n`, { mode: 0o700 });
  await assert.rejects(resolveHerdrSocket({ PATH: dir }), (error) => error.killed === true);
});
