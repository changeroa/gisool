import assert from "node:assert/strict";
import { once } from "node:events";
import { join } from "node:path";
import express from "express";
import { distImport, makeTempDir, removeDir, writeFixtureSkill } from "../_helpers.mjs";

const { openDb } = await distImport("store/db.js");
const { createStore } = await distImport("store/index.js");
const { createSearchIndex } = await distImport("search/index.js");
const { createCatalog } = await distImport("catalog/index.js");
const { createIngestDeps } = await distImport("ingest/pipeline.js");
const { registerMcp } = await distImport("mcp/http.js");

// Independent wire fixtures: do not derive these from the implementation under test.
export const VERSION = "2026-07-28";
export const TOKEN = "t".repeat(64);
export const uriOf = (dir, file = "SKILL.md") => `skill://local/agents/${dir}/${file}`;
export const metadata = (name = "codex-mcp-client", extra = {}) => ({
  "io.modelcontextprotocol/protocolVersion": VERSION,
  "io.modelcontextprotocol/clientCapabilities": {},
  "io.modelcontextprotocol/clientInfo": { name, version: "1.0.0" },
  ...extra,
});
export function headersFor(body) {
  const p = body.params ?? {};
  const headers = {
    "content-type": "application/json", accept: "application/json, text/event-stream",
    "mcp-protocol-version": p._meta?.["io.modelcontextprotocol/protocolVersion"] ?? VERSION,
    "mcp-method": body.method, authorization: `Bearer ${TOKEN}`,
  };
  const name = body.method === "resources/read" ? p.uri : p.name;
  if (["resources/read", "tools/call", "prompts/get"].includes(body.method) && typeof name === "string") {
    headers["mcp-name"] = /^[\x21-\x7e]+$/.test(name) && !name.startsWith("=?base64?") ? name : `=?base64?${Buffer.from(name).toString("base64")}?=`;
  }
  return headers;
}
export async function wire(port, body, headers = {}) {
  const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST", headers: { ...headersFor(body), ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(5000),
  });
  const text = await res.text();
  return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : undefined };
}
export function modernClient(port, token = TOKEN, name = "codex-mcp-client") {
  let id = 0;
  return {
    async request(method, params = {}, extra = {}) {
      const result = await wire(port, { jsonrpc: "2.0", id: ++id, method, params: { ...params, _meta: metadata(name, extra) } }, { authorization: `Bearer ${token}` });
      if (result.body?.error) throw Object.assign(new Error(result.body.error.message), result.body.error, { status: result.status });
      assert.equal(result.status, 200);
      assert.equal(result.body.id, id);
      assert.equal(result.body.result.resultType, "complete");
      return result.body.result;
    },
    callTool({ _meta = {}, ...params }) { return this.request("tools/call", params, _meta); },
    listTools() { return this.request("tools/list"); },
    readResource({ _meta = {}, ...params }) { return this.request("resources/read", params, _meta); },
  };
}
export async function call(client, name, args, meta = {}) {
  const result = await client.callTool({ name, arguments: args, _meta: meta });
  return { isError: result.isError === true, body: JSON.parse(result.content[0].text) };
}
export function seedSkills(root) {
  writeFixtureSkill(root, "pr-review", { description: "Review pull request code changes and leave review comments",
    files: { "guide.md": "Review guide v1", "refs/checklist.md": "checklist", "refs/style.md": "style" } });
  writeFixtureSkill(root, "asset-kit", { description: "Bundle of binary assets for slides",
    files: { "assets/logo.bin": Buffer.from([0, 1, 255]), "invalid.txt": Buffer.from([255, 254]) } });
  writeFixtureSkill(root, "code-review-notes", { description: "Summarize code review feedback on a pull request" });
  writeFixtureSkill(root, "release-plan", { description: "Plan a product release with milestones",
    frontmatter: { license: "Apache-2.0", metadata: { owner: "release-team", tier: "2", "io.modelcontextprotocol/future": "ignored" }, "allowed-tools": "Bash(git:*)" } });
}
export async function startDaemon(dir, opts = {}) {
  const db = openDb(join(dir, "gisool.db"));
  const store = createStore(db);
  const search = createSearchIndex(db);
  const catalog = createCatalog({ roots: [{ id: "agents", path: join(dir, "skills") }], log: () => {} });
  await catalog.refresh();
  search.rebuild(catalog.list());
  store.upsertSkills(catalog.list());
  const app = express();
  registerMcp(app, { catalog, search, store, ingest: createIngestDeps(store, { log: () => {}, ...opts }), token: TOKEN });
  const http = app.listen(0, "127.0.0.1");
  await once(http, "listening");
  let stopped = false;
  return {
    db, store, catalog, port: http.address().port,
    rows: () => db.prepare("SELECT kind, runtime, attribution_method, tool_use_id, trace_id, load_id, skill_uri, data_json FROM events ORDER BY ts, rowid").all()
      .map((r) => ({ ...r, data: JSON.parse(r.data_json) })),
    async stop() {
      if (stopped) return;
      stopped = true;
      http.closeAllConnections();
      await new Promise((resolve) => http.close(resolve));
      catalog.close();
      store.close();
    },
  };
}
export async function withDaemon(fn, opts) {
  const dir = makeTempDir("gisool-mcp-");
  seedSkills(join(dir, "skills"));
  const daemon = await startDaemon(dir, opts);
  try { await fn(daemon, dir); } finally { await daemon.stop(); removeDir(dir); }
}
