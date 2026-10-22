import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function verify({ root = fileURLToPath(new URL("../", import.meta.url)), run = spawnSync } = {}) {
  const checks = [
    ["server", "npm", ["ci"]],
    ["worker", "npm", ["ci"]],
    ["server", "npm", ["run", "build"]],
    ["server", "npm", ["test"]],
    [".", process.execPath, ["server/bench/search.mjs", "--check"]],
    ["server", "npm", ["run", "build:codex-plugin"]],
    ["worker", "npm", ["run", "typecheck"]],
    ["worker", "npm", ["test"]],
    [".", process.execPath, ["scripts/check-team-plugin.mjs"]],
    ["local", "npm", ["ci"]],
    ["local", "npm", ["run", "build"]],
    ["local", "npm", ["run", "typecheck"]],
    ["local", "npm", ["test"]],
    [".", process.execPath, ["local/bench/search.mjs", "--check"]],
    ["worker", "npx", ["--no-install", "wrangler", "deploy", "--config", "wrangler.team.jsonc", "--dry-run"]],
    ["worker", "npx", ["--no-install", "wrangler", "versions", "upload", "--dry-run"]],
    ["worker", "npx", ["--no-install", "wrangler", "deploy", "--config", "wrangler.oauth.jsonc", "--dry-run"]],
  ];
  for (const [directory, command, args] of checks) {
    console.log(`Running ${command} ${args.join(" ")} (${directory})`);
    const result = run(command, args, {
      cwd: resolve(root, directory),
      stdio: "inherit",
      env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed (${result.signal ?? result.status})`);
  }
  return checks.length;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    console.log(`Runtime verification passed (${verify()} checks)`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
