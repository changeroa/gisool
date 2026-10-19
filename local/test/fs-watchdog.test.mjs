import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { distImport, makeSandbox, PACKAGE_ROOT } from "./_helpers.mjs";
import { http, startTestServer } from "./helpers/api.mjs";

const { createFsWatchdog } = await distImport("fs-watchdog.js");

test("default watchdog kills the daemon with SIGKILL when filesystem requests stall", async () => {
  // Given a real daemon with a pending probe and a clock controlled over IPC.
  const sandbox = makeSandbox();
  const child = spawn(process.execPath, ["--input-type=module", "-e", `
    import { mock } from "node:test";
    import { startServer } from ${JSON.stringify(new URL("dist/server.js", PACKAGE_ROOT).href)};
    mock.timers.enable({ apis: ["setInterval", "Date"], now: 0 });
    await startServer(
      { port: 0, captureLevel: "full", retentionDays: null, roots: [], runtimes: {} },
      { fsWatchdog: { probe: () => new Promise(() => {}) }, log: () => {} },
    );
    process.once("message", () => mock.timers.tick(30_000));
    process.send("ready");
  `], { env: sandbox.env, stdio: ["ignore", "ignore", "inherit", "ipc"] });
  const exited = once(child, "close", { signal: AbortSignal.timeout(10_000) });
  try {
    assert.deepEqual(await once(child, "message", { signal: AbortSignal.timeout(5_000) }), ["ready", undefined]);
    // When the watchdog deadline passes, with exit observation already subscribed.
    child.send("stall");
    // Then the OS reports a hard kill, not a normal exit through native cleanup.
    assert.deepEqual(await exited, [null, "SIGKILL"]);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    try { await exited; } finally { sandbox.cleanup(); }
  }
});

function signal(timeoutMs) {
  let resolve;
  const promise = new Promise((ok, fail) => {
    const timer = setTimeout(() => fail(new Error(`no signal within ${timeoutMs} ms`)), timeoutMs);
    resolve = (value) => { clearTimeout(timer); ok(value); };
  });
  return { promise, resolve };
}

test("a probe that never settles triggers onStall once and health turns false", async () => {
  const stalled = signal(5000);
  let calls = 0;
  const wd = createFsWatchdog({ probe: () => new Promise(() => {}), intervalMs: 20, timeoutMs: 60, onStall: (ms) => { calls += 1; stalled.resolve(ms); } });
  try {
    assert.ok((await stalled.promise) >= 60);
    assert.equal(wd.health().ok, false);
    assert.equal(calls, 1);
  } finally { wd.stop(); }
});

test("a probe that settles (even by rejecting) keeps the watchdog healthy", async () => {
  const done = signal(5000);
  let probes = 0;
  const wd = createFsWatchdog({
    probe: () => { probes += 1; if (probes === 3) done.resolve(); return probes % 2 ? Promise.resolve() : Promise.reject(new Error("ENOENT")); },
    intervalMs: 10, timeoutMs: 1000, onStall: () => assert.fail("must not stall"),
  });
  try {
    await done.promise;
    assert.equal(wd.health().ok, true);
  } finally { wd.stop(); }
});

test("/healthz reports a stalled filesystem with 503 and fs.ok false", async () => {
  const stalled = signal(5000);
  const s = await startTestServer({}, { fsWatchdog: { probe: () => new Promise(() => {}), intervalMs: 20, timeoutMs: 60, onStall: () => stalled.resolve() } });
  try {
    await stalled.promise;
    const res = await http(s.port, { path: "/healthz" });
    assert.equal(res.status, 503);
    assert.equal(res.json.fs.ok, false);
  } finally { await s.stop(); }
});
