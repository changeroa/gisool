// Real-surface QA only. The daemon never sends mutating requests.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, readFileSync, rmSync, watch, writeFileSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";

const exec = promisify(execFile);
const root = resolve(import.meta.dirname, "../../..");
const home = process.env.HOME;
const gisoolHome = process.env.GISOOL_HOME;
assert.ok(home.startsWith("/var/") || home.startsWith("/tmp/"));
const receipt = (label, value) => console.log(`${label}: ${JSON.stringify(value)}`);
async function cli(...args) {
  const { stdout, stderr } = await exec("herdr", args, {
    env: { ...process.env, HOME: process.env.QA_REAL_HOME }, timeout: 10_000, maxBuffer: 4_000_000,
  });
  receipt(`$ herdr ${args.join(" ")}`, { stdout, stderr });
  return stdout;
}
async function snapshot() {
  return new Promise((resolve, reject) => {
    const socket = createConnection(process.env.GISOOL_HERDR_SOCKET);
    let buffer = "";
    socket.setTimeout(5_000, () => socket.destroy(new Error("snapshot timeout")));
    socket.on("error", reject);
    socket.on("connect", () => socket.write('{"id":"qa","method":"session.snapshot","params":{}}\n'));
    socket.on("data", (chunk) => {
      buffer += chunk;
      if (!buffer.includes("\n")) return;
      socket.destroy();
      resolve(JSON.parse(buffer.split("\n")[0]).result.snapshot);
    });
  });
}
async function availablePort(port = 0) {
  const server = createServer();
  const listening = once(server, "listening");
  server.listen(port, "127.0.0.1");
  await listening;
  const bound = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return bound;
}
function databaseState(db, predicate) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { observer.close(); reject(new Error("database state timeout")); }, 10_000);
    const check = () => {
      try {
        const result = predicate(db);
        if (result) { clearTimeout(timer); observer.close(); resolve(result); }
      } catch (error) { clearTimeout(timer); observer.close(); reject(error); }
    };
    // Directory watches on macOS do not report writes to an existing WAL file.
    const observer = watch(join(gisoolHome, "gisool.db-wal"), check);
    check();
  });
}

let daemon, db, workspace, port;
let closed = false;
try {
  port = await availablePort();
  mkdirSync(gisoolHome, { recursive: true });
  writeFileSync(join(gisoolHome, "config.json"), JSON.stringify({
    port, captureLevel: "full", retentionDays: null, roots: [], runtimes: {},
  }));
  daemon = spawn(process.execPath, [join(root, "local/dist/cli/main.js"), "serve", "--port", String(port)], {
    env: { ...process.env, GISOOL_HERDR: "on" }, stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("daemon readiness timeout")), 10_000);
    daemon.once("exit", (code) => { clearTimeout(timer); reject(new Error(`early daemon exit ${code}`)); });
    daemon.once("error", reject);
    daemon.stderr.on("data", (chunk) => {
      receipt("daemon stderr", chunk.toString());
      if (chunk.toString().includes(`listening on http://127.0.0.1:${port}`)) { clearTimeout(timer); resolve(); }
    });
  });
  assert.equal((await fetch(`http://127.0.0.1:${port}/healthz`)).status, 200);
  receipt("sandbox", { home, gisoolHome, port, pid: daemon.pid, socket: process.env.GISOOL_HERDR_SOCKET });
  db = new DatabaseSync(join(gisoolHome, "gisool.db"), { readOnly: true });
  const created = JSON.parse(await cli("workspace", "create", "--cwd", home, "--label", "gst-task4-qa", "--no-focus"));
  workspace = created.result.workspace.workspace_id;
  const rootPane = created.result.root_pane.pane_id;
  const split = JSON.parse(await cli("pane", "split", rootPane, "--direction", "right", "--cwd", home, "--no-focus"));
  const paneId = split.result.pane.pane_id;
  const rows = await databaseState(db, (db) => {
    const w = db.prepare("SELECT * FROM herdr_workspaces WHERE id = ? AND closed_ms IS NULL").get(workspace);
    const p = db.prepare("SELECT * FROM herdr_panes WHERE id = ? AND closed_ms IS NULL").get(paneId);
    return w && p ? { workspace: w, pane: p } : undefined;
  });
  receipt("sandbox topology rows", rows);
  await cli("pane", "run", paneId, `printf 'GST_PANE=%s\\n' "$HERDR_PANE_ID"`);
  const matched = JSON.parse(await cli("pane", "wait-output", paneId, "--match", `GST_PANE=${paneId}`, "--timeout", "10000"));
  // Installed 0.8.2's pane read may exit 0 without output. The matched response includes
  // the actual terminal snapshot, so never treat read's empty success as evidence.
  await cli("pane", "read", paneId, "--source", "recent-unwrapped", "--lines", "30");
  const output = matched.result.read.text;
  const snapshotPane = (await snapshot()).panes.find((p) => p.pane_id === paneId);
  assert.ok(snapshotPane);
  // Search the actual output marker, not the command echo containing the variable name.
  assert.ok(output.includes(`GST_PANE=${paneId}`));
  receipt("id namespace triple", { split: paneId, session_snapshot: snapshotPane.pane_id, printed_HERDR_PANE_ID: output.match(/GST_PANE=(w[^\\\s"]+)/)?.[1] });
  assert.equal(output.match(/GST_PANE=(w[^\\\s"]+)/)?.[1], paneId);
  // Synthetic ingestion exercises cwd linking, without starting any real agent.
  const token = readFileSync(join(gisoolHome, "token"), "utf8").trim();
  const linked = databaseState(db, (db) => db.prepare("SELECT * FROM pane_sessions WHERE pane_id = ? AND session_id IS NOT NULL").get(paneId));
  const ingested = await fetch(`http://127.0.0.1:${port}/ingest/hook/claude-code`, {
    method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ hook_event_name: "SessionStart", session_id: "gst-task4-qa-synthetic", cwd: snapshotPane.cwd }),
  });
  assert.equal(ingested.status, 202);
  receipt("synthetic hook linked row", await linked);
  receipt("source counts", db.prepare("SELECT source, count(*) n FROM pane_sessions GROUP BY source").all());
  const gone = databaseState(db, (db) => db.prepare("SELECT closed_ms FROM herdr_workspaces WHERE id = ?").get(workspace)?.closed_ms);
  await cli("workspace", "close", workspace);
  closed = true;
  assert.ok(!(await snapshot()).workspaces.some((w) => w.workspace_id === workspace));
  receipt("workspace closure", { id: workspace, absent_from_snapshot: true, closed_ms: await gone });
} finally {
  if (existsSync(join(gisoolHome, "logs/daemon.log"))) receipt("daemon log", readFileSync(join(gisoolHome, "logs/daemon.log"), "utf8"));
  if (db) receipt("final database topology", {
    workspaces: db.prepare("SELECT * FROM herdr_workspaces").all(),
    panes: db.prepare("SELECT * FROM herdr_panes").all(),
  });
  if (workspace && !closed) {
    await cli("workspace", "close", workspace);
    assert.ok(!(await snapshot()).workspaces.some((w) => w.workspace_id === workspace));
  }
  db?.close();
  if (daemon && daemon.exitCode === null && daemon.signalCode === null) {
    const exited = once(daemon, "exit");
    daemon.kill("SIGTERM");
    receipt("daemon exit", await exited);
  }
  if (port) {
    assert.equal(await availablePort(port), port);
    receipt("port free", port);
  }
  rmSync(home, { recursive: true, force: true });
  receipt("temp home removed", { path: home, exists: existsSync(home) });
}
