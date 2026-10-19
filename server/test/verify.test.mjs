import assert from "node:assert/strict";
import test from "node:test";
import { resolve } from "node:path";
import { verify } from "../../scripts/verify.mjs";

test("runtime verification runs the full CI sequence from the selected checkout", () => {
  const calls = [];
  const root = resolve("/fixture checkout");
  verify({ root, run: (command, args, options) => {
    calls.push([command, args, options.cwd]);
    assert.equal(options.stdio, "inherit");
    assert.equal(options.env.WRANGLER_SEND_METRICS, "false");
    return { status: 0 };
  } });
  assert.deepEqual(calls, [
    ["npm", ["ci"], resolve(root, "server")],
    ["npm", ["ci"], resolve(root, "worker")],
    ["npm", ["run", "build"], resolve(root, "server")],
    ["npm", ["test"], resolve(root, "server")],
    [process.execPath, ["server/bench/search.mjs", "--check"], root],
    ["npm", ["run", "build:codex-plugin"], resolve(root, "server")],
    ["npm", ["run", "typecheck"], resolve(root, "worker")],
    ["npm", ["test"], resolve(root, "worker")],
    [process.execPath, ["scripts/check-team-plugin.mjs"], root],
    ["npx", ["--no-install", "wrangler", "deploy", "--config", "wrangler.team.jsonc", "--dry-run"], resolve(root, "worker")],
    ["npx", ["--no-install", "wrangler", "versions", "upload", "--dry-run"], resolve(root, "worker")],
    ["npx", ["--no-install", "wrangler", "deploy", "--config", "wrangler.oauth.jsonc", "--dry-run"], resolve(root, "worker")],
  ]);
});

test("verification stops at the first failed check", () => {
  let calls = 0;
  assert.throws(() => verify({ run: () => ({ status: ++calls === 3 ? 7 : 0 }) }));
  assert.equal(calls, 3);
});

test("verification surfaces process-start errors without running later checks", () => {
  let calls = 0;
  const failure = Object.assign(new Error("fixture executable is missing"), { code: "ENOENT" });
  assert.throws(() => verify({ run: () => {
    calls++;
    return { error: failure, status: null };
  } }), error => error === failure);
  assert.equal(calls, 1);
});
