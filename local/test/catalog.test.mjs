import assert from "node:assert/strict";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { distImport, makeTempDir, removeDir, writeFixtureSkill } from "./_helpers.mjs";
import { quietLog, snapshotTree } from "./helpers/catalog.mjs";

const { createCatalog } = await distImport("catalog/index.js");

function setup() {
  const base = makeTempDir("gisool-catalog-");
  const a = join(base, "agents");
  const b = join(base, "claude");
  mkdirSync(a, { recursive: true });
  mkdirSync(b, { recursive: true });
  const roots = [{ id: "agents", path: a }, { id: "claude", path: b }];
  return { base, a, b, roots, cleanup: () => removeDir(base) };
}

test("indexes fields in place with skill://local URIs", async () => {
  const s = setup();
  try {
    writeFixtureSkill(s.a, "router", {
      description: "Routes prompts",
      frontmatter: { tags: ["mcp", "search"], "when-to-use": "When choosing a skill", examples: ["pick a skill"], aliases_ko: ["라우터"], "disable-model-invocation": true },
      body: "# Router\n\nFirst paragraph\nspans lines.\n\nSecond paragraph.\n",
      files: { "refs/notes.md": "notes" },
    });
    const c = createCatalog({ roots: s.roots, log: quietLog });
    const delta = await c.refresh();
    assert.equal(delta.added.length, 1);
    const e = c.get("skill://local/agents/router/SKILL.md");
    assert.ok(e);
    assert.equal(e.rootId, "agents");
    assert.equal(e.dir, "router");
    assert.deepEqual(e.tags, ["mcp", "search"]);
    assert.equal(e.whenToUse, "When choosing a skill");
    assert.deepEqual(e.examples, ["pick a skill"]);
    assert.deepEqual(e.aliasesKo, ["라우터"]);
    assert.equal(e.invocation, "explicit");
    assert.equal(e.bodyHead, "First paragraph spans lines.");
    assert.match(e.digest, /^sha256:[0-9a-f]{64}$/);
    assert.match(e.manifestDigest, /^sha256:[0-9a-f]{64}$/);
    assert.deepEqual(e.resources.map((r) => r.uri).sort(), ["skill://local/agents/router/SKILL.md", "skill://local/agents/router/refs/notes.md"]);
    assert.equal(e.group, undefined);
    assert.equal(e.body, undefined, "full body is not kept");
    const r = await c.readResource("skill://local/agents/router/refs/notes.md");
    assert.equal(r.text, "notes");
    assert.equal(r.size, 5);
  } finally {
    s.cleanup();
  }
});

test("bodyHead caps at 600 chars and defaults tags to []", async () => {
  const s = setup();
  try {
    writeFixtureSkill(s.a, "long", { body: "# T\n\n" + "x".repeat(2000) + "\n" });
    const c = createCatalog({ roots: s.roots, log: quietLog });
    await c.refresh();
    const e = c.list()[0];
    assert.equal(e.bodyHead.length, 600);
    assert.deepEqual(e.tags, []);
    assert.equal(e.invocation, "automatic");
  } finally {
    s.cleanup();
  }
});

test("same name in two roots yields one duplicate entry", async () => {
  const s = setup();
  try {
    writeFixtureSkill(s.a, "dup");
    writeFixtureSkill(s.b, "dup");
    writeFixtureSkill(s.b, "solo");
    const c = createCatalog({ roots: s.roots, log: quietLog });
    await c.refresh();
    const { duplicates } = c.report();
    assert.deepEqual(duplicates, [{ name: "dup", uris: ["skill://local/agents/dup/SKILL.md", "skill://local/claude/dup/SKILL.md"] }]);
  } finally {
    s.cleanup();
  }
});

test("re0, re0-loop, re0-work form family re0; explicit group wins", async () => {
  const s = setup();
  try {
    for (const n of ["re0", "re0-loop", "re0-work", "lonely"]) writeFixtureSkill(s.a, n);
    writeFixtureSkill(s.a, "ship", { frontmatter: { group: { id: "cycle", stage: "release" } } });
    const c = createCatalog({ roots: s.roots, log: quietLog });
    await c.refresh();
    const { families } = c.report();
    assert.deepEqual(families, [
      { id: "cycle", uris: ["skill://local/agents/ship/SKILL.md"] },
      { id: "re0", uris: ["skill://local/agents/re0-loop/SKILL.md", "skill://local/agents/re0-work/SKILL.md", "skill://local/agents/re0/SKILL.md"] },
    ]);
    assert.deepEqual(c.get("skill://local/agents/re0-loop/SKILL.md").group, { id: "re0" });
    assert.deepEqual(c.get("skill://local/agents/ship/SKILL.md").group, { id: "cycle", stage: "release" });
    assert.equal(c.get("skill://local/agents/lonely/SKILL.md").group, undefined);
  } finally {
    s.cleanup();
  }
});

test("symlinked SKILL.md and symlinked resources are skipped", async () => {
  const s = setup();
  try {
    mkdirSync(join(s.a, "evil"));
    symlinkSync("/etc/hosts", join(s.a, "evil", "SKILL.md"));
    writeFixtureSkill(s.a, "ok");
    symlinkSync("/etc/hosts", join(s.a, "ok", "hosts.md"));
    symlinkSync(join(s.a, "ok"), join(s.a, "linkdir"));
    const c = createCatalog({ roots: s.roots, log: quietLog });
    await c.refresh();
    assert.deepEqual(c.list().map((e) => e.uri), ["skill://local/agents/ok/SKILL.md"]);
    assert.deepEqual(c.list()[0].resources.map((r) => r.uri), ["skill://local/agents/ok/SKILL.md"]);
    await assert.rejects(c.readResource("skill://local/agents/ok/hosts.md"), (e) => e.code === "symlink_refused");
    await assert.rejects(c.readResource("skill://local/agents/evil/SKILL.md"), (e) => e.code === "symlink_refused");
  } finally {
    s.cleanup();
  }
});

test("traversal and foreign URIs are refused", async () => {
  const s = setup();
  try {
    writeFixtureSkill(s.a, "ok");
    writeFileSync(join(s.base, "secret.md"), "secret");
    const c = createCatalog({ roots: s.roots, log: quietLog });
    await c.refresh();
    for (const uri of [
      "skill://local/agents/ok/../../secret.md",
      "skill://local/agents/../secret.md",
      "skill://local/agents/ok/%2e%2e/%2e%2e/secret.md",
      "skill://local/agents/ok/..%2F..%2Fsecret.md",
      "skill://gisul/agents/ok/SKILL.md",
      "file:///etc/hosts",
    ]) {
      await assert.rejects(c.readResource(uri), (e) => e.code === "invalid_uri", uri);
    }
    await assert.rejects(c.readResource("skill://local/nope/ok/SKILL.md"), (e) => e.code === "unknown_root");
    await assert.rejects(c.readResource("skill://local/agents/ok/missing.md"), (e) => e.code === "unknown_resource");
  } finally {
    s.cleanup();
  }
});

test("readResource throws digest_mismatch when the file changed after refresh", async () => {
  const s = setup();
  try {
    const p = writeFixtureSkill(s.a, "ok");
    const c = createCatalog({ roots: s.roots, log: quietLog });
    await c.refresh();
    writeFileSync(p, "---\nname: ok\ndescription: tampered\n---\n");
    await assert.rejects(c.readResource("skill://local/agents/ok/SKILL.md"), (e) => e.code === "digest_mismatch" && /digest_mismatch/.test(e.message));
  } finally {
    s.cleanup();
  }
});

test("refresh after an edit yields exactly one changed, plus added and removed", async () => {
  const s = setup();
  try {
    writeFixtureSkill(s.a, "one");
    writeFixtureSkill(s.a, "two");
    const c = createCatalog({ roots: s.roots, log: quietLog });
    const seen = [];
    c.onDelta((d) => seen.push(d));
    await c.refresh();
    writeFileSync(join(s.a, "one", "extra.md"), "more content");
    const delta = await c.refresh();
    assert.equal(delta.changed.length, 1);
    assert.equal(delta.changed[0].uri, "skill://local/agents/one/SKILL.md");
    assert.deepEqual(delta.added, []);
    assert.deepEqual(delta.removed, []);
    const quiet = await c.refresh();
    assert.deepEqual(quiet, { added: [], changed: [], removed: [] });
    removeDir(join(s.a, "two"));
    writeFixtureSkill(s.b, "three");
    const d3 = await c.refresh();
    assert.deepEqual(d3.removed, ["skill://local/agents/two/SKILL.md"]);
    assert.deepEqual(d3.added.map((e) => e.uri), ["skill://local/claude/three/SKILL.md"]);
    assert.equal(seen.length, 3, "listeners fire only for non-empty deltas");
  } finally {
    s.cleanup();
  }
});

test("a missing root is reported unreadable, not an error", async () => {
  const s = setup();
  try {
    writeFixtureSkill(s.a, "ok");
    const roots = [...s.roots, { id: "gone", path: join(s.base, "does-not-exist") }];
    const c = createCatalog({ roots, log: quietLog });
    await c.refresh();
    assert.deepEqual(c.report().roots, [
      { id: "agents", path: s.a, readable: true, count: 1 },
      { id: "claude", path: s.b, readable: true, count: 0 },
      { id: "gone", path: join(s.base, "does-not-exist"), readable: false, count: 0 },
    ]);
  } finally {
    s.cleanup();
  }
});

test("invalid skills are skipped: missing frontmatter, name mismatch, SEP-2640 resource limit", async () => {
  const s = setup();
  try {
    mkdirSync(join(s.a, "nofm"));
    writeFileSync(join(s.a, "nofm", "SKILL.md"), "# no frontmatter\n");
    writeFixtureSkill(s.a, "mismatch", { name: "other" });
    const files = {};
    for (let i = 0; i < 512; i += 1) files[`r/${i}.txt`] = "x";
    writeFixtureSkill(s.a, "huge", { files });
    writeFixtureSkill(s.a, "nested/inner", { name: "inner" });
    const c = createCatalog({ roots: s.roots, log: quietLog });
    await c.refresh();
    assert.deepEqual(c.list().map((e) => e.uri), ["skill://local/agents/nested/inner/SKILL.md"]);
  } finally {
    s.cleanup();
  }
});

test("no-copy: refresh and readResource leave every root's listing, sizes and mtimes unchanged", async () => {
  const s = setup();
  try {
    writeFixtureSkill(s.a, "ok", { files: { "refs/a.md": "a", "scripts/run.sh": "echo hi" } });
    writeFixtureSkill(s.b, "ok");
    const before = s.roots.map((r) => snapshotTree(r.path));
    const c = createCatalog({ roots: s.roots, log: quietLog });
    await c.refresh();
    await c.readResource("skill://local/agents/ok/refs/a.md");
    await c.readResource("skill://local/claude/ok/SKILL.md");
    await c.refresh();
    const after = s.roots.map((r) => snapshotTree(r.path));
    assert.deepEqual(after, before);
    assert.ok(Object.keys(before[0]).length >= 5);
  } finally {
    s.cleanup();
  }
});

test("watcher refreshes after a debounced change and emits the delta", async () => {
  const s = setup();
  const c = createCatalog({ roots: s.roots, log: quietLog, watch: true, watchDebounceMs: 100 });
  try {
    await c.refresh();
    const got = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no delta within 15s")), 15000);
      const off = c.onDelta((d) => {
        if (d.added.some((e) => e.name === "fresh")) {
          clearTimeout(timer);
          off();
          resolve(d);
        }
      });
    });
    writeFixtureSkill(s.a, "fresh");
    const d = await got;
    assert.equal(d.added[0].uri, "skill://local/agents/fresh/SKILL.md");
  } finally {
    c.close();
    s.cleanup();
  }
});
