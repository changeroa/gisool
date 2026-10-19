import test from "node:test";
import assert from "node:assert/strict";
import { headersFor, metadata, modernClient, TOKEN, uriOf, VERSION, wire, withDaemon } from "./helpers/mcp.mjs";

const request = (params = {}, method = "tools/list") => ({ jsonrpc: "2.0", id: 1, method, params: { _meta: metadata(), ...params } });

test("each request requires valid protocol metadata without inheriting prior discovery", () => withDaemon(async (daemon) => {
  await modernClient(daemon.port).request("server/discover");
  for (const meta of [undefined, {}, { "io.modelcontextprotocol/protocolVersion": VERSION }, { "io.modelcontextprotocol/clientCapabilities": {} },
    { ...metadata(), "io.modelcontextprotocol/clientCapabilities": [] },
    { ...metadata(), "io.modelcontextprotocol/clientCapabilities": { roots: true } },
    { ...metadata(), "io.modelcontextprotocol/clientInfo": { name: "no-version" } },
    { ...metadata(), "invalid/key/path": true }]) {
    const result = await wire(daemon.port, request({ _meta: meta }));
    assert.equal(result.status, 400);
    assert.equal(result.body.error.code, -32602);
  }
  const withoutIdentity = metadata();
  delete withoutIdentity["io.modelcontextprotocol/clientInfo"];
  assert.equal((await wire(daemon.port, request({ _meta: withoutIdentity }))).status, 200);
}));

test("unsupported version errors identify the only supported revision", () => withDaemon(async (daemon) => {
  for (const requested of ["2025-11-25", "2027-01-01", "garbage"]) {
    const result = await wire(daemon.port, request({ _meta: metadata("test", { "io.modelcontextprotocol/protocolVersion": requested }) }));
    assert.equal(result.status, 400);
    assert.equal(result.body.error.code, -32022);
    assert.deepEqual(result.body.error.data, { requested, supported: [VERSION] });
  }
}));

test("HTTP headers are mandatory and must mirror method version and decoded name", () => withDaemon(async (daemon) => {
  const body = request({ uri: uriOf("pr-review") }, "resources/read");
  for (const [key, value] of [["mcp-protocol-version", ""], ["mcp-method", ""], ["mcp-name", ""], ["mcp-method", "tools/list"],
    ["mcp-protocol-version", "2025-11-25"], ["mcp-name", "wrong"], ["mcp-name", "=?base64?%%%?="]]) {
    const result = await wire(daemon.port, body, { [key]: value });
    assert.equal(result.status, 400, key);
    assert.equal(result.body.error.code, -32020, key);
  }
  const encoded = `=?base64?${Buffer.from(body.params.uri).toString("base64")}?=`;
  assert.equal((await wire(daemon.port, body, { "mcp-name": encoded })).status, 200);
  const badUtf8 = await wire(daemon.port, body, { "mcp-name": "=?base64?/w==?=" });
  assert.equal(badUtf8.body.error.code, -32020);
}));

test("encoded names preserve UTF-8 BOM and sentinel-like literals before validation", () => withDaemon(async (daemon) => {
  for (const name of ["\uFEFFsearch_skills", "=?base64?literal?=", "검색"]) {
    const result = await wire(daemon.port, request({ name }, "tools/call"));
    assert.equal(result.body.error.code, -32602, "a correctly mirrored unknown name is not a header mismatch");
  }
}));

const legacyPost = async (port, body, headers = {}) => {
  const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST", body: JSON.stringify(body),
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${TOKEN}`, ...headers },
  });
  const text = await res.text();
  return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : undefined };
};

test("legacy initialize opens a session served with legacy result shapes and client attribution", () => withDaemon(async (daemon) => {
  for (const [requested, negotiated] of [["2025-11-25", "2025-11-25"], ["2025-06-18", "2025-06-18"], ["2025-03-26", "2025-03-26"], ["2099-01-01", "2025-11-25"]]) {
    const init = await legacyPost(daemon.port, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: requested, capabilities: { roots: { listChanged: true } }, clientInfo: { name: "openclaw-mcp", version: "1" } } });
    assert.equal(init.status, 200);
    assert.equal(init.body.result.protocolVersion, negotiated);
  }
  const init = await legacyPost(daemon.port, { jsonrpc: "2.0", id: 77, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "openclaw-mcp", version: "1" } } });
  assert.equal(init.body.id, 77);
  assert.deepEqual(Object.keys(init.body.result).sort(), ["capabilities", "instructions", "protocolVersion", "serverInfo"]);
  assert.equal(init.body.result.serverInfo.name, "gisool");
  assert.ok(init.body.result.capabilities.tools && init.body.result.capabilities.resources);
  const session = init.headers.get("mcp-session-id");
  assert.ok(session);
  const headers = { "mcp-session-id": session, "mcp-protocol-version": "2025-11-25" };
  assert.equal((await legacyPost(daemon.port, { jsonrpc: "2.0", method: "notifications/initialized" }, headers)).status, 202);
  const tools = await legacyPost(daemon.port, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, headers);
  assert.deepEqual(tools.body.result.tools.map((t) => t.name), ["search_skills"]);
  for (const key of ["resultType", "ttlMs", "cacheScope", "_meta"]) assert.equal(key in tools.body.result, false, key);
  const search = await legacyPost(daemon.port, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "search_skills", arguments: { query: "pr-review pull request code changes" } } }, headers);
  assert.equal(JSON.parse(search.body.result.content[0].text).candidates[0].uri, uriOf("pr-review"));
  const read = await legacyPost(daemon.port, { jsonrpc: "2.0", id: 4, method: "resources/read", params: { uri: uriOf("pr-review") } }, headers);
  assert.equal(read.body.result.contents[0].mimeType, "text/markdown");
  assert.equal("ttlMs" in read.body.result, false);
  assert.deepEqual((await legacyPost(daemon.port, { jsonrpc: "2.0", id: 5, method: "ping" }, headers)).body.result, {});
  assert.deepEqual((await legacyPost(daemon.port, { jsonrpc: "2.0", id: 6, method: "resources/templates/list" }, headers)).body.result, { resourceTemplates: [] });
  const missing = await legacyPost(daemon.port, { jsonrpc: "2.0", id: 7, method: "resources/read", params: { uri: uriOf("missing") } }, headers);
  assert.equal(missing.status, 200);
  assert.equal(missing.body.error.code, -32602);
  const headerless = await legacyPost(daemon.port, { jsonrpc: "2.0", id: 8, method: "tools/list" }, { "mcp-session-id": "unknown-after-restart" });
  assert.equal(headerless.status, 200);
  assert.equal(headerless.body.result.tools.length, 1);
  const badInit = await legacyPost(daemon.port, { jsonrpc: "2.0", id: 9, method: "initialize", params: { protocolVersion: "2025-11-25" } });
  assert.equal(badInit.body.error.code, -32602);
  assert.deepEqual(daemon.rows().filter((r) => r.kind !== "error").map((r) => [r.kind, r.runtime]), [["search", "openclaw"], ["load", "openclaw"]]);
}));

test("modern requests never fall into the legacy era and legacy session headers never create modern state", () => withDaemon(async (daemon) => {
  const modernInitialize = await wire(daemon.port, request({}, "initialize"));
  assert.equal(modernInitialize.status, 404);
  assert.equal(modernInitialize.body.error.code, -32601);
  const listed = await wire(daemon.port, request(), { "mcp-session-id": "obsolete", "last-event-id": "obsolete" });
  assert.equal(listed.status, 200);
  assert.equal(listed.headers.has("mcp-session-id"), false);
  for (const method of ["GET", "DELETE"]) {
    const res = await fetch(`http://127.0.0.1:${daemon.port}/mcp`, { method, headers: { authorization: `Bearer ${TOKEN}` } });
    assert.equal(res.status, 405);
    assert.equal(res.headers.get("allow"), "POST");
  }
}));

test("unknown methods tools resources and malformed envelopes have standard error codes", () => withDaemon(async (daemon) => {
  for (const [method, params, code, status] of [
    ["not/a/method", {}, -32601, 404], ["resources/directory/read", { uri: uriOf("pr-review") }, -32601, 404],
    ["tools/call", { name: "removed-skill-tool", arguments: {} }, -32602, 400],
    ["tools/call", { name: "search_skills", arguments: [] }, -32602, 400],
    ["skills/get", { uri: uriOf("pr-review", "guide.md") }, -32602, 400],
    ["skills/get", { uri: uriOf("missing") }, -32602, 400],
    ["resources/read", { uri: uriOf("missing") }, -32602, 400],
    ["resources/read", { uri: "skill://local/agents/../secret" }, -32602, 400],
    ["resources/read", { uri: "file:///etc/hosts" }, -32602, 400],
    ["resources/read", { uri: 4 }, -32020, 400],
    ["skills/list", { cursor: 4 }, -32602, 400],
    ["tools/list", { cursor: "bogus" }, -32602, 400],
  ]) {
    const result = await wire(daemon.port, request(params, method));
    assert.equal(result.status, status, method);
    assert.equal(result.body.error.code, code, method);
    assert.equal(result.body.id, 1);
  }
  for (const body of [null, 123, "text", [request()], { ...request(), id: null }, { ...request(), id: 1.5 }, { ...request(), jsonrpc: "1.0" }, { jsonrpc: "2.0", id: 1, result: {} }]) {
    const res = await fetch(`http://127.0.0.1:${daemon.port}/mcp`, { method: "POST", headers: headersFor(request()), body: JSON.stringify(body) });
    assert.equal(res.status, 400);
    const error = await res.json();
    assert.equal(error.error.code, -32600);
    if (body?.id === 1) assert.equal(error.id, 1);
  }
}));

test("malformed JSON body limits and notifications obey HTTP framing", () => withDaemon(async (daemon) => {
  for (const [body, status, code] of [["{", 400, -32700], [JSON.stringify({ padding: "x".repeat(1024 * 1024) }), 413, -32600]]) {
    const result = await fetch(`http://127.0.0.1:${daemon.port}/mcp`, { method: "POST", headers: headersFor(request()), body });
    assert.equal(result.status, status);
    assert.equal((await result.json()).error.code, code);
  }
  const notification = await wire(daemon.port, { jsonrpc: "2.0", method: "notifications/initialized" });
  assert.equal(notification.status, 202);
  assert.equal(notification.body, undefined);
}));

test("HTTP requests advertise both response types", () => withDaemon(async (daemon) => {
  for (const accept of ["", "application/json", "text/event-stream", "text/plain"]) {
    assert.equal((await wire(daemon.port, request(), { accept })).status, 406);
  }
}));

test("missing or incorrect bearer tokens are rejected before request parsing", () => withDaemon(async (daemon) => {
  for (const authorization of ["", `Bearer ${TOKEN}x`, `Bearer ${TOKEN.slice(1)}`, `Basic ${TOKEN}`, TOKEN]) {
    const res = await wire(daemon.port, request(), { authorization });
    assert.equal(res.status, 401);
  }
  assert.equal(daemon.rows().length, 0);
}));
