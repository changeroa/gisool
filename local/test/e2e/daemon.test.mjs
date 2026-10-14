import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { createServer } from "node:net";
import { userInfo } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { modernClient } from "../helpers/mcp.mjs";
import { makeSandbox, writeFixtureSkill } from "../_helpers.mjs";

const MAIN = fileURLToPath(new URL("../../dist/cli/main.js", import.meta.url));
const CATALOG = JSON.parse(readFileSync(new URL("../../bench/catalog.json", import.meta.url), "utf8"));
const fixture = (name) => readFileSync(new URL(`../fixtures/ingest/${name}`, import.meta.url), "utf8");
const STARTUP_MS = 10_000;
const EVENT_MS = 5_000;

const REAL_HOME = userInfo().homedir;
const REAL_CONFIGS = [
  ".claude.json", ".claude/settings.json", ".codex/config.toml", ".gemini/settings.json",
  ".omo/agent/mcp.json", ".gjc/agent/mcp.json", ".openclaw/openclaw.json",
].map((rel) => join(REAL_HOME, rel));

function hashRealConfigs() {
  return Object.fromEntries(REAL_CONFIGS.map((p) => [p, existsSync(p) ? createHash("sha256").update(readFileSync(p)).digest("hex") : "absent"]));
}

function withTimeout(promise, ms, what) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms waiting for ${what}`)), ms); }),
  ]);
}

async function freePort() {
  const srv = createServer();
  srv.listen(0, "127.0.0.1");
  await once(srv, "listening");
  const { port } = srv.address();
  await new Promise((resolve) => srv.close(resolve));
  return port;
}

async function portIsFree(port) {
  const srv = createServer();
  try {
    srv.listen(port, "127.0.0.1");
    await Promise.race([once(srv, "listening"), once(srv, "error").then(([e]) => { throw e; })]);
    await new Promise((resolve) => srv.close(resolve));
    return true;
  } catch (error) {
    if (error.code === "EADDRINUSE") return false;
    throw error;
  }
}

/** Splits bench/catalog.json across two skill roots as real SKILL.md folders (each gets a guide.md resource). */
function seedRoots(home) {
  const roots = [{ id: "agents", path: join(home, "skills-a") }, { id: "claude", path: join(home, "skills-b") }];
  CATALOG.forEach((entry, i) => {
    writeFixtureSkill(roots[i % 2].path, entry.name, {
      description: entry.description,
      frontmatter: { tags: entry.keywords, aliases_ko: entry.aliases_ko, examples: entry.examples },
      body: `# ${entry.name}\n\n${entry.description}\n`,
      files: { "guide.md": `${entry.name} guide v1\n` },
    });
  });
  return roots;
}

function writeConfig(env, port, roots, extra = {}) {
  mkdirSync(env.GISOOL_HOME, { recursive: true, mode: 0o700 });
  const config = { port, captureLevel: "full", retentionDays: null, roots, runtimes: {}, ...extra };
  writeFileSync(join(env.GISOOL_HOME, "config.json"), JSON.stringify(config, null, 2), { mode: 0o600 });
}

function httpReq(port, { method = "GET", path = "/", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method, path, headers: { Host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json;
        try { json = JSON.parse(text); } catch { json = undefined; }
        resolve({ status: res.statusCode, text, json });
      });
    });
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

/** Spawns `gisool serve` and subscribes to its readiness line before checking health. */
async function startDaemon(env, port) {
  const child = spawn(process.execPath, [MAIN, "serve", "--port", String(port)], { env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (c) => (output += c));
  const ready = new Promise((resolve, reject) => {
    child.stderr.on("data", (c) => {
      output += c;
      if (output.includes(`listening on http://127.0.0.1:${port}`)) resolve();
    });
    child.once("exit", (code) => reject(new Error(`daemon exited early (${code}): ${output}`)));
    child.once("error", reject);
  });
  await withTimeout(ready, STARTUP_MS, `daemon readiness (${output})`);
  const res = await httpReq(port, { path: "/healthz" });
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
  return {
    child, port,
    output: () => output,
    async stop() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = once(child, "exit");
      child.kill("SIGTERM");
      await withTimeout(exited, STARTUP_MS, "daemon exit");
    },
  };
}

/** Subscribes to /api/events/stream and resolves session frames matching a predicate. */
async function openStream(port, token) {
  const frames = [];
  const waiters = [];
  const req = request({ host: "127.0.0.1", port, path: "/api/events/stream", headers: { Host: `127.0.0.1:${port}`, Authorization: `Bearer ${token}` } });
  const responded = once(req, "response");
  req.end();
  const [res] = await withTimeout(responded, EVENT_MS, "SSE response");
  assert.equal(res.statusCode, 200);
  let buf = "";
  res.setEncoding("utf8");
  const connected = new Promise((resolve) => {
    res.on("data", (chunk) => {
      buf += chunk;
      if (buf.includes(": connected")) resolve();
      let idx;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const data = /^event: session\ndata: (.*)$/m.exec(frame);
        if (!data) continue;
        const row = JSON.parse(data[1]);
        frames.push(row);
        for (const w of [...waiters]) if (w.pred(row)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(row); }
      }
    });
  });
  await withTimeout(connected, EVENT_MS, "SSE connected comment");
  return {
    /** Registers a waiter now; await the returned promise after triggering the action. */
    next(pred, what) {
      return withTimeout(new Promise((resolve) => waiters.push({ pred, resolve })), EVENT_MS, what);
    },
    close() { req.destroy(); },
  };
}

async function mcpClient(port, token, name) {
  return modernClient(port, token, name);
}

async function call(client, name, args, meta) {
  const result = await client.callTool({ name, arguments: args, _meta: meta });
  return { isError: result.isError === true, body: JSON.parse(result.content[0].text) };
}

function sandbox(t) {
  const sb = makeSandbox();
  t.after(() => sb.cleanup());
  const roots = seedRoots(sb.home);
  return { ...sb, roots };
}

const api = (port, token, path) => httpReq(port, { path, headers: { Authorization: `Bearer ${token}` } });
const post = (port, token, path, body) =>
  httpReq(port, { method: "POST", path, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body });

test("daemon end to end: MCP, OTLP and hook ingest, dashboard API, restart, and real configs untouched", async (t) => {
  const before = hashRealConfigs();
  for (const [p, h] of Object.entries(before)) t.diagnostic(`real-config before ${h} ${p}`);

  const sb = sandbox(t);
  const port = await freePort();
  const tokenEnv = sb.env;
  writeConfig(tokenEnv, port, sb.roots);
  let daemon = await startDaemon(tokenEnv, port);
  const token = readFileSync(join(tokenEnv.GISOOL_HOME, "token"), "utf8").trim();
  t.after(() => daemon.stop());

  const skills = (await api(port, token, "/api/skills")).json;
  assert.equal(skills.length, CATALOG.length);
  assert.deepEqual(new Set(skills.map((s) => s.rootId)), new Set(["agents", "claude"]));

  const stream = await openStream(port, token);
  t.after(() => stream.close());

  // Codex MCP client: search -> load -> read, attributed through _meta.threadId.
  const target = CATALOG.find((e) => e.name === "database-query");
  const client = await mcpClient(port, token, "codex-mcp-client");
  const discovery = await client.request("server/discover");
  assert.deepEqual(discovery.supportedVersions, ["2026-07-28"]);
  assert.deepEqual(discovery.capabilities, { tools: {}, resources: {}, extensions: { "io.modelcontextprotocol/skills": {} } });
  assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name), ["search_skills"]);
  const meta = { threadId: "codex-conv-1" };
  const search = await call(client, "search_skills", { query: target.description }, meta);
  assert.equal(search.isError, false, JSON.stringify(search.body));
  const top = search.body.candidates[0];
  assert.equal(top.name, "database-query");
  assert.ok(top.score > 0);
  const readMeta = { ...meta, "app.gisool/traceId": search.body.trace_id };
  const entry = (await client.request("skills/get", { uri: top.uri })).skill;
  const load = await client.readResource({ uri: top.uri, _meta: readMeta });
  assert.equal(`sha256:${createHash("sha256").update(load.contents[0].text).digest("hex")}`, entry.resources.find((r) => r.uri === top.uri).digest);
  const guideUri = top.uri.replace(/SKILL\.md$/, "guide.md");
  const read = await client.readResource({ uri: guideUri, _meta: readMeta });
  assert.equal(read.contents[0].text, "database-query guide v1\n");
  const legacy = await post(port, token, "/mcp", JSON.stringify({ jsonrpc: "2.0", id: 99, method: "initialize", params: { protocolVersion: "2025-11-25" } }));
  assert.equal(legacy.status, 400);
  assert.equal(legacy.json.error.code, -32020);

  // Claude OTLP prompt and Gemini hook.
  let wait = stream.next((r) => r.runtime === "claude-code", "claude prompt session frame");
  assert.equal((await post(port, token, "/ingest/otlp/v1/logs", fixture("claude-otlp-user-prompt.json"))).status, 202);
  await wait;
  wait = stream.next((r) => r.runtime === "gemini", "gemini hook session frame");
  assert.equal((await post(port, token, "/ingest/hook/gemini", fixture("gemini-hook-before-agent.json"))).status, 202);
  await wait;

  // Native skill signals: Codex OTel skill invocation and a Claude SKILL.md read.
  wait = stream.next((r) => r.runtime === "codex", "codex native skill frame");
  assert.equal((await post(port, token, "/ingest/otlp/v1/logs", fixture("codex-otlp-skill-invocation.json"))).status, 202);
  await wait;
  wait = stream.next((r) => r.runtime === "claude-code", "claude file_read frame");
  assert.equal((await post(port, token, "/ingest/otlp/v1/logs", fixture("claude-otlp-tool-result-skill-read.json"))).status, 202);
  await wait;

  const sessions = (await api(port, token, "/api/sessions")).json;
  const byRuntime = Object.fromEntries(sessions.map((s) => [s.runtime, s]));
  assert.deepEqual(Object.keys(byRuntime).sort(), ["claude-code", "codex", "gemini"]);
  for (const s of sessions) assert.notEqual(s.attribution, "none", JSON.stringify(s));
  // The codex session holds MCP events (vendor_meta via _meta.threadId) and the OTel skill invocation (runtime_id via
  // conversation.id); its row reports the earliest attributed event, so either method proves both landed in one session.
  assert.ok(["vendor_meta", "runtime_id"].includes(byRuntime.codex.attribution));
  assert.equal(byRuntime.codex.state, "loaded");
  assert.deepEqual(byRuntime.codex.skills, [top.uri]);
  assert.equal(byRuntime["claude-code"].attribution, "runtime_id");

  const traces = {};
  for (const s of sessions) {
    const res = await api(port, token, `/api/sessions/${encodeURIComponent(s.id)}/trace`);
    assert.equal(res.status, 200);
    traces[s.runtime] = res.json;
  }
  const searchStep = traces.codex.find((st) => st.kind === "search");
  assert.ok(searchStep.detail.candidates.length >= 1);
  for (const c of searchStep.detail.candidates) assert.equal(typeof c.score, "number");
  assert.deepEqual(searchStep.detail.chosen, [top.uri]);
  assert.deepEqual(traces.codex.map((st) => st.kind).filter((k) => k !== "native_skill"), ["search", "load", "read_file"]);
  const native = Object.values(traces).flat().filter((st) => st.kind === "native_skill");
  assert.equal(native.length, 2, JSON.stringify(native));
  assert.deepEqual(native.map((st) => st.detail.via).sort(), ["file_read", "otel"]);
  assert.equal(traces["claude-code"].find((st) => st.kind === "prompt").detail.text, "Write a commit message please");

  const flow = (await api(port, token, "/api/flow")).json;
  assert.equal(flow.sessionCount, 3);
  assert.ok(flow.links.some((l) => l.state === "loaded"));
  const heatmap = (await api(port, token, "/api/heatmap?tz=UTC&bucket=2")).json;
  assert.equal(heatmap.tz, "UTC");
  assert.equal(heatmap.cells.reduce((n, c) => n + c.count, 0), 3);

  // Restart: standard resource reads still work without connection or load state.
  stream.close();
  await daemon.stop();
  daemon = await startDaemon(tokenEnv, port);
  const again = await mcpClient(port, token, "codex-mcp-client");
  const reread = await again.readResource({ uri: guideUri, _meta: readMeta });
  assert.equal(reread.contents[0].text, "database-query guide v1\n");

  await daemon.stop();
  assert.equal(await portIsFree(port), true);
  const db = new DatabaseSync(join(tokenEnv.GISOOL_HOME, "gisool.db"), { readOnly: true });
  try {
    assert.deepEqual(db.prepare("SELECT kind FROM events WHERE source = 'mcp' ORDER BY ts, rowid").all().map((r) => r.kind), ["search", "load", "read_file", "read_file"]);
  } finally { db.close(); }

  const after = hashRealConfigs();
  for (const [p, h] of Object.entries(after)) t.diagnostic(`real-config after  ${h} ${p}`);
  assert.deepEqual(after, before);
});

test("captureLevel metadata stores the prompt digest without text", async (t) => {
  const sb = sandbox(t);
  const port = await freePort();
  writeConfig(sb.env, port, sb.roots, { captureLevel: "metadata" });
  const daemon = await startDaemon(sb.env, port);
  const token = readFileSync(join(sb.env.GISOOL_HOME, "token"), "utf8").trim();
  t.after(() => daemon.stop());
  const stream = await openStream(port, token);
  t.after(() => stream.close());

  const wait = stream.next((r) => r.runtime === "claude-code", "claude prompt session frame");
  assert.equal((await post(port, token, "/ingest/otlp/v1/logs", fixture("claude-otlp-user-prompt.json"))).status, 202);
  await wait;
  stream.close();
  await daemon.stop();

  const db = new DatabaseSync(join(sb.env.GISOOL_HOME, "gisool.db"), { readOnly: true });
  try {
    const rows = db.prepare("SELECT text, text_digest, text_length FROM events WHERE kind = 'prompt'").all();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].text, null);
    assert.match(rows[0].text_digest, /^[0-9a-f]{64}$/);
    assert.equal(rows[0].text_digest, createHash("sha256").update("Write a commit message please").digest("hex"));
  } finally {
    db.close();
  }
});

test("a wrong bearer token gets 401 on /ingest and records no session", async (t) => {
  const sb = sandbox(t);
  const port = await freePort();
  writeConfig(sb.env, port, sb.roots);
  const daemon = await startDaemon(sb.env, port);
  const token = readFileSync(join(sb.env.GISOOL_HOME, "token"), "utf8").trim();
  t.after(() => daemon.stop());

  const wrong = "0".repeat(64);
  assert.notEqual(wrong, token);
  assert.equal((await post(port, wrong, "/ingest/otlp/v1/logs", fixture("claude-otlp-user-prompt.json"))).status, 401);
  assert.equal((await post(port, wrong, "/ingest/hook/gemini", fixture("gemini-hook-before-agent.json"))).status, 401);
  const sessions = await api(port, token, "/api/sessions");
  assert.equal(sessions.status, 200);
  assert.deepEqual(sessions.json, []);
  assert.equal((await api(port, token, "/api/stats")).json.ingest.accepted, 0);
});
