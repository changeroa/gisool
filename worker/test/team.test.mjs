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

async function release(bucket, letter, registration, manual = false) {
  const commit = letter.repeat(40);
  const markdown = `---\nname: example\ndescription: Team review workflow\n${manual ? 'disable-model-invocation: true\n' : ''}---\nRevision ${letter}\n`;
  const contents = [["SKILL.md", markdown], ["references/guide.md", `Guide ${letter}`]];
  const resources = contents.map(([path, text]) => ({ uri: uri.replace("SKILL.md", path), digest: hash(text), size: Buffer.byteLength(text) }));
  const files = contents.map(([path, text]) => ({ path: `skills/example/${path}`, uri: uri.replace("SKILL.md", path), digest: hash(text), size: Buffer.byteLength(text) }));
  for (const [index, [, text]] of contents.entries()) await bucket.put(`releases/${commit}/${files[index].path}`, text);
  const inventory = JSON.stringify({ schema_version: 1, commit, release: `team-${letter}`, skills: [{ uri, frontmatter: { name: "example", description: "Team review workflow", ...(manual ? { 'disable-model-invocation': true } : {}) }, resources, ...(registration ? { registration } : {}) }], files, aliases: {} });
  const identity = { commit, release: `team-${letter}`, inventory_digest: hash(inventory) };
  await bucket.put(`releases/${commit}/inventory.json`, inventory);
  await bucket.put(`releases/${commit}/complete.json`, JSON.stringify(identity));
  await bucket.put("current.json", JSON.stringify({ ...identity, revision: letter === "a" ? 1 : 2, sequence: letter === "a" ? 1 : 2, operation: "promote", high_water: { commit, sequence: letter === "a" ? 1 : 2 }, previous: null, activated_at: new Date().toISOString() }));
  return { commit, markdown };
}

async function fixture(t, overrides = {}) {
  const state = { member: true, unavailable: false, revoked: false, identity: 42, repositoryForbidden: false, githubToken: "github-user-token", tokenExpiry: 28800, refreshes: 0, writes: [], calls: [] };
  const env = Object.fromEntries(Object.entries({ GISUL_PUBLIC_URL: origin, GISUL_GITHUB_ORG: "Ark-Point", GITHUB_CLIENT_ID: "github-client", GITHUB_CLIENT_SECRET: "github-secret", GISUL_SKILLS_REPOSITORY: "Ark-Point/gisul-skills", GISUL_PUBLISH_WORKFLOW: "publish.yml", GISUL_BEARER_TOKEN: "legacy-reader", GISUL_PUBLISH_TOKEN: "publisher", GISUL_SERVER_VERSION: "team-fixture", ...overrides }).map(([name, value]) => [name, { type: "text", value }]));
  const runtime = new Miniflare({ telemetry: { enabled: false }, logRequests: false, workers: [{ config: { type: "worker", name: "team", compatibilityDate: "2026-09-03", compatibilityFlags: ["global_fetch_strictly_public"], manifest: { mainModule: "index.js", modules: { "index.js": { type: "esm", contents: (await bundle).outputFiles[0].text } } }, env: { ...env, SKILLS_BUCKET: { type: "r2", name: "skills" }, OAUTH_KV: { type: "kv", id: "oauth" } }, exports: {} }, dev: { outboundService: { type: "fetcher", handler: async request => {
    const url = new URL(request.url); state.calls.push({ host: url.host, path: url.pathname });
    if (url.href === "https://github.com/login/oauth/access_token") {
      const body = new URLSearchParams(await request.text());
      assert.equal(body.get("client_secret"), "github-secret");
      if (body.get("grant_type") === "refresh_token") {
        assert.equal(body.get("refresh_token"), "github-refresh");
        state.githubToken = "github-refreshed-token"; state.refreshes++;
        return Response.json({ access_token: state.githubToken, refresh_token: "github-refresh", expires_in: 28800, token_type: "bearer", scope: "" });
      }
      assert.ok(body.get("code_verifier"));
      return Response.json({ access_token: state.githubToken, refresh_token: "github-refresh", expires_in: state.tokenExpiry, token_type: "bearer", scope: "" });
    }
    if (url.href === "https://api.github.com/user/memberships/orgs/Ark-Point") {
      assert.equal(request.headers.get("authorization"), `Bearer ${state.githubToken}`);
      if (state.unavailable) return Response.json({}, { status: 503 });
      if (state.revoked) return Response.json({}, { status: 401 });
      if (!state.member) return Response.json({}, { status: 404 });
      return Response.json({ state: "active", role: "member", organization: { login: "Ark-Point" }, user: { id: state.identity, login: "teammate" } });
    }
    if (url.origin === "https://api.github.com" && url.pathname.startsWith("/repos/Ark-Point/gisul-skills")) {
      assert.equal(request.headers.get("authorization"), `Bearer ${state.githubToken}`, "Writes must use the current member token, never a shared server token");
      const path = url.pathname.slice("/repos/Ark-Point/gisul-skills".length);
      assert.notEqual(path, "", "Do not rederive saved consent from GitHub repository roles");
      if (state.repositoryForbidden) return Response.json({ message: "Resource not accessible by integration" }, { status: 403 });
      if (request.method !== "GET") { state.writes.push({ path, body: await request.json() }); }
      if (path === "/git/ref/heads/main") return Response.json({ object: { sha: "c".repeat(40) } });
      if (path === `/git/commits/${"c".repeat(40)}`) return Response.json({ tree: { sha: "tree" } });
      if (path === "/git/trees/tree") return Response.json({ tree: [], truncated: false });
      if (path === "/git/trees") return Response.json({ sha: "new-tree" });
      if (path === "/git/commits") return Response.json({ sha: "d".repeat(40) });
      if (path === "/git/refs/heads/main") return Response.json({ object: { sha: "d".repeat(40) } });
      if (path.startsWith("/compare/")) return Response.json({ status: "diverged" });
      if (path === "/actions/workflows/publish.yml/runs") return Response.json({ workflow_runs: [{ status: "in_progress", html_url: "https://github.com/Ark-Point/gisul-skills/actions/runs/1" }] });
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

test("native discovery ranks natural requests, preserves invocation and pins the selected release", async t => {
  const f = await fixture(t);
  const a = await release(f.bucket, 'a', undefined, true);
  const token = (await f.login()).access_token;
  const query = 'Please inspect the team review workflow for this new task';
  const found = await f.tool(token, 'search_skills', { query, mode: 'discovery' });
  assert.equal(found.skills[0].uri, uri);
  assert.equal(found.skills[0].invocation, 'explicit');
  assert.equal((await f.tool(token, 'search_skills', { query, mode: 'automatic' })).totalMatches, 0);
  const invalid = await (await f.rpc(token, 'tools/call', { name: 'search_skills', arguments: { mode: 'discovery' } })).json();
  assert.equal(invalid.result.isError, true);
  assert.equal((await f.tool(token, 'search_skills', { query: 'banana smoothie recipe', mode: 'discovery' })).totalMatches, 0);
  await release(f.bucket, 'b');
  const loaded = await f.tool(token, 'load_skill', { uri: found.skills[0].uri, commit: found.commit });
  assert.equal(loaded.commit, a.commit);
  assert.match(loaded.markdown, /Revision a/);
});

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

test("native search and load expose four registration fields and keep them pinned across edits", async t => {
  const f = await fixture(t);
  const token = await f.login();
  const fields = ["created_by", "created_at", "updated_by", "updated_at"];
  const pick = value => Object.fromEntries(fields.map(key => [key, value[key]]));
  const old = await f.tool(token.access_token, "load_skill", { uri });
  assert.deepEqual(pick(old), Object.fromEntries(fields.map(key => [key, null])));
  const first = { created_by: "alice", created_at: "2026-09-23T00:00:00.000Z", updated_by: "alice", updated_at: "2026-09-23T00:00:00.000Z" };
  const registered = await release(f.bucket, "b", first);
  for (const mode of ["legacy", "explicit", "automatic"]) {
    const found = await f.tool(token.access_token, "search_skills", { query: "review", mode });
    assert.deepEqual(pick(found.skills[0]), first);
    assert.equal(Object.hasOwn(found.skills[0], "source"), false);
  }
  const edited = { ...first, updated_by: "bob", updated_at: "2026-09-24T00:00:00.000Z" };
  await release(f.bucket, "c", edited);
  assert.deepEqual(pick(await f.tool(token.access_token, "load_skill", { uri })), edited);
  assert.deepEqual(pick(await f.tool(token.access_token, "load_skill", { uri, commit: registered.commit })), first);
  const pinned = await f.tool(token.access_token, "search_skills", { commit: registered.commit });
  assert.deepEqual(pick(pinned.skills[0]), first);
});

test("invalid registration metadata cannot be served as a verified release", async t => {
  const f = await fixture(t);
  const token = await f.login();
  const valid = { created_by: "alice", created_at: "2026-09-23T00:00:00.000Z", updated_by: "bob", updated_at: "2026-09-24T00:00:00.000Z" };
  for (const registration of [{ ...valid, updated_at: "2026-09-22T00:00:00.000Z" }, { ...valid, created_by: "<forged>" }, { ...valid, created_at: "2026-02-30T00:00:00.000Z" }, { ...valid, source: "extra" }, { created_by: "alice" }]) {
    await release(f.bucket, "b", registration);
    const response = await f.rpc(token.access_token, "tools/call", { name: "search_skills", arguments: {} });
    const result = await response.json();
    assert.equal(result.result.isError, true, JSON.stringify(result));
    assert.match(result.result.content[0].text, /registration metadata/);
  }
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

test("approved write consent persists through refresh without a server allowlist or repository-role sync", async t => {
  const f = await fixture(t);
  const original = await f.login();
  const refreshed = await f.fetch("/oauth/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: original.flow.clientId, grant_type: "refresh_token", refresh_token: original.refresh_token, resource: origin + "/mcp" }) });
  assert.equal(refreshed.status, 200);
  const token = await refreshed.json();
  assert.ok(token.scope.includes("skills:write"));
  const names = (await (await f.rpc(token.access_token, "tools/list")).json()).result.tools.map(t => t.name);
  assert.ok(names.includes("create_skill"));
  const written = await f.tool(token.access_token, "create_skill", { name: "new-skill", markdown: "---\nname: new-skill\ndescription: A team workflow\n---\nHello\n" });
  assert.equal(written.status, "accepted");
  assert.equal(f.state.writes.length, 3);
  assert.equal(f.state.writes.at(-1).body.force, false);
  const pending = await f.tool(token.access_token, "get_skill_write_status", { commit: written.commit });
  assert.equal(pending.status, "pending");
  assert.equal(pending.workflow_status, "in_progress");
  assert.equal(f.state.calls.filter(call => call.path === "/repos/Ark-Point/gisul-skills").length, 0);
  f.state.repositoryForbidden = true;
  const denied = await f.rpc(token.access_token, "tools/call", { name: "create_skill", arguments: { name: "another", markdown: "---\nname: another\ndescription: Another skill\n---\nHello\n" } });
  assert.equal(denied.status, 200);
  const denial = (await denied.json()).result;
  assert.equal(denial.isError, true);
  assert.match(denial.content[0].text, /GitHub did not allow/);
  assert.equal(f.state.writes.length, 3, "Saved consent cannot bypass GitHub token permissions");
});

test("expiring GitHub App user token is refreshed and the replacement is used for repository requests", async t => {
  const f = await fixture(t); f.state.tokenExpiry = 1;
  const token = await f.login();
  assert.equal(f.state.refreshes, 1);
  assert.equal((await f.rpc(token.access_token, "tools/list")).status, 200);
});

test("consent redirect requests GitHub App permissions without broad OAuth repo scope", async t => {
  const f = await fixture(t); const flow = await f.begin();
  const response = await f.authorize(flow);
  const upstream = new URL(response.headers.get("location"));
  assert.equal(upstream.origin, "https://github.com");
  assert.equal(upstream.searchParams.has("scope"), false);
  assert.equal(upstream.searchParams.get("code_challenge_method"), "S256");
});

test("OAuth app requests repository consent only for an editing connection", async t => {
  const f = await fixture(t, { GITHUB_AUTH_MODE: "oauth" });
  for (const [scope, expected] of [["skills:read", "read:org"], ["skills:read skills:write", "read:org repo"]]) {
    const response = await f.authorize(await f.begin(scope));
    assert.equal(new URL(response.headers.get("location")).searchParams.get("scope"), expected);
  }
});
