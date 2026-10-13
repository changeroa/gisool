import assert from "node:assert/strict";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { distImport, makeSandbox } from "./_helpers.mjs";

const { loadConfig, ensureToken } = await distImport("config.js");

test("first run creates GISOOL_HOME 0700, config.json defaults, and a 0600 hex token", () => {
  const sb = makeSandbox();
  try {
    const config = loadConfig(sb.env);
    assert.equal(config.port, 8799);
    assert.equal(config.captureLevel, "full");
    assert.equal(config.retentionDays, null);
    assert.deepEqual(config.runtimes, {});
    assert.deepEqual(config.roots.map((r) => r.id), ["agents", "claude", "codex", "gemini", "omo", "gajae", "openclaw", "gisul"]);
    assert.equal(config.roots.find((r) => r.id === "gajae").path, join(sb.home, ".gjc/agent/skills"));
    assert.equal(config.roots.find((r) => r.id === "gisul").path, join(sb.home, "gisul/skills"));
    const gisoolHome = sb.env.GISOOL_HOME;
    assert.equal(statSync(gisoolHome).mode & 0o777, 0o700);
    const tokenPath = join(gisoolHome, "token");
    assert.equal(statSync(tokenPath).mode & 0o777, 0o600);
    const token = readFileSync(tokenPath, "utf8").trim();
    assert.match(token, /^[0-9a-f]{64}$/);
    loadConfig(sb.env);
    assert.equal(readFileSync(tokenPath, "utf8").trim(), token, "token is stable across runs");
    assert.equal(ensureToken(gisoolHome), token);
  } finally {
    sb.cleanup();
  }
});

test("GISOOL_HOME defaults to HOME/.gisool and config.json overrides are honored", () => {
  const sb = makeSandbox();
  try {
    const env = { ...sb.env };
    delete env.GISOOL_HOME;
    loadConfig(env);
    const configPath = join(sb.home, ".gisool", "config.json");
    writeFileSync(configPath, JSON.stringify({ port: 9001, captureLevel: "metadata", retentionDays: 30, roots: [{ id: "x", path: "~/x/skills" }] }));
    const config = loadConfig(env);
    assert.equal(config.port, 9001);
    assert.equal(config.captureLevel, "metadata");
    assert.equal(config.retentionDays, 30);
    assert.deepEqual(config.roots, [{ id: "x", path: join(sb.home, "x/skills") }]);
  } finally {
    sb.cleanup();
  }
});

test("invalid config.json is rejected", () => {
  const sb = makeSandbox();
  try {
    loadConfig(sb.env);
    writeFileSync(join(sb.env.GISOOL_HOME, "config.json"), JSON.stringify({ captureLevel: "everything" }));
    assert.throws(() => loadConfig(sb.env));
  } finally {
    sb.cleanup();
  }
});
