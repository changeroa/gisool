import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Miniflare } from "miniflare";

const origin = "https://gisul.example";
const uri = "skill://gisul/gisul/example/SKILL.md";
const hash = body => `sha256:${createHash("sha256").update(body).digest("hex")}`;
const bundle = build({ entryPoints: [fileURLToPath(new URL("../src/team.ts", import.meta.url))], bundle: true, write: false, format: "esm", platform: "browser", target: "es2022", external: ["cloudflare:workers"] });

async function release(bucket, letter) {
  const commit = letter.repeat(40);
  const markdown = `---\nname: example\ndescription: Team review workflow\n---\nRevision ${letter}\n`;
  const contents = [["SKILL.md", markdown], ["references/guide.md", `Guide ${letter}`]];
  const resources = contents.map(([path, text]) => ({ uri: uri.replace("SKILL.md", path), digest: hash(text), size: Buffer.byteLength(text) }));
  const files = contents.map(([path, text]) => ({ path: `skills/example/${path}`, uri: uri.replace("SKILL.md", path), digest: hash(text), size: Buffer.byteLength(text) }));
  for (const [index, [, text]] of contents.entries()) await bucket.put(`releases/${commit}/${files[index].path}`, text);
  const inventory = JSON.stringify({ schema_version: 1, commit, release: `team-${letter}`, skills: [{ uri, frontmatter: { name: "example", description: "Team review workflow" }, resources }], files, aliases: {} });
  const identity = { commit, release: `team-${letter}`, inventory_digest: hash(inventory) };
  await bucket.put(`releases/${commit}/inventory.json`, inventory);
  await bucket.put(`releases/${commit}/complete.json`, JSON.stringify(identity));
  await bucket.put("current.json", JSON.stringify({ ...identity, revision: letter === "a" ? 1 : 2, sequence: letter === "a" ? 1 : 2, operation: "promote", high_water: { commit, sequence: letter === "a" ? 1 : 2 }, previous: null, activated_at: new Date().toISOString() }));
  return { commit, markdown };
}

async function fixture(t, overrides = {}) {
  const state = { member: true, unavailable: false, revoked: false, identity: 42, calls: [] };
  const env = Object.fromEntries(Object.entries({ GISUL_PUBLIC_URL: origin, GISUL_GITHUB_ORG: "Ark-Point", GITHUB_CLIENT_ID: "github-client", GITHUB_CLIENT_SECRET: "github-secret", GISUL_WRITER_IDS: "42", GISUL_GITHUB_TOKEN: "content-writer", GISUL_BEARER_TOKEN: "legacy-reader", GISUL_PUBLISH_TOKEN: "publisher", GISUL_SERVER_VERSION: "team-fixture", ...overrides }).map(([name, value]) => [name, { type: "text", value }]));
  const runtime = new Miniflare({ telemetry: { enabled: false }, logRequests: false, workers: [{ config: { type: "worker", name: "team", compatibilityDate: "2026-09-03", compatibilityFlags: ["global_fetch_strictly_public"], manifest: { mainModule: "index.js", modules: { "index.js": { type: "esm", contents: (await bundle).outputFiles[0].text } } }, env: { ...env, SKILLS_BUCKET: { type: "r2", name: "skills" }, OAUTH_KV: { type: "kv", id: "oauth" } }, exports: {} }, dev: { outboundService: { type: "fetcher", handler: async request => {
    const url = new URL(request.url); state.calls.push({ host: url.host, path: url.pathname });
    if (url.href === "https://github.com/login/oauth/access_token") {
      const body = new URLSearchParams(await request.text());
      assert.equal(body.get("client_secret"), "github-secret");
      assert.ok(body.get("code_verifier"));
      return Response.json({ access_token: "github-user-token", token_type: "bearer", scope: "read:org" });
    }
    if (url.href === "https://api.github.com/user/memberships/orgs/Ark-Point") {
      assert.equal(request.headers.get("authorization"), "Bearer github-user-token");
      if (state.unavailable) return Response.json({}, { status: 503 });
      if (state.revoked) return Response.json({}, { status: 401 });
      if (!state.member) return Response.json({}, { status: 404 });
      return Response.json({ state: "active", role: "member", organization: { login: "Ark-Point" }, user: { id: state.identity, login: "teammate" } });
    }
    throw new Error(`Unexpected outbound request to ${url.host}${url.pathname}`);
  } } } }] });
  t.after(() => runtime.dispose());
  const bucket = await runtime.getR2Bucket("SKILLS_BUCKET");
  const first = await release(bucket, "a");
  const fetch = (path, options = {}) => runtime.dispatchFetch(origin + path, { redirect: "manual", ...options });
  const register = async () => {
    const res = await fetch("/oauth/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "Codex test <unsafe>", redirect_uris: ["http://127.0.0.1:34567/callback"], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] }) });
    assert.equal(res.status, 201, await res.clone().text());
    return (await res.json()).client_id;
  };
  const begin = async (scopes = "skills:read skills:write") => {
    const clientId = await register();
    const verifier = randomBytes(32).toString("base64url");
    const params = new URLSearchParams({ client_id: clientId, redirect_uri: "http://127.0.0.1:34567/callback", response_type: "code", state: "client-state", scope: scopes, code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256", resource: origin + "/mcp" });
    const response = await fetch(`/authorize?${params}`);
    const html = await response.text();
    assert.equal(response.status, 200, html);
    assert.ok(html.includes("Codex test &lt;unsafe&gt;"));
    const state = /name="state" value="([a-f0-9]+)"/.exec(html)[1];
    const cookie = response.headers.get("set-cookie").split(";")[0];
    return { clientId, verifier, state, cookie, params };
  };
  const authorize = (flow, action = "allow", extra = {}) => fetch("/authorize", { method: "POST", headers: { origin, cookie: flow.cookie, "content-type": "application/x-www-form-urlencoded", ...extra }, body: new URLSearchParams({ state: flow.state, action }) });
  const callback = flow => fetch(`/callback?state=${flow.state}&code=github-code`, { headers: { cookie: flow.cookie } });
  const exchange = async (flow, callbackResponse, verifier = flow.verifier) => {
    const code = new URL(callbackResponse.headers.get("location")).searchParams.get("code");
    return fetch("/oauth/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: flow.clientId, grant_type: "authorization_code", code, redirect_uri: "http://127.0.0.1:34567/callback", code_verifier: verifier, resource: origin + "/mcp" }) });
  };
  const login = async (scopes) => {
    const flow = await begin(scopes);
    assert.equal((await authorize(flow)).status, 302);
    const cb = await callback(flow); assert.equal(cb.status, 302, await cb.clone().text());
    const token = await exchange(flow, cb); assert.equal(token.status, 200, await token.clone().text());
    return { ...await token.json(), flow };
  };
  const rpc = (token, method, params = {}) => fetch("/mcp", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const tool = async (token, name, args) => {
    const response = await rpc(token, "tools/call", { name, arguments: args });
    assert.equal(response.status, 200, await response.clone().text());
    const result = (await response.json()).result;
    assert.equal(result.isError, false, JSON.stringify(result));
    return JSON.parse(result.content[0].text);
  };
  return { runtime, fetch, begin, authorize, callback, exchange, login, rpc, tool, bucket, first, state };
}

test("team endpoint advertises native OAuth and denies legacy/shared tokens and alternate hosts", async t => {
  const f = await fixture(t);
  const denied = await f.rpc("legacy-reader", "tools/list");
  assert.equal(denied.status, 401); assert.match(denied.headers.get("www-authenticate"), /resource_metadata/);
  const resource = await (await f.fetch("/.well-known/oauth-protected-resource/mcp")).json();
  assert.equal(resource.resource, origin + "/mcp");
  const metadata = await (await f.fetch("/.well-known/oauth-authorization-server")).json();
  assert.deepEqual(metadata.code_challenge_methods_supported, ["S256"]);
  assert.equal((await f.runtime.dispatchFetch("https://wrong.example/healthz")).status, 421);
});

test("member login enables direct search/load/read and pins files across later releases", async t => {
  const f = await fixture(t);
  const token = await f.login();
  assert.notEqual(token.access_token, "github-user-token");
  const tools = (await (await f.rpc(token.access_token, "tools/list")).json()).result.tools.map(tool => tool.name);
  assert.deepEqual(tools.sort(), ["create_skill", "get_skill_write_status", "load_skill", "read_skill_file", "search_skills", "update_skill"].sort());
  const found = await f.tool(token.access_token, "search_skills", { query: "review", mode: "automatic" });
  assert.equal(found.skills.length, 1);
  const loaded = await f.tool(token.access_token, "load_skill", { uri, commit: found.commit });
  assert.equal(loaded.markdown, f.first.markdown);
  await release(f.bucket, "b");
  const read = await f.tool(token.access_token, "read_skill_file", { skill_uri: uri, uri: uri.replace("SKILL.md", "references/guide.md"), load_id: loaded.load_id });
  assert.equal(read.text, "Guide a"); assert.equal(read.commit, f.first.commit);
  const directory = await f.tool(token.access_token, "read_skill_file", { skill_uri: uri, uri: uri.replace("/SKILL.md", "/references"), load_id: loaded.load_id });
  assert.equal(directory.resources.length, 1);
  const empty = await f.tool(token.access_token, "search_skills", { query: "absent" }); assert.equal(empty.totalMatches, 0);
  const outside = await (await f.rpc(token.access_token, "tools/call", { name: "read_skill_file", arguments: { skill_uri: uri, uri: "skill://gisul/gisul/other/SKILL.md", load_id: loaded.load_id } })).json();
  assert.equal(outside.result.isError, true);
  assert.equal((await f.fetch(`/callback?state=${token.flow.state}&code=replay`, { headers: { cookie: token.flow.cookie } })).status, 400);
});

test("reader scope cannot write; membership revocation and outages remain distinct", async t => {
  const f = await fixture(t);
  const token = await f.login("skills:read");
  const tools = (await (await f.rpc(token.access_token, "tools/list")).json()).result.tools;
  assert.equal(tools.length, 3);
  assert.equal((await f.rpc(token.access_token, "tools/call", { name: "create_skill", arguments: {} })).status, 403);
  f.state.unavailable = true;
  assert.equal((await f.rpc(token.access_token, "tools/list")).status, 503);
  f.state.unavailable = false; f.state.member = false;
  assert.equal((await f.rpc(token.access_token, "tools/list")).status, 403);
  f.state.member = true; f.state.revoked = true;
  assert.equal((await f.rpc(token.access_token, "tools/list")).status, 401);
  f.state.revoked = false;
  assert.equal((await f.rpc(token.access_token, "tools/list")).status, 200);
});

test("consent requires the browser binding and same origin; cancellation does not start GitHub auth", async t => {
  const f = await fixture(t); const flow = await f.begin();
  assert.equal((await f.authorize(flow, "allow", { origin: "https://attacker.example" })).status, 403);
  assert.equal((await f.authorize(flow, "allow", { cookie: "" })).status, 400);
  const denied = await f.authorize(flow, "deny");
  assert.equal(denied.status, 302); assert.equal(new URL(denied.headers.get("location")).searchParams.get("error"), "access_denied");
  assert.equal(f.state.calls.length, 0);
  assert.equal((await f.authorize(flow)).status, 400);
});

test("unconfigured login, expired flow, nonmember and invalid PKCE do not become success", async t => {
  const unconfigured = await fixture(t, { GITHUB_CLIENT_SECRET: "" });
  assert.equal((await unconfigured.fetch("/authorize")).status, 503);
  const f = await fixture(t); const flow = await f.begin();
  const kv = await f.runtime.getKVNamespace("OAUTH_KV");
  const saved = await kv.get(`gisul:login:${flow.state}`, "json");
  await kv.put(`gisul:login:${flow.state}`, JSON.stringify({ ...saved, expires: 1 }));
  assert.equal((await f.authorize(flow)).status, 400);
  const notMember = await f.begin(); await f.authorize(notMember); f.state.member = false;
  assert.equal((await f.callback(notMember)).status, 403);
  f.state.member = true;
  const wrongPkce = await f.begin(); await f.authorize(wrongPkce); const cb = await f.callback(wrongPkce);
  assert.equal((await f.exchange(wrongPkce, cb, randomBytes(32).toString("base64url"))).status, 400);
});

test("CI verification credential is read-only and never accesses publishing", async t => {
  const f = await fixture(t, { GISUL_CI_TOKEN: "ci-reader" });
  const response = await f.rpc("ci-reader", "tools/list");
  assert.equal(response.status, 200);
  assert.equal((await response.json()).result.tools.length, 3);
  assert.equal((await f.rpc("ci-reader", "tools/call", { name: "create_skill", arguments: {} })).status, 403);
  assert.equal((await f.fetch("/admin/current", { headers: { authorization: "Bearer ci-reader" } })).status, 401);
  assert.equal(f.state.calls.length, 0);
});

test("refresh preserves readonly grant and rechecks active membership", async t => {
  const f = await fixture(t);
  const token = await f.login("skills:read");
  const refresh = value => f.fetch("/oauth/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: token.flow.clientId, grant_type: "refresh_token", refresh_token: value, resource: origin + "/mcp" }) });
  const result = await refresh(token.refresh_token);
  assert.equal(result.status, 200, await result.clone().text());
  const next = await result.json();
  assert.equal((await (await f.rpc(next.access_token, "tools/list")).json()).result.tools.length, 3);
  f.state.member = false;
  const denied = await refresh(next.refresh_token);
  assert.equal(denied.status, 400, await denied.clone().text());
  assert.equal((await denied.json()).error, "invalid_grant");
});
