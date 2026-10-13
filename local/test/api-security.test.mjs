import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { distImport, makeSandbox, PACKAGE_ROOT } from "./_helpers.mjs";
import { bearer, fixtureText, http, jsonHeaders, startTestServer } from "./helpers/api.mjs";

const { startServer, createFileLogger } = await distImport("server.js");
const { dashCookieValue } = await distImport("api/security.js");

let s;
before(async () => { s = await startTestServer(); });
after(async () => { await s.stop(); });

test("binds 127.0.0.1 only and /healthz answers without auth", async () => {
  assert.equal(s.host, "127.0.0.1");
  const res = await http(s.port, { path: "/healthz" });
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
  assert.equal(res.json.name, "gisool");
  assert.equal(typeof res.json.version, "string");
  assert.equal((await http(s.port, { path: "/healthz", headers: { Host: `localhost:${s.port}` } })).status, 200);
});

test("wrong Host, foreign Origin, and cross-site fetches are refused with 403", async () => {
  const host = await http(s.port, { path: "/api/stats", headers: { Host: "evil.example", ...bearer(s.token) } });
  assert.equal(host.status, 403);
  assert.equal(host.json.error, "host_not_allowed");
  const wrongPort = await http(s.port, { path: "/healthz", headers: { Host: `127.0.0.1:${s.port + 1}` } });
  assert.equal(wrongPort.status, 403);
  const origin = await http(s.port, { path: "/api/stats", headers: { Origin: "http://evil.example", ...bearer(s.token) } });
  assert.equal(origin.status, 403);
  assert.equal(origin.json.error, "origin_not_allowed");
  const sameOrigin = await http(s.port, { path: "/api/stats", headers: { Origin: `http://localhost:${s.port}`, ...bearer(s.token) } });
  assert.equal(sameOrigin.status, 200);
  const crossSite = await http(s.port, { path: "/api/stats", headers: { "Sec-Fetch-Site": "cross-site", ...bearer(s.token) } });
  assert.equal(crossSite.status, 403);
});

test("missing or wrong bearer on /mcp, /ingest, and /api is 401", async () => {
  const init = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  assert.equal((await http(s.port, { method: "POST", path: "/mcp", headers: { "Content-Type": "application/json" }, body: init })).status, 401);
  assert.equal((await http(s.port, { method: "POST", path: "/ingest/otlp/v1/logs", headers: { "Content-Type": "application/json" }, body: "{}" })).status, 401);
  assert.equal((await http(s.port, { method: "POST", path: "/ingest/hook/claude-code", headers: { "Content-Type": "application/json", Authorization: "Bearer nope" }, body: "{}" })).status, 401);
  assert.equal((await http(s.port, { path: "/api/stats" })).status, 401);
});

test("case and percent-encoding variants of protected paths never reach a handler without auth", async () => {
  const json = { "Content-Type": "application/json" };
  const variants = [
    { method: "GET", path: "/API/sessions" },
    { method: "GET", path: "/Api/stats" },
    { method: "POST", path: "/INGEST/hook/codex", headers: json, body: JSON.stringify({ prompt: "INJECTED-BY-NOAUTH" }) },
    { method: "POST", path: "/Ingest/otlp/v1/logs", headers: json, body: "{}" },
    { method: "GET", path: "/%61pi/sessions" },
    { method: "GET", path: "/%41PI/stats" },
    { method: "POST", path: "/%69ngest/hook/codex", headers: json, body: "{}" },
    { method: "POST", path: "/MCP", headers: json, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) },
  ];
  for (const v of variants) {
    const res = await http(s.port, v);
    assert.ok([401, 404].includes(res.status), `${v.method} ${v.path} -> ${res.status}`);
  }
  assert.equal((await http(s.port, { path: "/api/%E0%A4%A" })).status, 400);
  const sessions = (await http(s.port, { path: "/api/sessions", headers: bearer(s.token) })).json;
  assert.ok(!JSON.stringify(sessions).includes("INJECTED-BY-NOAUTH"));
});

test("routing is case-sensitive; lowercase protected paths behave unchanged", async () => {
  assert.equal((await http(s.port, { path: "/API/sessions", headers: bearer(s.token) })).status, 404);
  assert.equal((await http(s.port, { path: "/api/sessions", headers: bearer(s.token) })).status, 200);
  assert.equal((await http(s.port, { path: "/api/stats", headers: bearer(s.token) })).status, 200);
  assert.equal((await http(s.port, { path: "/api/sessions" })).status, 401);
  assert.equal((await http(s.port, { method: "POST", path: "/ingest/hook/codex", headers: { "Content-Type": "application/json" }, body: "{}" })).status, 401);
});

test("GET /?token= sets an HttpOnly SameSite=Strict cookie that works for /api only", async () => {
  const wrong = await http(s.port, { path: "/?token=nope" });
  assert.equal(wrong.status, 401);
  const res = await http(s.port, { path: `/?token=${s.token}` });
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, "/");
  const setCookie = res.headers["set-cookie"][0];
  assert.match(setCookie, /^gisool_dash=[0-9a-f]{64};/);
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Strict/);
  assert.match(setCookie, /Path=\//);
  const cookie = setCookie.split(";")[0];
  assert.equal(cookie, `gisool_dash=${dashCookieValue(s.token)}`);

  assert.equal((await http(s.port, { path: "/api/stats", headers: { Cookie: cookie } })).status, 200);
  assert.equal((await http(s.port, { path: "/api/stats", headers: { Cookie: "gisool_dash=forged" } })).status, 401);
  const mcp = await http(s.port, { method: "POST", path: "/mcp", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: "{}" });
  assert.equal(mcp.status, 401);
  const ingest = await http(s.port, { method: "POST", path: "/ingest/hook/claude-code", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: "{}" });
  assert.equal(ingest.status, 401);
});

test("dashboard index is served uncached", async () => {
  const res = await http(s.port, { path: "/" });
  assert.equal(res.status, 200);
  assert.equal(res.headers["cache-control"], "no-store");
  assert.match(res.text, /<html/i);
});

test("non-JSON mutations are 415; OTLP protobuf gets an http/json hint", async () => {
  const plain = await http(s.port, { method: "POST", path: "/api/eval-cases", headers: { ...bearer(s.token), "Content-Type": "text/plain" }, body: "query" });
  assert.equal(plain.status, 415);
  const proto = await http(s.port, { method: "POST", path: "/ingest/otlp/v1/logs", headers: { ...bearer(s.token), "Content-Type": "application/x-protobuf" }, body: Buffer.from([1, 2, 3]) });
  assert.equal(proto.status, 415);
  assert.match(proto.json.hint, /http\/json/);
});

test("body limits: 2 MB JSON is 413, 9 MB OTLP is 413 and counted as rejected", async () => {
  const two = JSON.stringify({ query: "x".repeat(2 * 1024 * 1024) });
  const res = await http(s.port, { method: "POST", path: "/api/eval-cases", headers: jsonHeaders(s.token), body: two });
  assert.equal(res.status, 413);
  const before = (await http(s.port, { path: "/api/stats", headers: bearer(s.token) })).json.ingest.rejected;
  const nine = JSON.stringify({ resourceLogs: [], pad: "x".repeat(9 * 1024 * 1024) });
  const big = await http(s.port, { method: "POST", path: "/ingest/otlp/v1/logs", headers: jsonHeaders(s.token), body: nine });
  assert.equal(big.status, 413);
  const stats = (await http(s.port, { path: "/api/stats", headers: bearer(s.token) })).json;
  assert.ok(stats.ingest.rejected >= 1);
  assert.equal(stats.ingest.rejected, before + 1);
  const ok = await http(s.port, { method: "POST", path: "/ingest/otlp/v1/logs", headers: jsonHeaders(s.token), body: fixtureText("claude-otlp-user-prompt.json") });
  assert.equal(ok.status, 202);
});

test("auth runs before body parsing: an unauthenticated 2 MB ingest body is 401, not 413, and is not counted", async () => {
  const before = (await http(s.port, { path: "/api/stats", headers: bearer(s.token) })).json.ingest.rejected;
  const two = JSON.stringify({ prompt: "x".repeat(2 * 1024 * 1024) });
  const res = await http(s.port, { method: "POST", path: "/ingest/hook/codex", headers: { "Content-Type": "application/json" }, body: two });
  assert.equal(res.status, 401);
  assert.equal(res.json.error, "unauthorized");
  const badJson = await http(s.port, { method: "POST", path: "/ingest/hook/codex", headers: { "Content-Type": "application/json" }, body: "{not json" });
  assert.equal(badJson.status, 401);
  assert.equal((await http(s.port, { path: "/api/stats", headers: bearer(s.token) })).json.ingest.rejected, before);
  const authedBad = await http(s.port, { method: "POST", path: "/ingest/hook/codex", headers: jsonHeaders(s.token), body: "{not json" });
  assert.equal(authedBad.status, 400);
  const authedBig = await http(s.port, { method: "POST", path: "/ingest/hook/codex", headers: jsonHeaders(s.token), body: two });
  assert.equal(authedBig.status, 413);
});

test("malformed /assets paths are 400 or 404, never 500", async () => {
  for (const path of ["/assets/%E0%A4%A", "/assets/..%2f..%2fcli%2fmain.js", "/assets/%2e%2e/%2e%2e/package.json", "/assets/nope.js"]) {
    const res = await http(s.port, { path });
    assert.ok([400, 404].includes(res.status), `${path} -> ${res.status}`);
  }
});

test("a second server on the same port fails with port_in_use", async () => {
  const sandbox = makeSandbox();
  try {
    await assert.rejects(
      startServer({ port: s.port, captureLevel: "full", retentionDays: null, roots: [], runtimes: {} }, { gisoolHome: sandbox.env.GISOOL_HOME, handleSignals: false }),
      (error) => error.code === "port_in_use",
    );
  } finally {
    sandbox.cleanup();
  }
});

test("the CLI exits 1 with port_in_use when the port is taken", { skip: !existsSync(new URL("dist/cli/main.js", PACKAGE_ROOT)) }, async () => {
  const sandbox = makeSandbox();
  try {
    const child = spawn(process.execPath, [fileURLToPath(new URL("dist/cli/main.js", PACKAGE_ROOT)), "serve", "--port", String(s.port)], { env: sandbox.env, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (c) => { stderr += c; });
    const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
    const [code] = await once(child, "exit");
    clearTimeout(timer);
    assert.equal(code, 1);
    assert.match(stderr, /port_in_use/);
  } finally {
    sandbox.cleanup();
  }
});

test("daemon log is written under GISOOL_HOME/logs and rotates with one backup", () => {
  const log = join(s.gisoolHome, "logs", "daemon.log");
  assert.match(readFileSync(log, "utf8"), /listening on http:\/\/127\.0\.0\.1:/);
  const path = join(s.home, "rot", "daemon.log");
  const write = createFileLogger(path, 64);
  write("a".repeat(80));
  write("second");
  write("third");
  assert.match(readFileSync(`${path}.1`, "utf8"), /a{80}/);
  assert.match(readFileSync(path, "utf8"), /second\n.*third/s);
  writeFileSync(path, "y".repeat(100));
  write("fourth");
  assert.match(readFileSync(`${path}.1`, "utf8"), /^y+$/);
  assert.ok(!existsSync(`${path}.2`));
});
