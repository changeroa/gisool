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
const { resolveHerdrSocket } = await distImport("herdr/client.js");
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
    ["herdr unreachable", "herdr connected", "herdr unreachable", "herdr connected"]);
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
  // Then both links exist despite no event publication, new snapshot, or SessionStart.
  assert.equal(res.status, 202);
  const row = db.prepare("SELECT id FROM sessions WHERE runtime_session_id = 'binding-first'").get();
  assert.ok(row);
  assert.deepEqual(db.prepare("SELECT pane_id, session_id FROM pane_sessions ORDER BY pane_id").all().map((r) => ({ ...r })),
    [{ pane_id: "cwd", session_id: row.id }, { pane_id: "reported", session_id: row.id }]);
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
  session(db, "later-reported", { runtimeId: "later" });
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
  assert.equal(subs.length, 12);
  assert.ok(subs.every((s) => !["pane.agent_status_changed", "pane.output_matched", "pane.scroll_changed"].includes(s.type)));
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

test("any agent without usable identity links by cwd within lifetime, never without cwd", async (t) => {
  const fake = await fakeHerdr(t, topology([
    pane("claude", { agent: "claude", cwd: "/claude", created_ms: 100 }),
    pane("pi", { agent: "pi", cwd: "/pi", created_ms: 100 }),
    pane("codex", { agent: "codex", cwd: "/codex", created_ms: 100, agent_session: { agent: "codex", kind: "path", source: "file", value: "/not-an-id" } }),
    pane("no-cwd", { agent: "codex" }),
    pane("reported", { cwd: "/claude", agent_session: { agent: "codex", kind: "id", source: "hook", value: "unmatched" } }),
  ]));
  const { db, sync } = await follower(t, fake);
  session(db, "too-old", { cwd: "/claude", start: 99 });
  for (const agent of ["claude", "pi", "codex"]) session(db, `${agent}-session`, { cwd: `/${agent}`, start: 101 });
  sync.linkSessions();
  assert.deepEqual(db.prepare("SELECT pane_id, session_id, source FROM pane_sessions WHERE source = 'inferred:cwd_time' ORDER BY pane_id").all().map((r) => ({ ...r })), [
    { pane_id: "claude", session_id: "claude-session", source: "inferred:cwd_time" },
    { pane_id: "codex", session_id: "codex-session", source: "inferred:cwd_time" },
    { pane_id: "pi", session_id: "pi-session", source: "inferred:cwd_time" },
  ]);
  assert.equal(db.prepare("SELECT count(*) n FROM pane_sessions WHERE pane_id = 'no-cwd'").get().n, 0);
  assert.equal(db.prepare("SELECT session_id FROM pane_sessions WHERE pane_id = 'reported'").get().session_id, null);
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
