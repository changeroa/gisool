import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, resolveGisoolHome, resolveHome } from "../config.js";
import { startServer } from "../server.js";
import { openDb } from "../store/db.js";
import { createStore } from "../store/index.js";
import type { CliDeps, PackPlan, PackPlanFile } from "../types.js";
import { readTarget } from "./config-writer.js";

export type Io = { out(text: string): void; err(text: string): void };
export const processIo: Io = { out: (t) => process.stdout.write(t), err: (t) => process.stderr.write(t) };

export const SERVICE_LABEL = "dev.gisool.daemon";

export function packageRoot(): string {
  return realpathSync(fileURLToPath(new URL("../../", import.meta.url)));
}

export function nodePath(): string {
  return realpathSync(process.execPath);
}

export function packageVersion(): string {
  const pkg = JSON.parse(readFileSync(join(packageRoot(), "package.json"), "utf8")) as { version: string };
  return pkg.version;
}

export function dbPath(gisoolHome: string): string {
  return join(gisoolHome, "gisool.db");
}

export function makeCliDeps(env: NodeJS.ProcessEnv): CliDeps {
  const config = loadConfig(env);
  const home = resolveHome(env);
  const gisoolHome = resolveGisoolHome(env);
  return { config, home, gisoolHome, env, openStore: () => createStore(openDb(dbPath(gisoolHome)), { config, home, gisoolHome }) };
}

export async function runServe(opts: { port?: number }, env: NodeJS.ProcessEnv, io: Io): Promise<number> {
  const deps = makeCliDeps(env);
  const config = opts.port === undefined ? deps.config : { ...deps.config, port: opts.port };
  const server = await startServer(config, { gisoolHome: deps.gisoolHome, openStore: deps.openStore });
  io.err(`gisool listening on http://127.0.0.1:${server.port}\n`);
  return 0;
}

export type PlannedCommand = PackPlan["commands"][number] & { allowFailure?: boolean };
export type ServicePlatform = "darwin" | "linux";
export type ServiceCtx = { home: string; gisoolHome: string; env: NodeJS.ProcessEnv; nodePath: string; packageRoot: string; platform: ServicePlatform; uid: number };
export type ServicePlan = { file: PackPlanFile; commands: PlannedCommand[]; notes: string[] };

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const unitQuote = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

export function servicePath(home: string, platform: ServicePlatform): string {
  return platform === "darwin"
    ? join(home, "Library", "LaunchAgents", `${SERVICE_LABEL}.plist`)
    : join(home, ".config", "systemd", "user", "gisool.service");
}

export function daemonLogPath(gisoolHome: string): string {
  return join(gisoolHome, "logs", "daemon.log");
}

function plist(ctx: ServiceCtx): string {
  const log = xml(daemonLogPath(ctx.gisoolHome));
  const args = [ctx.nodePath, join(ctx.packageRoot, "dist", "cli", "main.js"), "serve"].map((a) => `    <string>${xml(a)}</string>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${SERVICE_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>GISOOL_HOME</key>
    <string>${xml(ctx.gisoolHome)}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${log}</string>
  <key>StandardErrorPath</key>
  <string>${log}</string>
</dict>
</plist>
`;
}

function unit(ctx: ServiceCtx): string {
  const log = daemonLogPath(ctx.gisoolHome);
  return `[Unit]
Description=gisool local skill router

[Service]
ExecStart=${unitQuote(ctx.nodePath)} ${unitQuote(join(ctx.packageRoot, "dist", "cli", "main.js"))} serve
Environment=${unitQuote(`GISOOL_HOME=${ctx.gisoolHome}`)}
Restart=always
StandardOutput=append:${log}
StandardError=append:${log}

[Install]
WantedBy=default.target
`;
}

export function planService(ctx: ServiceCtx): ServicePlan {
  const path = servicePath(ctx.home, ctx.platform);
  const before = readTarget(path);
  const after = ctx.platform === "darwin" ? plist(ctx) : unit(ctx);
  const file: PackPlanFile = { path, before, after, mode: 0o644 };
  const commands: PlannedCommand[] = [];
  const notes: string[] = [];
  if (before === after) return { file, commands, notes: ["service definition already up to date"] };
  if (ctx.platform === "darwin") {
    const domain = `gui/${ctx.uid}`;
    if (before !== null) commands.push({ argv: ["launchctl", "bootout", `${domain}/${SERVICE_LABEL}`], description: "Unload the previous gisool LaunchAgent", allowFailure: true });
    commands.push({ argv: ["launchctl", "bootstrap", domain, path], description: "Load the gisool LaunchAgent",
      undo: { argv: ["launchctl", "bootout", `${domain}/${SERVICE_LABEL}`], description: "Unload the gisool LaunchAgent" } });
  } else {
    commands.push({ argv: ["systemctl", "--user", "daemon-reload"], description: "Reload systemd user units" });
    commands.push({ argv: ["systemctl", "--user", "enable", "--now", "gisool.service"], description: "Enable and start the gisool user service",
      undo: { argv: ["systemctl", "--user", "disable", "--now", "gisool.service"], description: "Stop and disable the gisool user service" } });
    if (before !== null) commands.push({ argv: ["systemctl", "--user", "restart", "gisool.service"], description: "Restart gisool with the new unit" });
  }
  if (ctx.env.GISOOL_NO_CLI) {
    notes.push(`GISOOL_NO_CLI set: service file written but not loaded; run manually: ${commands.map((c) => c.argv.join(" ")).join(" && ")}`);
    return { file, commands: [], notes };
  }
  return { file, commands, notes };
}

export function serviceLoaded(platform: ServicePlatform, uid: number, env: NodeJS.ProcessEnv): boolean {
  const argv = platform === "darwin" ? ["launchctl", "print", `gui/${uid}/${SERVICE_LABEL}`] : ["systemctl", "--user", "is-active", "gisool"];
  const r = spawnSync(argv[0]!, argv.slice(1), { env, stdio: "ignore" });
  return r.status === 0;
}

export function currentServicePlatform(): ServicePlatform {
  return process.platform === "darwin" ? "darwin" : "linux";
}

export function serviceStatus(env: NodeJS.ProcessEnv, io: Io): number {
  const home = resolveHome(env);
  const platform = currentServicePlatform();
  const path = servicePath(home, platform);
  const installed = existsSync(path);
  io.out(`service file: ${installed ? path : "not installed"}\n`);
  if (env.GISOOL_NO_CLI) {
    io.out("service loaded: skipped (GISOOL_NO_CLI)\n");
    return installed ? 0 : 1;
  }
  const loaded = serviceLoaded(platform, process.getuid?.() ?? 0, env);
  io.out(`service loaded: ${loaded ? "yes" : "no"}\n`);
  return installed && loaded ? 0 : 1;
}
