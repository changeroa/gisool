import assert from "node:assert/strict";
import { test } from "node:test";
import { distImport } from "./_helpers.mjs";

const { assertNodeVersion, assertPlatform } = await distImport("version.js");
const code = (c) => (error) => error.code === c;

test("assertNodeVersion enforces >= 24.15", () => {
  assert.doesNotThrow(() => assertNodeVersion("24.15.0"));
  assert.doesNotThrow(() => assertNodeVersion("25.0.0"));
  assert.throws(() => assertNodeVersion("24.14.9"), code("node_too_old"));
  assert.throws(() => assertNodeVersion("22.20.0"), code("node_too_old"));
});

test("assertPlatform rejects win32 only", () => {
  assert.doesNotThrow(() => assertPlatform("darwin"));
  assert.doesNotThrow(() => assertPlatform("linux"));
  assert.throws(() => assertPlatform("win32"), code("unsupported_platform"));
});

test("stubs throw not_implemented", async () => {
  const { startServer } = await distImport("server.js");
  const { runStdioProxy } = await distImport("mcp/stdio-proxy.js");
  const { runEval } = await distImport("cli/eval.js");
  const { runExport, runImport } = await distImport("cli/export-import.js");
  for (const p of [startServer({}), runStdioProxy({ port: 1, token: "" }), runEval({}, {}), runExport("x", { withHistory: false }, {}), runImport("x", { dryRun: true }, {})]) {
    await assert.rejects(p, code("not_implemented"));
  }
});
