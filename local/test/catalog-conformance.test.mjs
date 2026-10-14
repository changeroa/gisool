import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { distImport, makeTempDir, removeDir, writeFixtureSkill } from "./_helpers.mjs";

const { createCatalog, skillUri } = await distImport("catalog/index.js");
async function catalogCase(fn) {
  const root = makeTempDir("gisool-manifest-");
  const logs = [];
  const catalog = createCatalog({ roots: [{ id: "test", path: root }], log: (s) => logs.push(s) });
  try { await fn({ root, catalog, logs }); } finally { catalog.close(); removeDir(root); }
}

test("complete manifests include dotfiles dependencies and nested skills published flat", () => catalogCase(async ({ root, catalog }) => {
  writeFixtureSkill(root, "outer", { files: {
    ".hidden": "hidden", ".config/value": "value", "node_modules/pkg/index.js": "code",
    "odd #?% file.txt": "special", "한국어.txt": "unicode",
  } });
  writeFixtureSkill(root, "outer/inner", { name: "inner", files: { ".hidden": "inner" } });
  writeFixtureSkill(root, ".prefix/visible", { name: "visible" });
  await catalog.refresh();
  assert.deepEqual(catalog.list().map((e) => e.name).sort(), ["inner", "outer", "visible"]);
  const outer = catalog.get(skillUri("test", "outer", "SKILL.md"));
  const inner = catalog.get(skillUri("test", "outer/inner", "SKILL.md"));
  assert.equal(outer.resources.length, 8);
  assert.equal(new Set(outer.resources.map((r) => r.uri)).size, 8);
  for (const resource of inner.resources) assert.deepEqual(outer.resources.find((r) => r.uri === resource.uri), resource);
  for (const resource of outer.resources) {
    const content = await catalog.readResource(resource.uri);
    assert.equal(`sha256:${createHash("sha256").update(content.bytes).digest("hex")}`, resource.digest);
    assert.equal(content.bytes.length, resource.size);
  }
  const before = outer.manifestDigest;
  writeFileSync(join(root, "outer/inner/.hidden"), "updated nested content");
  await catalog.refresh();
  assert.notEqual(catalog.get(outer.uri).manifestDigest, before);
}));

test("Agent Skills names enforce lowercase alphanumeric hyphen and directory rules", () => catalogCase(async ({ root, catalog }) => {
  const invalid = ["UPPER", "-leading", "trailing-", "two--dashes", "has_under", "has space", "x".repeat(65)];
  for (const name of invalid) writeFixtureSkill(root, name);
  writeFixtureSkill(root, "different", { name: "another" });
  for (const name of ["x", "a-1", "한국어", "école", "x".repeat(64)]) writeFixtureSkill(root, name);
  await catalog.refresh();
  assert.deepEqual(catalog.list().map((e) => e.name).sort(), ["x", "a-1", "한국어", "école", "x".repeat(64)].sort());
  for (const entry of catalog.list()) {
    assert.equal(decodeURIComponent(entry.uri.split("/").at(-2)), entry.frontmatter.name);
    assert.equal((await catalog.readResource(entry.uri)).digest, entry.digest);
  }
}));

test("frontmatter constraints reject invalid fields without changing valid author data", () => catalogCase(async ({ root, catalog }) => {
  const invalid = [
    { description: "" }, { description: " " }, { description: "d".repeat(1025) },
    { frontmatter: { compatibility: "" } }, { frontmatter: { compatibility: "c".repeat(501) } },
    { frontmatter: { metadata: { number: 2 } } }, { frontmatter: { "allowed-tools": ["Read"] } },
    { frontmatter: { license: 2 } },
  ];
  invalid.forEach((options, i) => writeFixtureSkill(root, `invalid-${i}`, options));
  const frontmatter = { metadata: { "io.modelcontextprotocol/allowed-tools": "never interpreted", owner: "team" },
    compatibility: "c".repeat(500), "future-field": { nested: [1, true, null] } };
  writeFixtureSkill(root, "valid", { description: "d".repeat(1024), frontmatter });
  await catalog.refresh();
  assert.deepEqual(catalog.list().map((e) => e.name), ["valid"]);
  assert.deepEqual(catalog.list()[0].frontmatter, { name: "valid", description: "d".repeat(1024), ...frontmatter });
  assert.equal(catalog.list()[0].invocation, "automatic");
}));

test("512 resources are accepted but 513 reject the whole skill", () => catalogCase(async ({ root, catalog, logs }) => {
  const files = Object.fromEntries(Array.from({ length: 511 }, (_, i) => [`files/${i}`, "x"]));
  writeFixtureSkill(root, "boundary", { files });
  await catalog.refresh();
  assert.equal(catalog.list()[0].resources.length, 512);
  writeFileSync(join(root, "boundary/extra"), "x");
  await catalog.refresh();
  assert.deepEqual(catalog.list(), []);
  assert.ok(logs.some((s) => s.includes("512")));
}));

test("16 MiB raw total is accepted but one extra byte rejects the whole skill", () => catalogCase(async ({ root, catalog, logs }) => {
  const path = writeFixtureSkill(root, "boundary");
  const remaining = 16 * 1024 * 1024 - readFileSync(path).length;
  writeFileSync(join(root, "boundary/data.bin"), Buffer.alloc(remaining));
  await catalog.refresh();
  assert.equal(catalog.list()[0].resources.reduce((n, r) => n + r.size, 0), 16 * 1024 * 1024);
  writeFileSync(join(root, "boundary/data.bin"), Buffer.alloc(remaining + 1));
  await catalog.refresh();
  assert.deepEqual(catalog.list(), []);
  assert.ok(logs.some((s) => s.includes("16 MiB")));
}));

test("URI parsing rejects traversal aliases and escaped separators while serving encoded filenames", () => catalogCase(async ({ root, catalog }) => {
  writeFixtureSkill(root, "safe", { files: { ".dot": "dot", "a%20.txt": "percent" } });
  await catalog.refresh();
  for (const uri of [
    "skill://local/test/safe/%2e%2e/SKILL.md", "skill://local/test/safe/%2Edot", "skill://local/test/safe/%5csecret",
    "skill://local/test/safe//SKILL.md", "skill://local/test/safe/SKILL.md?x=1", "skill://local/test/safe/%00",
  ]) await assert.rejects(catalog.readResource(uri), (e) => e.code === "invalid_uri", uri);
  assert.equal((await catalog.readResource(skillUri("test", "safe", "a%20.txt"))).text, "percent");
  assert.equal((await catalog.readResource(skillUri("test", "safe", ".dot"))).text, "dot");
}));

test("invalid UTF-8 SKILL.md is not published with frontmatter different from its bytes", () => catalogCase(async ({ root, catalog }) => {
  const path = writeFixtureSkill(root, "invalid");
  writeFileSync(path, Buffer.concat([readFileSync(path), Buffer.from([255])]));
  await catalog.refresh();
  assert.deepEqual(catalog.list(), []);
}));

test("non-JSON frontmatter and unaddressable supporting files reject a whole skill", () => catalogCase(async ({ root, catalog }) => {
  const path = writeFixtureSkill(root, "non-json");
  writeFileSync(path, "---\nname: non-json\ndescription: test\nfuture: .nan\n---\n");
  writeFixtureSkill(root, "backslash", { files: { "a\\b.txt": "unaddressable" } });
  writeFixtureSkill(root, "bad\\prefix/valid", { name: "valid" });
  await catalog.refresh();
  assert.deepEqual(catalog.list(), []);
}));
