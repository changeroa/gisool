import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { once } from "node:events";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";
import { distImport, makeTempDir, removeDir, writeFixtureSkill } from "./_helpers.mjs";

const { openDb } = await distImport("store/db.js");
const { createStore } = await distImport("store/index.js");
const { createSearchIndex } = await distImport("search/index.js");
const { createCatalog } = await distImport("catalog/index.js");
const { createIngestDeps } = await distImport("ingest/pipeline.js");
const { registerMcp } = await distImport("mcp/http.js");

const TOKEN = "t".repeat(64);
const uriOf = (dir, file = "SKILL.md") => `skill://local/agents/${dir}/${file}`;

function seedSkills(root) {
  writeFixtureSkill(root, "pr-review", {
    description: "Review pull request code changes and leave review comments",
    files: { "guide.md": "Review guide v1", "refs/checklist.md": "checklist", "refs/style.md": "style" },
  });
  writeFixtureSkill(root, "code-review-notes", { description: "Summarize code review feedback on a pull request" });
  writeFixtureSkill(root, "release-plan", { description: "Plan a product release with milestones" });
}

async function startDaemon(dir) {
  const db = openDb(join(dir, "gisool.db"));
  const store = createStore(db);
  const search = createSearchIndex(db);
  const catalog = createCatalog({ roots: [{ id: "agents", path: join(dir, "skills") }], log: () => {} });
  await catalog.refresh();
  search.rebuild(catalog.list());
  store.upsertSkills(catalog.list());
  const app = express();
  const handle = registerMcp(app, { catalog, search, store, ingest: createIngestDeps(store, { log: () => {} }), token: TOKEN });
  const http = app.listen(0, "127.0.0.1");
  await once(http, "listening");
  const port = http.address().port;
  return {
    db, store, catalog, port,
    rows: () => db.prepare("SELECT kind, runtime, attribution_method, tool_use_id, trace_id, load_id, skill_uri, data_json FROM events ORDER BY ts, rowid").all()
      .map((r) => ({ ...r, data: JSON.parse(r.data_json) })),
    async stop() {
      await handle.close();
      http.closeAllConnections();
      await new Promise((resolve) => http.close(resolve));
      catalog.close();
      store.close();
    },
  };
}

async function connect(daemon, name) {
  const client = new Client({ name, version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${daemon.port}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
  }));
  return client;
}

async function call(client, name, args, meta) {
  const result = await client.callTool({ name, arguments: args, ...(meta ? { _meta: meta } : {}) });
  return { isError: result.isError === true, body: JSON.parse(result.content[0].text) };
}

async function withDaemon(fn) {
  const dir = makeTempDir("gisool-mcp-");
  seedSkills(join(dir, "skills"));
  const daemon = await startDaemon(dir);
  try {
    await fn(daemon, dir);
  } finally {
    await daemon.stop().catch(() => {});
    removeDir(dir);
  }
}

test("instructions name search_skills and distinguish local gisool from remote gisul", () => withDaemon(async (daemon) => {
  const client = await connect(daemon, "codex-mcp-client");
  const instructions = client.getInstructions();
  assert.match(instructions, /search_skills/);
  assert.match(instructions, /gisool = local skills on this machine; gisul \(if present\) = remote team skills/);
  const tools = (await client.listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual(tools, ["load_skill", "read_skill_file", "search_skills"]);
  await client.close();
}));

test("codex search -> load -> read records vendor_meta events and survives a store reopen", () => withDaemon(async (daemon, dir) => {
  const client = await connect(daemon, "codex-mcp-client");
  const meta = { threadId: "t1" };
  const search = await call(client, "search_skills", { query: "pr-review pull request code changes" }, meta);
  assert.equal(search.isError, false);
  assert.match(search.body.trace_id, /^[0-9a-f-]{36}$/);
  assert.ok(search.body.candidates.length >= 2, JSON.stringify(search.body));
  assert.equal(search.body.candidates[0].uri, uriOf("pr-review"));
  for (let i = 1; i < search.body.candidates.length; i += 1) assert.ok(search.body.candidates[i - 1].score >= search.body.candidates[i].score);
  assert.deepEqual(search.body.candidates.map((c) => c.rank), search.body.candidates.map((_, i) => i + 1));
  assert.equal(search.body.total, search.body.candidates.length);

  const load = await call(client, "load_skill", { uri: uriOf("pr-review"), trace_id: search.body.trace_id }, meta);
  assert.equal(load.isError, false);
  assert.match(load.body.load_id, /^[0-9a-f]{64}$/);
  assert.match(load.body.markdown, /name: pr-review/);
  assert.equal(load.body.changed, false);
  assert.equal(load.body.filesFolded, false);
  assert.ok(load.body.files.includes(uriOf("pr-review", "guide.md")));

  const read = await call(client, "read_skill_file", { skill_uri: uriOf("pr-review"), uri: uriOf("pr-review", "guide.md"), load_id: load.body.load_id }, meta);
  assert.equal(read.body.text, "Review guide v1");
  const listing = await call(client, "read_skill_file", { skill_uri: uriOf("pr-review"), uri: uriOf("pr-review", "refs") }, meta);
  assert.equal(listing.body.kind, "directory");
  assert.deepEqual(listing.body.files, [uriOf("pr-review", "refs/checklist.md"), uriOf("pr-review", "refs/style.md")]);

  const rows = daemon.rows();
  assert.deepEqual(rows.map((r) => r.kind), ["search", "load", "read_file", "read_file"]);
  for (const r of rows) {
    assert.equal(r.runtime, "codex");
    assert.equal(r.attribution_method, "vendor_meta");
  }
  assert.equal(rows[0].trace_id, search.body.trace_id);
  assert.equal(rows[0].data.candidates[0].uri, uriOf("pr-review"));
  assert.equal(rows[1].load_id, load.body.load_id);
  assert.equal(rows[2].data.bytes, Buffer.byteLength("Review guide v1"));
  await client.close();
  await daemon.stop();

  const restarted = await startDaemon(dir);
  try {
    const again = await connect(restarted, "codex-mcp-client");
    const reread = await call(again, "read_skill_file", { skill_uri: uriOf("pr-review"), uri: uriOf("pr-review", "guide.md"), load_id: load.body.load_id }, meta);
    assert.equal(reread.isError, false, JSON.stringify(reread.body));
    assert.equal(reread.body.text, "Review guide v1");
    await again.close();
  } finally {
    await restarted.stop();
  }
}));

test("editing a skill file after load fails reads with skill_changed_since_load", () => withDaemon(async (daemon, dir) => {
  const client = await connect(daemon, "codex-mcp-client");
  const load = await call(client, "load_skill", { uri: uriOf("pr-review") });
  writeFileSync(join(dir, "skills/pr-review/guide.md"), "Review guide v2 edited");
  const stale = await call(client, "read_skill_file", { skill_uri: uriOf("pr-review"), uri: uriOf("pr-review", "guide.md"), load_id: load.body.load_id });
  assert.equal(stale.isError, true);
  assert.equal(stale.body.error.code, "skill_changed_since_load");
  await daemon.catalog.refresh();
  const afterRefresh = await call(client, "read_skill_file", { skill_uri: uriOf("pr-review"), uri: uriOf("pr-review", "guide.md"), load_id: load.body.load_id });
  assert.equal(afterRefresh.body.error.code, "skill_changed_since_load");
  const reload = await call(client, "load_skill", { uri: uriOf("pr-review") });
  assert.equal(reload.body.changed, true);
  assert.notEqual(reload.body.load_id, load.body.load_id);
  const errors = daemon.rows().filter((r) => r.kind === "error");
  assert.equal(errors.length, 2);
  assert.equal(errors[0].data.code, "skill_changed_since_load");
  await client.close();
}));

test("senpi-mcp-client maps to runtime omo and claudecode/toolUseId is stored", () => withDaemon(async (daemon) => {
  const omo = await connect(daemon, "senpi-mcp-client");
  await call(omo, "search_skills", { query: "plan a product release" });
  await omo.close();
  const claude = await connect(daemon, "claude-code");
  await call(claude, "search_skills", { query: "plan a product release" }, { "claudecode/toolUseId": "tu9" });
  await claude.close();
  const rows = daemon.rows();
  assert.equal(rows[0].runtime, "omo");
  assert.equal(rows[1].runtime, "claude-code");
  assert.equal(rows[1].tool_use_id, "tu9");
}));

test("load_skill with an unknown uri returns an error code and records no load", () => withDaemon(async (daemon) => {
  const client = await connect(daemon, "codex-mcp-client");
  const search = await call(client, "search_skills", { query: "pr-review pull request code changes" });
  const bad = await call(client, "load_skill", { uri: uriOf("does-not-exist"), trace_id: search.body.trace_id });
  assert.equal(bad.isError, true);
  assert.equal(bad.body.error.code, "unknown_skill");
  const rows = daemon.rows();
  assert.deepEqual(rows.map((r) => r.kind), ["search", "error"]);
  assert.deepEqual(rows[0].data.chosen, []);
  assert.equal(rows[1].data.tool, "load_skill");
  assert.equal(daemon.store.latestLoad(uriOf("does-not-exist")), undefined);
  await client.close();
}));

test("search paginates with offset and abstains on an empty query", () => withDaemon(async (daemon) => {
  const client = await connect(daemon, "codex-mcp-client");
  const first = await call(client, "search_skills", { query: "review pull request code changes", limit: 1 });
  const second = await call(client, "search_skills", { query: "review pull request code changes", limit: 1, offset: 1 });
  assert.equal(first.body.candidates.length, 1);
  assert.equal(second.body.candidates[0].rank, 2);
  assert.equal(first.body.total, second.body.total);
  const empty = await call(client, "search_skills", {});
  assert.equal(empty.body.abstained.reason, "empty_query");
  const tooMany = await client.callTool({ name: "search_skills", arguments: { query: "x", limit: 51 } });
  assert.equal(tooMany.isError, true);
  await client.close();
}));

test("SEP-2640 skills/list and skills/get serve the catalog", () => withDaemon(async (daemon) => {
  const client = await connect(daemon, "codex-mcp-client");
  assert.ok(client.getServerCapabilities()?.extensions?.["io.modelcontextprotocol/skills"]);
  const list = await client.request({ method: "skills/list", params: {} }, z.object({ skills: z.array(z.any()) }).passthrough());
  assert.deepEqual(list.skills.map((s) => s.frontmatter.name), ["code-review-notes", "pr-review", "release-plan"]);
  const got = await client.request({ method: "skills/get", params: { uri: uriOf("pr-review") } }, z.object({ skill: z.any() }).passthrough());
  assert.equal(got.skill.resources.length, 4);
  await assert.rejects(client.request({ method: "skills/get", params: { uri: uriOf("nope") } }, z.object({}).passthrough()), /Not a skill/);
  await client.close();
}));

test("HTTP endpoint rejects a missing bearer token and unknown sessions", () => withDaemon(async (daemon) => {
  const url = `http://127.0.0.1:${daemon.port}/mcp`;
  const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
  assert.equal((await fetch(url, { method: "POST", headers, body })).status, 401);
  for (const authorization of [`Bearer ${TOKEN}x`, `Bearer ${TOKEN.slice(1)}`, `Basic ${TOKEN}`, TOKEN]) {
    assert.equal((await fetch(url, { method: "POST", headers: { ...headers, authorization }, body })).status, 401, authorization);
  }
  const unknown = await fetch(url, { method: "POST", headers: { ...headers, authorization: `Bearer ${TOKEN}`, "mcp-session-id": "missing" }, body });
  assert.equal(unknown.status, 404);
}));

test("stdio proxy forwards tools/list and tools/call with the downstream client name", () => withDaemon(async (daemon) => {
  const proxyModule = fileURLToPath(new URL("../dist/mcp/stdio-proxy.js", import.meta.url));
  const client = new Client({ name: "openclaw-mcp", version: "1.0.0" });
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: ["--input-type=module", "-e", `const m = await import(${JSON.stringify(proxyModule)}); await m.runStdioProxy({ port: ${daemon.port}, token: ${JSON.stringify(TOKEN)} });`],
    stderr: "pipe",
  }));
  try {
    assert.match(client.getInstructions(), /search_skills/);
    const tools = (await client.listTools()).tools.map((t) => t.name).sort();
    assert.deepEqual(tools, ["load_skill", "read_skill_file", "search_skills"]);
    const search = await call(client, "search_skills", { query: "pr-review pull request code changes" }, { threadId: "oc1" });
    assert.equal(search.body.candidates[0].uri, uriOf("pr-review"));
  } finally {
    await client.close();
  }
  const rows = daemon.rows();
  assert.equal(rows[0].runtime, "openclaw");
  assert.equal(rows[0].attribution_method, "vendor_meta");
}));
