import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { distImport, makeSandbox, PACKAGE_ROOT } from "./_helpers.mjs";

const packageRoot = new URL(".", PACKAGE_ROOT).pathname.replace(/\/$/, "");
const TOKEN = "tok-123";
let n = 0;

async function loadExt(runtime, sb, port) {
  mkdirSync(sb.env.GISOOL_HOME, { recursive: true });
  writeFileSync(join(sb.env.GISOOL_HOME, "token"), TOKEN);
  process.env.GISOOL_HOME = sb.env.GISOOL_HOME;
  process.env.GISOOL_PORT = String(port);
  const mod = await import(new URL(`packs/${runtime}/extension/index.js?n=${n++}`, PACKAGE_ROOT).href);
  const handlers = [];
  mod.default({ on: (...a) => handlers.push(a) });
  return handlers;
}

/** Bounded await: rejects if the signal does not arrive within ms. */
function within(promise, ms, what) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Real HTTP listener; nth(i) resolves when the i-th request (0-based) has been fully received. */
function listener() {
  const received = [];
  const waiters = [];
  const nth = i => received[i] ? Promise.resolve(received[i]) : new Promise(r => { (waiters[i] ??= []).push(r); });
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", c => (body += c));
    req.on("end", () => {
      const i = received.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(body) }) - 1;
      for (const r of waiters[i] ?? []) r(received[i]);
      res.end("{}");
    });
  });
  return new Promise(r => server.listen(0, "127.0.0.1", () => r({ server, received, nth, port: server.address().port })));
}

/** Replaces globalThis.fetch; the forwarder calls fetch synchronously, so calls are observable right after the handler returns. */
function stubFetch(impl) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = (...args) => { calls.push(args); return impl(...args); };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

for (const runtime of ["omo", "gajae"]) {
  test(`${runtime}: forwarder posts prompt, appends discovery, previewSafe`, async () => {
    const sb = makeSandbox();
    const l = await listener();
    try {
      const handlers = await loadExt(runtime, sb, l.port);
      assert.equal(handlers.length, 1);
      assert.equal(handlers[0][0], "before_agent_start");
      assert.equal(handlers[0][2].previewSafe, true);
      const event = { type: "before_agent_start", prompt: "hello", systemPrompt: "base" };
      const ctx = { cwd: "/w", sessionManager: { getSessionId: () => "s1" } };
      const out = handlers[0][1](event, ctx);
      assert.equal(out, event);
      assert.ok(out.systemPrompt.startsWith("base"));
      assert.ok(out.systemPrompt.trimEnd().endsWith("</gisool-discovery>"));
      assert.match(out.systemPrompt, /search_skills/);
      const first = await within(l.nth(0), 5000, "first POST");
      assert.equal(first.url, `/ingest/hook/${runtime}`);
      assert.equal(first.auth, `Bearer ${TOKEN}`);
      assert.deepEqual(first.body, { event: "before_agent_start", prompt: "hello", sessionId: "s1", cwd: "/w" });
      // non-string prompt
      const e2 = { prompt: undefined, systemPrompt: "x" };
      handlers[0][1](e2, ctx);
      const second = await within(l.nth(1), 5000, "second POST");
      assert.equal(second.body.prompt, null);
      assert.equal(second.body.promptUnavailable, true);
      assert.equal(l.received.length, 2);
    } finally {
      l.server.closeAllConnections(); l.server.close(); sb.cleanup();
    }
  });

  test(`${runtime}: preview event posts nothing and leaves systemPrompt unchanged`, async () => {
    const sb = makeSandbox();
    const handlers = await loadExt(runtime, sb, 1);
    const stub = stubFetch(() => Promise.resolve(new Response("{}")));
    try {
      const event = { prompt: "p", systemPrompt: "base", preview: true };
      assert.equal(handlers[0][1](event, {}), event);
      assert.equal(event.systemPrompt, "base");
      assert.equal(stub.calls.length, 0);
      // Control: the same stub does observe a non-preview event synchronously.
      handlers[0][1]({ prompt: "p", systemPrompt: "base" }, {});
      assert.equal(stub.calls.length, 1);
    } finally {
      stub.restore(); sb.cleanup();
    }
  });

  test(`${runtime}: hanging, failing, or throwing fetch never blocks or throws`, async () => {
    const sb = makeSandbox();
    const handlers = await loadExt(runtime, sb, 1);
    let next;
    const stub = stubFetch(() => next());
    try {
      // Hanging listener: fetch never settles; the handler returns the event, not a promise, with a bounded abort signal.
      next = () => new Promise(() => {});
      const hangEvent = { prompt: "p", systemPrompt: "s" };
      assert.equal(handlers[0][1](hangEvent, {}), hangEvent);
      assert.ok(stub.calls[0][1].signal instanceof AbortSignal);
      // Absent listener: fetch rejects; the forwarder must attach a rejection handler before returning.
      let handled = false;
      next = () => {
        const p = Promise.reject(new TypeError("fetch failed"));
        const ownCatch = p.catch.bind(p);
        p.catch = fn => { handled = true; return ownCatch(fn); };
        return p;
      };
      const absentEvent = { prompt: "p", systemPrompt: "s" };
      assert.equal(handlers[0][1](absentEvent, {}), absentEvent);
      assert.equal(stub.calls.length, 2);
      assert.equal(handled, true);
      // fetch throwing synchronously is swallowed too.
      next = () => { throw new TypeError("bad url"); };
      const throwEvent = { prompt: "p", systemPrompt: "s" };
      assert.equal(handlers[0][1](throwEvent, {}), throwEvent);
      assert.equal(stub.calls.length, 3);
    } finally {
      stub.restore(); sb.cleanup();
    }
  });
}

function ctxFor(sb, extra = {}) {
  return { home: sb.home, env: sb.env, port: 8799, token: TOKEN, nodePath: process.execPath, packageRoot, disableRemote: false, ...extra };
}

test("omo pack plan: mcp.json + extension files, merges existing, disables remote gisul", async () => {
  const { omoPack } = await distImport("packs/omo.js");
  const sb = makeSandbox();
  try {
    const agent = join(sb.home, ".omo", "agent");
    mkdirSync(agent, { recursive: true });
    const remote = { command: "npx", args: ["--yes", "mcp-remote@0.14.3", "https://gisul.arkpoint.dev/mcp"] };
    writeFileSync(join(agent, "mcp.json"), JSON.stringify({ mcpServers: { gisul: remote, other: { command: "x" } } }));
    const det = await omoPack.detect({ home: sb.home, env: sb.env });
    assert.equal(det.installed, true);
    assert.equal(det.remoteGisulRegistered, true);
    const plan = await omoPack.plan(ctxFor(sb, { disableRemote: true }));
    assert.deepEqual(plan.conflicts, []);
    const mcp = plan.files.find(f => f.path === join(agent, "mcp.json"));
    const cfg = JSON.parse(mcp.after);
    assert.deepEqual(cfg.mcpServers.gisool, { type: "http", url: "http://127.0.0.1:8799/mcp", headers: { Authorization: `Bearer ${TOKEN}` } });
    assert.equal(cfg.mcpServers.gisul.enabled, false);
    assert.equal(cfg.mcpServers.gisul.command, "npx");
    assert.deepEqual(cfg.mcpServers.other, { command: "x" });
    assert.equal(mcp.mode, 0o600);
    const idx = plan.files.find(f => f.path === join(agent, "extensions", "gisool", "index.js"));
    assert.equal(idx.after, readFileSync(join(packageRoot, "packs/omo/extension/index.js"), "utf8"));
    assert.ok(plan.files.some(f => f.path === join(agent, "extensions", "gisool", "discovery.md")));
    const kept = await omoPack.plan(ctxFor(sb));
    assert.equal(JSON.parse(kept.files[0].after).mcpServers.gisul.enabled, undefined);
    const checks = await omoPack.doctorChecks({ home: sb.home, env: sb.env, port: 8799 });
    assert.equal(checks.every(c => c.ok), false);
  } finally { sb.cleanup(); }
});

test("gajae pack plan honours GJC env and detects nothing when absent", async () => {
  const { gajaePack } = await distImport("packs/gajae.js");
  const sb = makeSandbox();
  try {
    assert.equal((await gajaePack.detect({ home: sb.home, env: sb.env })).installed, false);
    const plan = await gajaePack.plan(ctxFor(sb));
    const agent = join(sb.home, ".gjc", "agent");
    assert.ok(plan.files.some(f => f.path === join(agent, "mcp.json") && f.before === null));
    assert.ok(plan.files.some(f => f.path === join(agent, "extensions", "gisool", "index.js")));
    const custom = await gajaePack.plan(ctxFor(sb, { env: { ...sb.env, GJC_CONFIG_DIR: "../x" } }));
    assert.equal(custom.conflicts[0].code, "agent_dir_unresolved");
    mkdirSync(agent, { recursive: true });
    writeFileSync(join(agent, "mcp.json"), "{bad");
    assert.equal((await gajaePack.plan(ctxFor(sb))).conflicts[0].code, "invalid_mcp_config");
  } finally { sb.cleanup(); }
});
