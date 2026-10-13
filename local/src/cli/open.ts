import { spawn } from "node:child_process";
import { loadConfig, ensureToken, resolveGisoolHome } from "../config.js";
import type { Io } from "./serve.js";

export function dashboardUrl(port: number, token: string): string {
  return `http://127.0.0.1:${port}/?token=${token}`;
}

export async function runOpen(opts: { print?: boolean }, env: NodeJS.ProcessEnv, io: Io): Promise<number> {
  const config = loadConfig(env);
  const url = dashboardUrl(config.port, ensureToken(resolveGisoolHome(env)));
  io.out(url + "\n");
  if (opts.print || env.GISOOL_NO_CLI) return 0;
  const opener = process.platform === "darwin" ? "open" : "xdg-open";
  return new Promise((resolve) => {
    const child = spawn(opener, [url], { env, stdio: "ignore", detached: true });
    child.once("error", (error) => {
      io.err(`could not run ${opener}: ${error.message}; open the URL above manually\n`);
      resolve(1);
    });
    child.once("spawn", () => {
      child.unref();
      resolve(0);
    });
  });
}
