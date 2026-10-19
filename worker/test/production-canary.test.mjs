import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { parse } from "yaml";
import { runCanary } from "../../scripts/production-canary.mjs";

const digest = bytes => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const runtimeVersion = "e".repeat(40);
const commit = "a".repeat(40);
const reader = "fixture-canary-reader";
const inventoryToken = "fixture-inventory-reader";
const bundle = build({ entryPoints: [fileURLToPath(new URL("../src/index.ts", import.meta.url))],
  bundle: true, write: false, format: "esm", platform: "browser", target: "es2022", external: ["cloudflare:workers"] });

async function fixture(t, packCount = 1) {
  const root = await mkdtemp(join(tmpdir(), "gisul-canary-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runtime = new Miniflare({ telemetry: { enabled: false }, logRequests: false, workers: [{ config: {
    type: "worker", name: "canary-test", compatibilityDate: "2026-09-03",
    manifest: { mainModule: "index.js", modules: { "index.js": { type: "esm", contents: (await bundle).outputFiles[0].text } } },
    env: { SKILLS_BUCKET: { type: "r2", name: "SKILLS_BUCKET" },
      GISUL_BEARER_TOKEN: { type: "text", value: reader }, GISUL_NATIVE_TOOLS: { type: "text", value: "true" },
      GISUL_SERVER_VERSION: { type: "text", value: runtimeVersion } }, exports: {},
  } }] });
  t.after(() => runtime.dispose());
  const bucket = await runtime.getR2Bucket("SKILLS_BUCKET");
  const skills = [], files = [];
  for (const name of ["scope", "inspect", "verify"]) {
    const uri = `skill://gisul/gisul/${name}/SKILL.md`;
    const frontmatter = { name, description: `${name} fixture` };
    const resources = [];
    for (const [relative, bytes] of [
      ["SKILL.md", Buffer.from(`---\nname: ${name}\ndescription: ${frontmatter.description}\n---\nRead the fixture.\n`)],
      ["references/data.bin", Buffer.from([0, 128, 255])],
    ]) {
      const file = { path: `skills/${name}/${relative}`, uri: uri.slice(0, -8) + relative, digest: digest(bytes), size: bytes.length };
      resources.push({ uri: file.uri, digest: file.digest, size: file.size });
      files.push(file);
      await bucket.put(`releases/${commit}/${file.path}`, bytes);
    }
    skills.push({ uri, frontmatter, resources });
  }
  const definition = { schema_version: 1, kind: "skill-pack", name: "review", display_name: "Fixture review",
    description: "Review fixture", scope: "Fixture", members: skills.map((skill, i) => ({
      uri: skill.uri, phase: ["scope", "investigate", "verify"][i], selection: "required", when: "Always",
    })) };
  const packs = [];
  for (let i = 0; i < packCount; i++) {
    const name = i === 0 ? "review" : `review-${i}`;
    const packDefinition = { ...definition, name };
    const packBytes = JSON.stringify(packDefinition);
    const pack = { uri: `pack://gisul/gisul/${name}`, definition: packDefinition,
      digest: digest(packBytes), size: Buffer.byteLength(packBytes) };
    packs.push(pack);
    files.push({ path: `packs/${name}.json`, digest: pack.digest, size: pack.size });
    await bucket.put(`releases/${commit}/packs/${name}.json`, packBytes);
  }
  const inventory = { schema_version: 1, commit, release: "fixture.1", skills, packs, files, aliases: {} };
  const snapshot = { status: 200, body: JSON.stringify(inventory) };
  const identity = { commit, release: inventory.release, inventory_digest: digest(snapshot.body) };
  await bucket.put(`releases/${commit}/inventory.json`, snapshot.body);
  await bucket.put(`releases/${commit}/complete.json`, JSON.stringify(identity));
  await bucket.put("current.json", JSON.stringify({ ...identity, revision: 1, sequence: 1,
    high_water: { commit, sequence: 1 }, previous: null, operation: "promote", activated_at: "2026-10-18T00:00:00.000Z" }));
  const inventoryRequests = [];
  const server = createServer((request, response) => {
    inventoryRequests.push({ method: request.method, authorization: request.headers.authorization });
    response.writeHead(snapshot.status, { "content-type": "application/json" });
    response.end(snapshot.body);
  });
  const listening = once(server, "listening");
  server.listen(0, "127.0.0.1");
  await listening;
  t.after(async () => {
    const closed = once(server, "close");
    server.close();
    server.closeAllConnections();
    await closed;
  });
  const env = { GISUL_CANARY_MCP_URL: new URL("/mcp", await runtime.ready).href,
    GISUL_CANARY_READER_TOKEN: reader, GISUL_CANARY_EXPECTED_RUNTIME: runtimeVersion,
    GISUL_CANARY_INVENTORY_URL: `http://127.0.0.1:${server.address().port}/inventory.json`,
    GISUL_CANARY_INVENTORY_TOKEN: inventoryToken, GISUL_CANARY_INVENTORY_SHA256: digest(snapshot.body),
    GISUL_CANARY_RECEIPT: join(root, "receipt.json") };
  const requests = [];
  const fetcher = async (url, options) => {
    assert.equal(options.redirect, "error");
    requests.push({ url: String(url), method: options?.method ?? "GET", body: options?.body && JSON.parse(options.body) });
    return fetch(url, options);
  };
  return { env, inventory, snapshot, bucket, inventoryRequests, requests, fetcher };
}

test("canary verifies actual Worker runtime, complete skill bytes and native packs without writes", { timeout: 30000 }, async t => {
  const f = await fixture(t);
  const receipt = await runCanary(f.env, f.fetcher);
  assert.equal(receipt.state, "complete", JSON.stringify(receipt));
  assert.deepEqual(receipt.checked, { skills: 3, resources: 6, packs: 1 });
  assert.equal(receipt.expected.commit, commit);
  assert.deepEqual(JSON.parse(await readFile(f.env.GISUL_CANARY_RECEIPT, "utf8")), receipt);
  assert.deepEqual(f.inventoryRequests, [{ method: "GET", authorization: `Bearer ${inventoryToken}` }]);
  const rpc = f.requests.filter(request => request.body).map(request => request.body);
  assert.ok(rpc.every(message => ["server/discover", "skills/list", "skills/get", "resources/read", "tools/call"].includes(message.method)));
  assert.ok(rpc.filter(message => message.method === "tools/call").every(message => ["search_packs", "load_pack"].includes(message.params.name)));
  assert.ok(rpc.filter(message => message.method === "resources/read").every(message => message.params._meta["io.gisul/commit"] === commit));
  assert.equal((await (await f.bucket.get("current.json")).json()).revision, 1);
  const child = spawn(process.execPath, [fileURLToPath(new URL("../../scripts/production-canary.mjs", import.meta.url))],
    { env: { ...process.env, ...f.env }, stdio: ["ignore", "pipe", "pipe"] });
  const closed = once(child, "close");
  t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  let output = "";
  child.stdout.on("data", bytes => { output += bytes; });
  const [code] = await closed;
  assert.equal(code, 0);
  const cliReceipt = JSON.parse(output);
  assert.equal(cliReceipt.state, "complete");
  assert.deepEqual(cliReceipt.checked, receipt.checked);
  assert.deepEqual(JSON.parse(await readFile(f.env.GISUL_CANARY_RECEIPT, "utf8")), cliReceipt);
});

test("canary checks every native pack across the 50-entry page boundary", { timeout: 30000 }, async t => {
  const f = await fixture(t, 51);
  const receipt = await runCanary(f.env, f.fetcher);
  assert.equal(receipt.state, "complete", JSON.stringify(receipt));
  assert.equal(receipt.checked.packs, 51);
  const searches = f.requests.filter(request => request.body?.params.name === "search_packs");
  assert.deepEqual(searches.map(request => request.body.params.arguments.offset), [0, 50]);
});

for (const scenario of ["runtime", "reader", "inventory-digest", "catalog", "resource", "pack"]) {
  test(`canary retains a failed receipt for ${scenario} drift`, { timeout: 30000 }, async t => {
    const f = await fixture(t);
    if (scenario === "runtime") f.env.GISUL_CANARY_EXPECTED_RUNTIME = "f".repeat(40);
    if (scenario === "reader") f.env.GISUL_CANARY_READER_TOKEN = "wrong-fixture-reader";
    if (scenario === "inventory-digest") f.env.GISUL_CANARY_INVENTORY_SHA256 = `sha256:${"f".repeat(64)}`;
    if (scenario === "catalog") {
      f.inventory.skills[0].frontmatter.description = "Different catalog";
      f.snapshot.body = JSON.stringify(f.inventory);
      f.env.GISUL_CANARY_INVENTORY_SHA256 = digest(f.snapshot.body);
    }
    if (scenario === "resource") await f.bucket.put(`releases/${commit}/skills/scope/references/data.bin`, "corrupt");
    if (scenario === "pack") await f.bucket.put(`releases/${commit}/packs/review.json`, "corrupt");
    const receipt = await runCanary(f.env, f.fetcher);
    assert.equal(receipt.state, "failed");
    assert.equal(receipt.phase, scenario === "inventory-digest" ? "inventory" : "mcp");
    assert.deepEqual(JSON.parse(await readFile(f.env.GISUL_CANARY_RECEIPT, "utf8")), receipt);
    if (scenario === "inventory-digest") assert.equal(f.requests.length, 1);
    assert.equal((await (await f.bucket.get("current.json")).json()).revision, 1);
  });
}

test("a changed active pointer cannot be hidden by successful pinned resource reads", { timeout: 30000 }, async t => {
  const f = await fixture(t);
  let changed = false;
  const receipt = await runCanary(f.env, async (url, options) => {
    const response = await f.fetcher(url, options);
    if (!changed && options?.body && JSON.parse(options.body).method === "resources/read") {
      changed = true;
      await f.bucket.delete("current.json");
    }
    return response;
  });
  assert.equal(changed, true);
  assert.equal(receipt.state, "failed");
  assert.equal(receipt.phase, "mcp");
  assert.equal(receipt.checked.resources, 6);
});

test("missing configuration retains a preflight receipt without any HTTP request", async t => {
  const root = await mkdtemp(join(tmpdir(), "gisul-canary-preflight-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "receipt.json");
  const receipt = await runCanary({ GISUL_CANARY_RECEIPT: path }, () => assert.fail("preflight must not make requests"));
  assert.equal(receipt.state, "failed");
  assert.equal(receipt.phase, "preflight");
  assert.equal(JSON.parse(await readFile(path, "utf8")).state, "failed");
  const valid = { GISUL_CANARY_MCP_URL: "https://fixture.example/mcp", GISUL_CANARY_READER_TOKEN: reader,
    GISUL_CANARY_EXPECTED_RUNTIME: runtimeVersion, GISUL_CANARY_INVENTORY_URL: "https://snapshot.example/inventory.json",
    GISUL_CANARY_INVENTORY_SHA256: `sha256:${"a".repeat(64)}`, GISUL_CANARY_RECEIPT: path };
  for (const override of [
    { GISUL_CANARY_MCP_URL: "http://fixture.example/mcp" },
    { GISUL_CANARY_MCP_URL: "https://user:secret@fixture.example/mcp" },
    { GISUL_CANARY_MCP_URL: "https://fixture.example/mcp?token=secret" },
    { GISUL_CANARY_EXPECTED_RUNTIME: "development" },
    { GISUL_CANARY_INVENTORY_URL: "https://fixture.example/admin/current" },
    { GISUL_CANARY_INVENTORY_SHA256: "unverified" },
  ]) {
    const invalid = await runCanary({ ...valid, ...override }, () => assert.fail("invalid config must not make requests"));
    assert.equal(invalid.state, "failed");
    assert.equal(invalid.phase, "preflight");
  }
});

test("the actual CLI exits unsuccessfully and redacts echoed reader and inventory tokens", { timeout: 30000 }, async t => {
  const f = await fixture(t);
  f.snapshot.status = 401;
  f.snapshot.body = `${reader} ${inventoryToken}`;
  const child = spawn(process.execPath, [fileURLToPath(new URL("../../scripts/production-canary.mjs", import.meta.url))],
    { env: { ...process.env, ...f.env }, stdio: ["ignore", "pipe", "pipe"] });
  const closed = once(child, "close");
  t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  let output = "";
  child.stdout.on("data", bytes => { output += bytes; });
  child.stderr.on("data", bytes => { output += bytes; });
  const [code] = await closed;
  assert.equal(code, 1);
  const text = await readFile(f.env.GISUL_CANARY_RECEIPT, "utf8");
  for (const token of [reader, inventoryToken]) {
    assert.ok(!text.includes(token));
    assert.ok(!output.includes(token));
  }
  assert.equal(JSON.parse(text).error.status, 401);
});

test("a malformed MCP response leaves none of its body, or a token prefix, in the receipt", { timeout: 30000 }, async t => {
  const f = await fixture(t);
  const fetcher = async (url, options) => String(url) === f.env.GISUL_CANARY_MCP_URL
    ? new Response(`${reader} echoed instead of JSON`, { status: 200 })
    : f.fetcher(url, options);
  const receipt = await runCanary(f.env, fetcher);
  assert.equal(receipt.state, "failed");
  assert.equal(receipt.phase, "mcp");
  const text = await readFile(f.env.GISUL_CANARY_RECEIPT, "utf8");
  assert.ok(!text.includes(reader.slice(0, 10)), text);
  assert.ok(!text.includes("echoed"), text);
});

test("scheduled canary is opt-in, read-only and retains receipts on failure", async () => {
  const workflow = parse(await readFile(new URL("../../.github/workflows/production-canary.yml", import.meta.url), "utf8"));
  assert.deepEqual(workflow.permissions, { contents: "read" });
  assert.ok(workflow.on.schedule.length > 0);
  assert.ok(workflow.on.workflow_dispatch !== undefined);
  assert.ok(workflow.jobs.canary.if.includes("GISUL_CANARY_ENABLED"));
  const upload = workflow.jobs.canary.steps.find(step => step.with?.path === "dist/receipts/production-canary.json");
  assert.equal(upload.if, "always()");
  assert.equal(upload.with["if-no-files-found"], "error");
});
