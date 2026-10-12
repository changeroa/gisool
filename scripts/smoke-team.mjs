import assert from "node:assert/strict";
const origin = "https://gisul.arkpoint.dev";
async function get(path) {
  const response = await fetch(origin + path, { redirect: "error", signal: AbortSignal.timeout(15000) });
  assert.equal(response.status, 200, `${path} failed (${response.status})`);
  return response.json();
}
const health = await get("/healthz");
if (process.env.GISUL_EXPECTED_COMMIT) assert.equal(health.server_version, process.env.GISUL_EXPECTED_COMMIT);
const metadata = await get("/.well-known/oauth-protected-resource/mcp");
assert.equal(metadata.resource, origin + "/mcp");
assert.deepEqual(metadata.authorization_servers, [origin]);
const authorization = await get("/.well-known/oauth-authorization-server");
assert.equal(authorization.authorization_endpoint, origin + "/authorize");
const unauthenticated = await fetch(origin + "/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }), redirect: "error" });
assert.equal(unauthenticated.status, 401);
assert.match(unauthenticated.headers.get("www-authenticate") ?? "", /resource_metadata=/);
console.log(JSON.stringify({ ...health, origin, oauthDiscovery: true, unauthenticatedDenied: true, authenticatedRead: "requires an actual member login; not established by this check" }));
