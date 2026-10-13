import { spawn } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { makeSandbox } from "../_helpers.mjs";

export const MAIN = fileURLToPath(new URL("../../dist/cli/main.js", import.meta.url));

export const RUNTIME_DIRS = [".claude", ".codex", ".gemini", ".cursor", ".omo/agent", ".gjc/agent", ".openclaw"];

/** Sandbox per the sandbox rule, plus an empty bin dir as the whole PATH so no real runtime binary is reachable. */
export function cliSandbox({ runtimes = RUNTIME_DIRS } = {}) {
  const sb = makeSandbox();
  for (const d of runtimes) mkdirSync(join(sb.home, d), { recursive: true });
  const bin = join(sb.home, ".stub-bin");
  mkdirSync(bin);
  sb.env.PATH = bin;
  return { ...sb, bin };
}

export function writeStub(bin, name, log) {
  const path = join(bin, name);
  writeFileSync(path, `#!/bin/sh\nprintf '%s %s\\n' '${name}' "$*" >> '${log}'\nexit 0\n`);
  chmodSync(path, 0o755);
  return path;
}

export function runCli(args, env, { nodeArgs = [] } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...nodeArgs, MAIN, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr, output: stdout + stderr }));
  });
}

/** Map of relative path -> file contents (directories as "<dir>"), skipping the named top-level entries. */
export function snapshotTree(root, { exclude = [] } = {}) {
  const out = {};
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const abs = join(dir, name);
      const rel = relative(root, abs);
      if (exclude.includes(rel)) continue;
      if (lstatSync(abs).isDirectory()) {
        out[rel] = "<dir>";
        walk(abs);
      } else out[rel] = readFileSync(abs, "utf8");
    }
  };
  if (existsSync(root)) walk(root);
  return out;
}
