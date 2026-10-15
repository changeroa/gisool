import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { distImport, makeSandbox } from "./_helpers.mjs";
import { http, jsonHeaders } from "./helpers/api.mjs";

const { openDb } = await distImport("store/db.js");
const { startHerdrSync } = await distImport("herdr/sync.js");
const { resolveHerdrSocket } = await distImport("herdr/client.js");
const { startServer } = await distImport("server.js");

function signal(emitter, event, predicate = () => true, action = () => {}) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error(`No ${event} signal`)); }, 8_000);
    const cleanup = () => { clearTimeout(timer); emitter.off(event, listener); };
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
