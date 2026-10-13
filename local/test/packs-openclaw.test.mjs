import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { distImport, makeSandbox, PACKAGE_ROOT } from "./_helpers.mjs";

const root = fileURLToPath(PACKAGE_ROOT);
const bundle = (rel) => import(new URL("packs/openclaw/" + rel, PACKAGE_ROOT).href);
const { openclawPack } = await distImport("packs/openclaw.js");

function listen(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

test("bootstrap hook appends discovery block and keeps existing content", async () => {
  const { default: handler, marker } = await bundle("hooks/gisool-discovery/handler.js");
  const event = { type: "agent", action: "bootstrap", context: { workspaceDir: "/w", bootstrapFiles: [{ name: "AGENTS.md", path: "/w/AGENTS.md", content: "existing rules" }] } };
  handler(event);
  const content = event.context.bootstrapFiles[0].content;
  assert.ok(content.startsWith("existing rules"));
  assert.ok(content.includes(marker));
  assert.ok(content.includes("gisool = local skills on this machine; gisul = remote team skills."));
  handler(event);
  assert.equal(event.context.bootstrapFiles[0].content.split(marker).length, 2, "idempotent");
});

test("plan lists bundle files, absolute mcp command, notes, and commands", async () => {
  const sb = makeSandbox();
  try {
    const env = { ...sb.env };
    delete env.GISOOL_NO_CLI;
    const ctx = { home: sb.home, env, port: 4321, token: "t", nodePath: process.execPath, packageRoot: root.replace(/\/$/, ""), disableRemote: false };
    const plan = await openclawPack.plan(ctx);
    const rels = plan.files.map((f) => f.path.slice(join(sb.home, ".gisool", "packs", "openclaw").length + 1));
    for (const want of [".codex-plugin/plugin.json", ".mcp.json", "openclaw.plugin.json", "index.mjs", "hooks/gisool-discovery/HOOK.md", "hooks/gisool-discovery/handler.js"]) assert.ok(rels.includes(want), want);
    const mcp = JSON.parse(plan.files.find((f) => f.path.endsWith("/.mcp.json")).after);
    assert.equal(mcp.mcpServers.gisool.command, process.execPath);
    assert.deepEqual(mcp.mcpServers.gisool.args.slice(1), ["mcp-stdio"]);
    assert.ok(mcp.mcpServers.gisool.args[0].startsWith("/"));
    const manifest = JSON.parse(plan.files.find((f) => f.path.endsWith("openclaw.plugin.json")).after);
    assert.equal(manifest.mcpServers.gisool.command, process.execPath);
    assert.equal(JSON.parse(plan.files.find((f) => f.path.endsWith("gisool.json")).after).port, 4321);
    assert.ok(plan.notes.some((n) => n.includes("allowConversationAccess: true")));
    assert.ok(plan.notes.some((n) => n.includes("restart the OpenClaw Gateway") || n.includes("Restart the OpenClaw Gateway")));
    assert.equal(plan.commands[0].argv.slice(0, 3).join(" "), "openclaw plugins install");
    assert.equal(plan.commands[0].undo.argv.join(" "), "openclaw plugins uninstall gisool");

    const noCli = await openclawPack.plan({ ...ctx, env: sb.env, disableRemote: true });
    assert.deepEqual(noCli.commands, []);
    assert.ok(noCli.notes.some((n) => n.includes("openclaw plugins uninstall gisul-openclaw")));
  } finally {
    sb.cleanup();
  }
});

test("hook module registers before_agent_run and POSTs once with bearer token", async () => {
  const sb = makeSandbox();
  const got = [];
  const done = Promise.withResolvers();
  const { server, port } = await listen((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => { got.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(body) }); res.end("{}"); done.resolve(); });
  });
  try {
    mkdirSync(join(sb.home, ".gisool"), { recursive: true });
    writeFileSync(join(sb.home, ".gisool", "token"), "secret-token\n");
    const { register } = await bundle("index.mjs");
    const handlers = {};
    register({ on: (name, fn) => (handlers[name] = fn) }, { ...sb.env, GISOOL_PORT: String(port) });
    assert.deepEqual(Object.keys(handlers), ["before_agent_run"]);
    const result = handlers.before_agent_run({ prompt: "hello" }, { sessionKey: "k", sessionId: "s" });
    assert.equal(result, undefined);
    await done.promise;
    assert.equal(got.length, 1);
    assert.equal(got[0].url, "/ingest/hook/openclaw");
    assert.equal(got[0].auth, "Bearer secret-token");
    assert.deepEqual(got[0].body, { event: "before_agent_run", prompt: "hello", sessionKey: "k", sessionId: "s" });
  } finally {
    server.close();
    sb.cleanup();
  }
});

test("hook returns immediately when the daemon hangs", async () => {
  const sb = makeSandbox();
  const { server, port } = await listen(() => {});
  try {
    mkdirSync(join(sb.home, ".gisool"), { recursive: true });
    writeFileSync(join(sb.home, ".gisool", "token"), "tok");
    const { register } = await bundle("index.mjs");
    const handlers = {};
    register({ on: (n, fn) => (handlers[n] = fn) }, { ...sb.env, GISOOL_PORT: String(port) });
    const t0 = performance.now();
    handlers.before_agent_run({ prompt: "p" }, {});
    assert.ok(performance.now() - t0 < 100);
  } finally {
    server.closeAllConnections();
    server.close();
    sb.cleanup();
  }
});

test("doctor reports allowConversationAccess missing, then ok when set", async () => {
  const sb = makeSandbox();
  try {
    const dir = join(sb.home, ".openclaw");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "openclaw.json"), JSON.stringify({ plugins: { entries: { gisool: { enabled: true } } } }));
    let checks = await openclawPack.doctorChecks({ home: sb.home, env: sb.env, port: 1 });
    const flag = checks.find((c) => c.name === "allowConversationAccess");
    assert.equal(flag.ok, false);
    assert.ok(flag.detail.includes("allowConversationAccess missing"));
    writeFileSync(join(dir, "openclaw.json"), '{ // json5-ish\n plugins: {}, "plugins": { "entries": { "gisool": { "hooks": { "allowConversationAccess": true, }, }, }, }, }');
    checks = await openclawPack.doctorChecks({ home: sb.home, env: sb.env, port: 1 });
    assert.equal(checks.find((c) => c.name === "allowConversationAccess").ok, true);
  } finally {
    sb.cleanup();
  }
});

test("detect flags an existing remote gisul bundle", async () => {
  const sb = makeSandbox();
  try {
    mkdirSync(join(sb.home, ".openclaw", "gisul"), { recursive: true });
    const d = await openclawPack.detect({ home: sb.home, env: sb.env });
    assert.equal(d.installed, true);
    assert.equal(d.remoteGisulRegistered, true);
  } finally {
    sb.cleanup();
  }
});
