import { createHash } from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { call, modernClient, startDaemon, uriOf, withDaemon } from "./helpers/mcp.mjs";
import { writeFixtureSkill } from "./_helpers.mjs";

test("modern discovery advertises only the Skills extension, resources and search tool", () => withDaemon(async (daemon) => {
  const client = modernClient(daemon.port);
  const result = await client.request("server/discover");
  assert.deepEqual(result.supportedVersions, ["2026-07-28"]);
  assert.deepEqual(result.capabilities, { tools: {}, resources: {}, extensions: { "io.modelcontextprotocol/skills": {} } });
  assert.equal(result._meta["io.modelcontextprotocol/serverInfo"].name, "gisool");
  assert.equal(typeof result.instructions, "string");
  assert.deepEqual((await client.listTools()).tools.map((t) => t.name), ["search_skills"]);
}));

test("modern search and resource reads record load/read_file observations and survive restart", () => withDaemon(async (daemon, dir) => {
  const client = modernClient(daemon.port);
  await client.request("server/discover");
  assert.deepEqual((await client.listTools()).tools.map((t) => t.name), ["search_skills"]);
  const search = await call(client, "search_skills", { query: "pr-review pull request code changes" }, { threadId: "t1" });
  assert.equal(search.isError, false);
  assert.match(search.body.trace_id, /^[0-9a-f-]{36}$/);
  assert.ok(search.body.candidates.length >= 2);
  assert.equal(search.body.candidates[0].uri, uriOf("pr-review"));
  assert.deepEqual(search.body.candidates.map((c) => c.rank), search.body.candidates.map((_, i) => i + 1));
  const meta = { threadId: "t1", "app.gisool/traceId": search.body.trace_id };
  const entry = (await client.request("skills/get", { uri: uriOf("pr-review") })).skill;
  const load = await client.readResource({ uri: entry.uri, _meta: meta });
  const bytes = Buffer.from(load.contents[0].text);
  assert.equal(`sha256:${createHash("sha256").update(bytes).digest("hex")}`, entry.resources.find((r) => r.uri === entry.uri).digest);
  assert.equal(bytes.length, entry.resources.find((r) => r.uri === entry.uri).size);
  const read = await client.readResource({ uri: uriOf("pr-review", "guide.md"), _meta: meta });
  assert.equal(read.contents[0].text, "Review guide v1");
  const rows = daemon.rows();
  assert.deepEqual(rows.map((r) => r.kind), ["search", "load", "read_file"]);
  for (const r of rows) { assert.equal(r.runtime, "codex"); assert.equal(r.attribution_method, "vendor_meta"); assert.equal(r.trace_id, search.body.trace_id); }
  assert.equal(rows[2].data.bytes, Buffer.byteLength("Review guide v1"));
  assert.equal(rows[1].data.observationOnly, true);
  const session = daemon.store.sessions({})[0];
  assert.equal(session.state, "loaded");
  assert.deepEqual(daemon.store.trace(session.id).find((s) => s.kind === "search").detail.chosen, [entry.uri]);
  assert.ok(daemon.store.flow({}, "all_loads").links.some((l) => l.state === "loaded"));
  assert.equal(daemon.store.heatmap({}, "UTC", 0, 1).cells.reduce((n, c) => n + c.count, 0), 1);
  await daemon.stop();
  const restarted = await startDaemon(dir);
  try {
    const again = modernClient(restarted.port);
    assert.equal((await again.readResource({ uri: uriOf("pr-review", "guide.md"), _meta: meta })).contents[0].text, "Review guide v1");
  } finally { await restarted.stop(); }
}));

test("resource reads need no prior load and never inherit another request's client identity", () => withDaemon(async (daemon) => {
  const first = modernClient(daemon.port);
  await first.readResource({ uri: uriOf("pr-review", "guide.md"), _meta: { threadId: "first" } });
  await first.readResource({ uri: uriOf("pr-review"), _meta: { threadId: "first" } });
  const second = modernClient(daemon.port, undefined, "senpi-mcp-client");
  await second.readResource({ uri: uriOf("pr-review"), _meta: { threadId: "second" } });
  const rows = daemon.rows();
  assert.deepEqual(rows.map((r) => r.kind), ["read_file", "load", "load"]);
  assert.equal(rows[2].runtime, "omo");
  assert.notEqual(rows[1].load_id, rows[2].load_id);
}));

test("changed resource bytes fail until catalog refresh then match the refreshed manifest", () => withDaemon(async (daemon, dir) => {
  const client = modernClient(daemon.port);
  const before = (await client.request("skills/get", { uri: uriOf("pr-review") })).skill;
  writeFileSync(join(dir, "skills/pr-review/guide.md"), "Review guide v2 edited");
  await assert.rejects(client.readResource({ uri: uriOf("pr-review", "guide.md") }), (e) => e.code === -32603 && e.data.reason === "digest_mismatch");
  await daemon.catalog.refresh();
  const after = (await client.request("skills/get", { uri: uriOf("pr-review") })).skill;
  assert.notDeepEqual(before.resources, after.resources);
  assert.equal((await client.readResource({ uri: uriOf("pr-review", "guide.md") })).contents[0].text, "Review guide v2 edited");
  assert.equal(daemon.rows()[0].kind, "error");
}));

test("client and vendor metadata retain runtime attribution without transport sessions", () => withDaemon(async (daemon) => {
  await call(modernClient(daemon.port, undefined, "senpi-mcp-client"), "search_skills", { query: "plan a product release" });
  await call(modernClient(daemon.port, undefined, "claude-code"), "search_skills", { query: "plan a product release" }, { "claudecode/toolUseId": "tu9" });
  const rows = daemon.rows();
  assert.equal(rows[0].runtime, "omo");
  assert.equal(rows[1].runtime, "claude-code");
  assert.equal(rows[1].tool_use_id, "tu9");
}));

test("search supports offset pagination, abstention and actionable input validation", () => withDaemon(async (daemon) => {
  const client = modernClient(daemon.port);
  const first = await call(client, "search_skills", { query: "review pull request code changes", limit: 1 });
  const second = await call(client, "search_skills", { query: "review pull request code changes", limit: 1, offset: 1 });
  assert.equal(first.body.candidates.length, 1);
  assert.equal(second.body.candidates[0].rank, 2);
  assert.equal(first.body.total, second.body.total);
  assert.equal((await call(client, "search_skills", {})).body.abstained.reason, "empty_query");
  assert.equal((await call(client, "search_skills", { limit: 51 })).isError, true);
}));

test("all cacheable results carry complete, TTL, private scope and server identity", () => withDaemon(async (daemon) => {
  const client = modernClient(daemon.port);
  for (const [method, params] of [["server/discover", {}], ["tools/list", {}], ["skills/list", {}], ["skills/get", { uri: uriOf("pr-review") }], ["resources/list", {}], ["resources/read", { uri: uriOf("pr-review") }]]) {
    const result = await client.request(method, params);
    assert.equal(result.resultType, "complete", method);
    assert.equal(result.ttlMs, 60000, method);
    assert.equal(result.cacheScope, "private", method);
    assert.equal(result._meta["io.modelcontextprotocol/serverInfo"].name, "gisool", method);
  }
}));

test("skills entries preserve verbatim frontmatter including unknown and reserved metadata", () => withDaemon(async (daemon) => {
  const client = modernClient(daemon.port);
  const list = await client.request("skills/list");
  const got = await client.request("skills/get", { uri: uriOf("release-plan") });
  assert.deepEqual(got.skill, list.skills.find((s) => s.uri === got.skill.uri));
  assert.deepEqual(got.skill.frontmatter, { name: "release-plan", description: "Plan a product release with milestones",
    license: "Apache-2.0", metadata: { owner: "release-team", tier: "2", "io.modelcontextprotocol/future": "ignored" }, "allowed-tools": "Bash(git:*)" });
  assert.equal(daemon.rows().length, 0, "listing and metadata fetching are not loads");
}));

test("resources expose SKILL metadata and return every byte as lossless text or Base64", () => withDaemon(async (daemon) => {
  const client = modernClient(daemon.port);
  const listed = await client.request("resources/list");
  assert.ok(listed.resources.some((r) => r.uri === uriOf("pr-review") && r.mimeType === "text/markdown" && r.name === "pr-review" && r.description === "Review pull request code changes and leave review comments"));
  const skills = (await client.request("skills/list")).skills;
  for (const skill of skills) for (const resource of skill.resources) {
    const read = (await client.readResource({ uri: resource.uri })).contents[0];
    const bytes = read.text === undefined ? Buffer.from(read.blob, "base64") : Buffer.from(read.text, "utf8");
    assert.equal(bytes.length, resource.size, resource.uri);
    assert.equal(`sha256:${createHash("sha256").update(bytes).digest("hex")}`, resource.digest, resource.uri);
    assert.ok(listed.resources.some((r) => r.uri === resource.uri));
  }
  const invalid = (await client.readResource({ uri: uriOf("asset-kit", "invalid.txt") })).contents[0];
  assert.equal(invalid.text, undefined);
  assert.deepEqual(Buffer.from(invalid.blob, "base64"), Buffer.from([255, 254]));
}));

test("skills and resources paginate with stable method-scoped cursors and atomic manifests", () => withDaemon(async (daemon, dir) => {
  for (let i = 0; i < 55; i++) writeFixtureSkill(join(dir, "skills"), `page-${String(i).padStart(2, "0")}`, { files: { "a.txt": "a" } });
  await daemon.catalog.refresh();
  const client = modernClient(daemon.port);
  for (const [method, key] of [["skills/list", "skills"], ["resources/list", "resources"]]) {
    const first = await client.request(method);
    assert.equal(typeof first.nextCursor, "string");
    assert.deepEqual(await client.request(method), first);
    const all = [...first[key]];
    let cursor = first.nextCursor;
    const seenCursors = new Set();
    while (cursor !== undefined) {
      assert.equal(seenCursors.has(cursor), false, "pagination must advance");
      seenCursors.add(cursor);
      const next = await client.request(method, { cursor });
      assert.equal(next.cacheScope, first.cacheScope);
      all.push(...next[key]);
      cursor = next.nextCursor;
    }
    assert.equal(new Set(all.map((s) => s.uri)).size, all.length);
    if (key === "skills") {
      assert.equal(all.length, 59);
      for (const item of all) assert.deepEqual(item, (await client.request("skills/get", { uri: item.uri })).skill);
    } else assert.equal(all.length, new Set(daemon.catalog.list().flatMap((s) => s.resources.map((r) => r.uri))).size);
    const other = method === "skills/list" ? "resources/list" : "skills/list";
    await assert.rejects(client.request(other, { cursor: first.nextCursor }), (e) => e.code === -32602);
    await assert.rejects(client.request(method, { cursor: "" }), (e) => e.code === -32602);
  }
}));

test("search calls are rate limited independently of caller-supplied client identity", () => withDaemon(async (daemon) => {
  const client = modernClient(daemon.port);
  for (let i = 0; i < 120; i++) assert.equal((await call(client, "search_skills", {})).isError, false);
  const other = modernClient(daemon.port, undefined, "other-client");
  const limited = await call(other, "search_skills", {});
  assert.equal(limited.isError, true);
  assert.equal(limited.body.error.code, "rate_limited");
}, { now: () => 1000 }));
