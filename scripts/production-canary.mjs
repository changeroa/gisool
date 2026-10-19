import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { manifestDigest, parseInventory } from "../worker/src/release-reader.ts";
import { assertCommit, sha256 } from "../worker/src/r2-objects.ts";

// A parser message quotes the start of the text, which can be a credential the redaction only matches whole.
function parseJson(text, source) {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${source} is not valid JSON`);
  }
}

export async function runCanary(env = process.env, fetcher = fetch) {
  const receipt = { schema_version: 1, state: "failed", phase: "preflight",
    started_at: new Date().toISOString(), expected: null,
    checked: { skills: 0, resources: 0, packs: 0 } };
  const secrets = [env.GISUL_CANARY_READER_TOKEN, env.GISUL_CANARY_INVENTORY_TOKEN].filter(Boolean);
  try {
    for (const key of ["GISUL_CANARY_MCP_URL", "GISUL_CANARY_READER_TOKEN", "GISUL_CANARY_EXPECTED_RUNTIME",
      "GISUL_CANARY_INVENTORY_URL", "GISUL_CANARY_INVENTORY_SHA256"]) {
      assert.ok(typeof env[key] === "string" && env[key].trim(), `${key} is required`);
    }
    const endpoint = new URL(env.GISUL_CANARY_MCP_URL);
    const inventoryUrl = new URL(env.GISUL_CANARY_INVENTORY_URL);
    for (const url of [endpoint, inventoryUrl]) {
      assert.ok(url.protocol === "https:" || (url.protocol === "http:" && ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname)),
        "Use HTTPS, or loopback HTTP for local verification");
      assert.ok(!url.username && !url.password && !url.search && !url.hash, "URLs must not contain credentials, query or fragment");
    }
    assert.equal(endpoint.pathname, "/mcp");
    assert.ok(!inventoryUrl.pathname.startsWith("/admin/"), "Expected inventory must not come from the administrative API");
    assertCommit(env.GISUL_CANARY_EXPECTED_RUNTIME);
    assert.match(env.GISUL_CANARY_INVENTORY_SHA256, /^sha256:[a-f0-9]{64}$/);
    async function request(url, options) {
      const response = await fetcher(url, { ...options, redirect: "error", signal: AbortSignal.timeout(15000) });
      const bytes = Buffer.from(await response.arrayBuffer());
      if (!response.ok) throw Object.assign(new Error(`HTTP request failed (${response.status})`), { status: response.status });
      return bytes;
    }
    receipt.phase = "inventory";
    const bytes = await request(inventoryUrl, { headers: env.GISUL_CANARY_INVENTORY_TOKEN
      ? { authorization: `Bearer ${env.GISUL_CANARY_INVENTORY_TOKEN}` } : {} });
    assert.ok(bytes.length <= 8 * 1024 * 1024, "Expected inventory exceeds the release limit");
    assert.equal(await sha256(bytes), env.GISUL_CANARY_INVENTORY_SHA256);
    const document = parseJson(bytes.toString("utf8"), "Expected inventory");
    assertCommit(document?.commit);
    const identity = { commit: document.commit, release: document.release, inventory_digest: env.GISUL_CANARY_INVENTORY_SHA256 };
    const { inventory, files } = parseInventory(bytes.toString("utf8"), identity);
    receipt.expected = { ...identity, server_version: env.GISUL_CANARY_EXPECTED_RUNTIME };
    receipt.phase = "mcp";
    let id = 0;
    async function rpc(method, params = {}) {
      receipt.operation = method === "tools/call" ? params.name : method;
      const body = parseJson((await request(endpoint, { method: "POST", headers: {
        authorization: `Bearer ${env.GISUL_CANARY_READER_TOKEN}`, "content-type": "application/json",
        accept: "application/json, text/event-stream", "mcp-protocol-version": "2026-07-28", "mcp-method": method,
        ...(method === "resources/read" ? { "mcp-name": params.uri }
          : method === "tools/call" ? { "mcp-name": params.name } : {}),
      }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params: { ...params, _meta: {
        ...params._meta, "io.modelcontextprotocol/protocolVersion": "2026-07-28",
        "io.modelcontextprotocol/clientCapabilities": {},
      } } }) })).toString("utf8"), "MCP response");
      assert.equal(body.jsonrpc, "2.0");
      assert.equal(body.id, id);
      assert.ok(!body.error, `MCP request failed (${Number.isInteger(body.error?.code) ? body.error.code : "no numeric code"})`);
      const result = body.result;
      assert.equal(result.resultType, "complete");
      assert.equal(result._meta["io.modelcontextprotocol/serverInfo"].name, "gisul");
      assert.equal(result._meta["io.modelcontextprotocol/serverInfo"].version, env.GISUL_CANARY_EXPECTED_RUNTIME);
      return result;
    }
    function checkIdentity(meta) {
      assert.equal(meta.commit, identity.commit);
      assert.equal(meta.release, identity.release);
      assert.equal(meta.server_version, env.GISUL_CANARY_EXPECTED_RUNTIME);
    }
    async function catalog() {
      const result = await rpc("skills/list");
      checkIdentity(result._meta);
      assert.ok(isDeepStrictEqual(result.skills, inventory.skills), "Active catalog differs from the expected inventory");
    }
    const discovered = await rpc("server/discover");
    assert.ok(discovered.supportedVersions.includes("2026-07-28"));
    await catalog();
    const pin = { "io.gisul/commit": identity.commit };
    for (const skill of inventory.skills) {
      const loaded = await rpc("skills/get", { uri: skill.uri, _meta: pin });
      checkIdentity(loaded._meta);
      assert.ok(isDeepStrictEqual(loaded.skill, skill), "Loaded manifest differs from the expected inventory");
      receipt.checked.skills++;
    }
    for (const file of files.values()) {
      const result = await rpc("resources/read", { uri: file.uri, _meta: pin });
      checkIdentity(result._meta);
      assert.equal(result.contents.length, 1);
      const content = result.contents[0];
      assert.ok(content.uri === file.uri, "Resource URI differs from the requested file");
      const body = "text" in content ? Buffer.from(content.text, "utf8") : Buffer.from(content.blob, "base64");
      assert.equal(body.length, file.size);
      assert.equal(await sha256(body), file.digest);
      receipt.checked.resources++;
    }
    if (inventory.packs !== undefined) {
      async function tool(name, args) {
        const response = await rpc("tools/call", { name, arguments: args });
        assert.equal(response.isError, false, "Read-only pack operation failed");
        assert.equal(response.content.length, 1);
        const result = parseJson(response.content[0].text, "MCP tool result");
        checkIdentity(result);
        assert.equal(result.publication_status, "published");
        assert.equal(result.active_commit, identity.commit);
        return result;
      }
      const listed = [];
      for (let offset = 0; offset < Math.max(1, inventory.packs.length); offset += 50) {
        const result = await tool("search_packs", { mode: "explicit", commit: identity.commit, limit: 50, offset });
        assert.equal(result.totalMatches, inventory.packs.length);
        assert.equal(result.packs.length, Math.min(50, inventory.packs.length - offset));
        assert.equal(result.nextOffset, offset + 50 < inventory.packs.length ? offset + 50 : undefined);
        listed.push(...result.packs);
      }
      const expected = inventory.packs.map(pack => ({ uri: pack.uri, kind: "skill-pack", name: pack.definition.name,
        display_name: pack.definition.display_name, description: pack.definition.description, members: pack.definition.members,
        digest: pack.digest, ...(pack.registration ?? { created_by: null, created_at: null, updated_by: null, updated_at: null }),
        publication_status: "published", active_commit: identity.commit }));
      const sort = values => values.slice().sort((a, b) => a.uri < b.uri ? -1 : a.uri > b.uri ? 1 : 0);
      assert.ok(isDeepStrictEqual(sort(listed), sort(expected)), "Pack catalog differs from the expected inventory");
      for (const pack of inventory.packs) {
        const loaded = await tool("load_pack", { uris: [pack.uri], commit: identity.commit });
        assert.equal(loaded.packs.length, 1);
        const actual = loaded.packs[0];
        assert.ok(isDeepStrictEqual({ uri: actual.uri, definition: actual.definition, digest: actual.digest, size: actual.size,
          ...(actual.registration ? { registration: actual.registration } : {}) }, pack), "Loaded pack differs from the expected inventory");
        assert.equal(loaded.members.length, pack.definition.members.length);
        for (const member of pack.definition.members) {
          const actualMember = loaded.members.find(value => value.uri === member.uri);
          const skill = inventory.skills.find(value => value.uri === member.uri);
          assert.equal(actualMember.phase, member.phase);
          assert.equal(actualMember.commit, identity.commit);
          assert.equal(actualMember.digest, skill.resources.find(file => file.uri === skill.uri).digest);
          assert.equal(actualMember.manifest_digest, await manifestDigest(skill));
          assert.ok(isDeepStrictEqual(actualMember.requirements, [{ ...member, pack_uri: pack.uri }]), "Pack requirements differ");
        }
        assert.ok(isDeepStrictEqual(loaded.permissions,
          { grants_execution: false, grants_delegation: false, grants_publication: false }), "Pack permissions differ");
        receipt.checked.packs++;
      }
    }
    await catalog();
    receipt.state = "complete";
    receipt.phase = "complete";
  } catch (error) {
    // A generated assertion message quotes the compared response value; phase and operation already locate the check.
    const message = error instanceof assert.AssertionError && error.generatedMessage
      ? `Check failed during ${receipt.phase}` : error.message;
    receipt.error = { message, status: error.status ?? null };
  }
  receipt.finished_at = new Date().toISOString();
  const text = JSON.stringify(receipt, (_key, value) => typeof value === "string"
    ? secrets.reduce((safe, secret) => safe.split(secret).join("[REDACTED]"), value) : value, 2) + "\n";
  const path = env.GISUL_CANARY_RECEIPT ?? fileURLToPath(new URL("../dist/receipts/production-canary.json", import.meta.url));
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text, { mode: 0o600 });
  return JSON.parse(text);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const receipt = await runCanary();
  console.log(JSON.stringify(receipt, null, 2));
  process.exitCode = receipt.state === "complete" ? 0 : 1;
}
