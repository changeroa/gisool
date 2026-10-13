import assert from "node:assert/strict";
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { distImport, makeSandbox, PACKAGE_ROOT } from "./_helpers.mjs";

const { geminiPack } = await distImport("packs/gemini.js");
const { cursorPack } = await distImport("packs/cursor.js");
const packageRoot = fileURLToPath(PACKAGE_ROOT).replace(/\/$/, "");

function ctxFor(sb, overrides = {}) {
  return {
    home: sb.home,
    env: sb.env,
    port: 8799,
    token: "t".repeat(64),
    nodePath: "/usr/local/bin/node",
    packageRoot,
    disableRemote: false,
    ...overrides,
  };
}

function afterOf(plan, file) {
  const f = plan.files.find((x) => x.path === file);
  assert.ok(f, `plan writes ${file}`);
  return JSON.parse(f.after);
}

test("cursor plan keeps an unrelated mcp.json server and writes hooks.json with version 1", async () => {
  const sb = makeSandbox();
  try {
    const cursorDir = join(sb.home, ".cursor");
    mkdirSync(cursorDir, { recursive: true });
    writeFileSync(join(cursorDir, "mcp.json"), JSON.stringify({ mcpServers: { other: { command: "x" } }, keep: true }));
    const plan = await cursorPack.plan(ctxFor(sb));
    assert.deepEqual(plan.conflicts, []);
    const mcp = afterOf(plan, join(cursorDir, "mcp.json"));
    assert.deepEqual(mcp.mcpServers.other, { command: "x" });
    assert.equal(mcp.keep, true);
    assert.equal(mcp.mcpServers.gisool.url, "http://127.0.0.1:8799/mcp");
    assert.equal(mcp.mcpServers.gisool.headers.Authorization, `Bearer ${"t".repeat(64)}`);
    const hooks = afterOf(plan, join(cursorDir, "hooks.json"));
    assert.equal(hooks.version, 1);
    for (const event of ["beforeSubmitPrompt", "sessionStart", "sessionEnd"]) {
      assert.equal(hooks.hooks[event].length, 1, `${event} has one gisool hook`);
      assert.match(hooks.hooks[event][0].command, /hook-post\.mjs" cursor$/);
    }
    const existingMode = statSync(join(cursorDir, "mcp.json")).mode & 0o777;
    assert.equal(plan.files.find((f) => f.path === join(cursorDir, "mcp.json")).mode, existingMode);
    assert.equal(plan.files.find((f) => f.path === join(cursorDir, "hooks.json")).mode, 0o600);
  } finally {
    sb.cleanup();
  }
});

test("gemini plan writes the MCP entry and BeforeAgent plus AfterTool hooks with a 5000 ms timeout", async () => {
  const sb = makeSandbox();
  try {
    mkdirSync(join(sb.home, ".gemini"), { recursive: true });
    const plan = await geminiPack.plan(ctxFor(sb));
    assert.deepEqual(plan.conflicts, []);
    const settings = afterOf(plan, join(sb.home, ".gemini", "settings.json"));
    assert.equal(settings.mcpServers.gisool.httpUrl, "http://127.0.0.1:8799/mcp");
    assert.equal(settings.hooks.BeforeAgent[0].hooks[0].timeout, 5000);
    assert.equal(settings.hooks.AfterTool[0].matcher, "activate_skill");
    assert.equal(settings.hooks.AfterTool[0].hooks[0].timeout, 5000);
  } finally {
    sb.cleanup();
  }
});

test("gemini plan refuses an unparseable settings.json and writes nothing", async () => {
  const sb = makeSandbox();
  try {
    const dir = join(sb.home, ".gemini");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "settings.json"), '{ "mcpServers": {}, }');
    const plan = await geminiPack.plan(ctxFor(sb));
    assert.deepEqual(plan.files, []);
    assert.equal(plan.conflicts.length, 1);
    assert.equal(plan.conflicts[0].code, "unparseable_config");
  } finally {
    sb.cleanup();
  }
});

test("packs do nothing when the agent directory is absent", async () => {
  const sb = makeSandbox();
  try {
    for (const pack of [geminiPack, cursorPack]) {
      const plan = await pack.plan(ctxFor(sb));
      assert.deepEqual(plan.files, []);
      assert.deepEqual(plan.conflicts, []);
      assert.equal(plan.notes.length, 1);
    }
  } finally {
    sb.cleanup();
  }
});
