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

test("contracted entry modules exist in dist and export their functions", async () => {
  const contracts = [
    ["server.js", ["startServer"]],
    ["mcp/stdio-proxy.js", ["runStdioProxy"]],
    ["cli/export-import.js", ["runExport", "runImport"]],
    ["cli/eval.js", ["runEval"]],
  ];
  for (const [path, names] of contracts) {
    const mod = await distImport(path);
    for (const name of names) assert.equal(typeof mod[name], "function", `${path} exports ${name}`);
  }
});
