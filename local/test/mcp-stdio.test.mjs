import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { makeSandbox } from "./_helpers.mjs";
import { metadata, TOKEN, uriOf, withDaemon } from "./helpers/mcp.mjs";

test("stdio modern flow forwards per-request identity metadata caching and protocol errors", () => withDaemon(async (daemon) => {
  const sandbox = makeSandbox();
  const module = fileURLToPath(new URL("../dist/mcp/stdio-proxy.js", import.meta.url));
  const child = spawn(process.execPath, ["--input-type=module", "-e",
    `const m = await import(${JSON.stringify(module)}); await m.runStdioProxy({ port: ${daemon.port}, token: ${JSON.stringify(TOKEN)} });`],
  { env: sandbox.env, stdio: ["pipe", "pipe", "pipe"] });
  child.stderr.pipe(process.stderr, { end: false });
  const exited = once(child, "exit");
  const lines = createInterface({ input: child.stdout });
  let id = 0;
  const pending = new Map();
  lines.on("line", (line) => {
    const response = JSON.parse(line);
    pending.get(response.id)?.(response);
  });
  const rpc = (method, params = {}, name = "openclaw-mcp") => {
    const requestId = ++id;
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(requestId); reject(new Error(`No stdio response for ${method}`)); }, 5000);
      pending.set(requestId, (result) => { clearTimeout(timer); pending.delete(requestId); resolve(result); });
    });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params: { _meta: metadata(name, { threadId: name }), ...params } }) + "\n");
    return promise;
  };
  try {
    const discovery = (await rpc("server/discover")).result;
    assert.ok(discovery, "stdio must forward required per-request metadata");
    assert.deepEqual(discovery.supportedVersions, ["2026-07-28"]);
    assert.ok(discovery.capabilities.extensions["io.modelcontextprotocol/skills"]);
    assert.deepEqual((await rpc("tools/list")).result.tools.map((t) => t.name), ["search_skills"]);
    const search = (await rpc("tools/call", { name: "search_skills", arguments: { query: "pr-review pull request code changes" } })).result;
    assert.equal(JSON.parse(search.content[0].text).candidates[0].uri, uriOf("pr-review"));
    const skill = (await rpc("skills/get", { uri: uriOf("pr-review") })).result;
    assert.equal(skill.resultType, "complete");
    assert.equal(skill.ttlMs, 60000);
    assert.equal(skill.cacheScope, "private");
    assert.ok((await rpc("skills/list")).result.skills.some((e) => e.uri === skill.skill.uri));
    assert.ok((await rpc("resources/list")).result.resources.some((e) => e.uri === skill.skill.uri));
    assert.equal((await rpc("resources/read", { uri: uriOf("pr-review") })).result.contents[0].mimeType, "text/markdown");
    assert.equal((await rpc("resources/read", { uri: uriOf("pr-review", "guide.md") }, "senpi-mcp-client")).result.contents[0].text, "Review guide v1");
    const unknown = await rpc("skills/get", { uri: uriOf("pr-review", "guide.md") });
    assert.equal(unknown.error.code, -32602);
    assert.equal((await rpc("no/method")).error.code, -32601);
    assert.equal((await rpc("tools/list", { _meta: metadata("old", { "io.modelcontextprotocol/protocolVersion": "2025-11-25" }) })).error.code, -32022);
    const rows = daemon.rows();
    assert.deepEqual(rows.map((r) => r.kind), ["search", "load", "read_file"]);
    assert.deepEqual(rows.map((r) => r.runtime), ["openclaw", "openclaw", "omo"]);
    const legacy = (method, params) => rpc(method, { _meta: undefined, ...params });
    const init = await legacy("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "openclaw-mcp", version: "1" } });
    assert.equal(init.result.protocolVersion, "2025-06-18");
    assert.equal(init.result.serverInfo.name, "gisool");
    assert.equal("resultType" in init.result, false);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    const legacyTools = (await legacy("tools/list")).result;
    assert.deepEqual(legacyTools.tools.map((t) => t.name), ["search_skills"]);
    assert.equal("resultType" in legacyTools || "ttlMs" in legacyTools, false);
    assert.equal((await legacy("resources/read", { uri: uriOf("pr-review", "guide.md") })).result.contents[0].text, "Review guide v1");
    assert.equal((await legacy("resources/read", { uri: uriOf("missing") })).error.code, -32602);
    assert.deepEqual((await legacy("ping")).result, {});
    assert.equal(daemon.rows().at(-1).runtime, "openclaw");
    child.stdin.end();
    const [code] = await exited;
    assert.equal(code, 0);
  } finally {
    if (child.exitCode === null) { child.kill("SIGTERM"); await exited; }
    lines.close();
    sandbox.cleanup();
  }
}));
