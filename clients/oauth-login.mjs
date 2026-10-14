import { spawnSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { endpoint, gajaeTransport, omoTransport, parseArgs, remotePackage, resolveAgentDir } from "./runtime-install.mjs";

export async function login(runtime, argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log(`Usage: node clients/${runtime}/login.mjs [--agent-dir PATH] [--dry-run]\nConnects Gisul through browser OAuth and lists the available MCP tools. Credentials stay in this profile's gisul/auth directory.`);
    return;
  }
  const agentDir = resolveAgentDir(runtime, options);
  const transport = runtime === "oh-my-openagent" ? omoTransport(agentDir) : gajaeTransport(agentDir);
  const metadata = transport.args[transport.args.indexOf("--static-oauth-client-metadata") + 1];
  const args = ["--yes", `--package=${remotePackage}`, "mcp-remote-client", endpoint(), "--transport", "http-only", "--static-oauth-client-metadata", metadata];
  if (options.dryRun) console.log(JSON.stringify({ command: ["npx", ...args], env: transport.env }, null, 2));
  else {
    await mkdir(transport.env.MCP_REMOTE_CONFIG_DIR, { recursive: true, mode: 0o700 });
    const result = spawnSync("npx", args, { env: { ...process.env, ...transport.env }, stdio: "inherit", timeout: 600000 });
    if (result.error || result.status !== 0) throw new Error("Gisul sign-in/read check did not finish successfully; retry login before starting the runtime.");
  }
}
