#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ensureToken, loadConfig, resolveGisoolHome } from "../config.js";
import type { CliDeps, ExportImportApi } from "../types.js";
import { runDoctor } from "./doctor.js";
import { runInit, serviceInstall, serviceRemove } from "./init.js";
import { runOpen } from "./open.js";
import { type Io, makeCliDeps, packageVersion, processIo, runServe, serviceStatus } from "./serve.js";

export type EvalApi = { runEval(opts: { cases?: string; json?: boolean }, deps: CliDeps): Promise<number> };
export type Loaders = { exportImport(): Promise<ExportImportApi>; evalApi(): Promise<EvalApi> };

const defaultLoaders: Loaders = {
  exportImport: () => import("./export-import.js"),
  evalApi: () => import("./eval.js"),
};

export const HELP = `gisool - local skill router

Usage:
  gisool serve [--port <n>] [--foreground]   run the daemon in the foreground (used by the service)
  gisool open [--print]                      print and open the dashboard URL
  gisool init [--dry-run] [--runtime <id>...] [--no-service] [--disable-remote]
  gisool init --rollback [--all]             undo the newest (or every) init run
  gisool doctor [--json]                     check service, daemon, packs, index and backups
  gisool service install|remove|status       manage the LaunchAgent / systemd user unit
  gisool mcp-stdio                           stdio MCP proxy to the local daemon
  gisool export <dir> [--with-history]
  gisool import <dir> [--dry-run]
  gisool repair-loads --from <ms> --to <ms> [--limit <n>] [--session <id>...] [--after <event-id>] [--json]
  gisool eval [--cases <file>] [--json]
  gisool --help | --version
`;

class UsageError extends Error {
  readonly code = "usage";
}

type Parsed = { flags: Set<string>; values: Map<string, string[]>; positional: string[] };

function parseArgs(args: string[], spec: { flags: string[]; values?: string[]; multi?: string[] }): Parsed {
  const parsed: Parsed = { flags: new Set(), values: new Map(), positional: [] };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (spec.flags.includes(arg)) parsed.flags.add(arg);
    else if (spec.values?.includes(arg) || spec.multi?.includes(arg)) {
      const list = parsed.values.get(arg) ?? [];
      const multi = spec.multi?.includes(arg);
      let took = 0;
      while (i + 1 < args.length && !args[i + 1]!.startsWith("--") && (multi || took === 0)) {
        list.push(...args[++i]!.split(",").filter(Boolean));
        took++;
      }
      if (took === 0) throw new UsageError(`${arg} needs a value`);
      parsed.values.set(arg, list);
    } else if (arg.startsWith("--")) throw new UsageError(`unknown option ${arg}`);
    else parsed.positional.push(arg);
  }
  return parsed;
}

function oneDir(p: Parsed, command: string): string {
  if (p.positional.length !== 1) throw new UsageError(`${command} needs exactly one <dir>`);
  return p.positional[0]!;
}

export async function runMain(argv: string[], opts: { env?: NodeJS.ProcessEnv; io?: Io; loaders?: Loaders } = {}): Promise<number> {
  const env = opts.env ?? process.env;
  const io = opts.io ?? processIo;
  const loaders = opts.loaders ?? defaultLoaders;
  const [command, ...rest] = argv;
  try {
    switch (command) {
      case undefined:
      case "--help":
      case "-h":
      case "help":
        io.out(HELP);
        return command === undefined ? 1 : 0;
      case "--version":
      case "-v":
        io.out(packageVersion() + "\n");
        return 0;
      case "serve": {
        const p = parseArgs(rest, { flags: ["--foreground"], values: ["--port"] });
        const raw = p.values.get("--port")?.[0];
        const port = raw === undefined ? undefined : Number(raw);
        if (port !== undefined && !(Number.isInteger(port) && port > 0 && port < 65536)) throw new UsageError(`invalid --port ${raw}`);
        return await runServe({ port }, env, io);
      }
      case "open": {
        const p = parseArgs(rest, { flags: ["--print"] });
        return await runOpen({ print: p.flags.has("--print") }, env, io);
      }
      case "init": {
        const p = parseArgs(rest, { flags: ["--dry-run", "--rollback", "--all", "--no-service", "--disable-remote"], multi: ["--runtime"] });
        if (p.positional.length) throw new UsageError(`unexpected argument ${p.positional[0]}`);
        if (p.flags.has("--all") && !p.flags.has("--rollback")) throw new UsageError("--all is only valid with --rollback");
        return await runInit({
          dryRun: p.flags.has("--dry-run"), rollback: p.flags.has("--rollback"), all: p.flags.has("--all"),
          noService: p.flags.has("--no-service"), disableRemote: p.flags.has("--disable-remote"), runtimes: p.values.get("--runtime") ?? [],
        }, env, io);
      }
      case "doctor": {
        const p = parseArgs(rest, { flags: ["--json"] });
        return await runDoctor({ json: p.flags.has("--json") }, env, io);
      }
      case "service": {
        const [sub, ...subRest] = rest;
        const p = parseArgs(subRest, { flags: ["--dry-run"] });
        if (sub === "install") return await serviceInstall({ dryRun: p.flags.has("--dry-run") }, env, io);
        if (sub === "remove") return await serviceRemove(env, io);
        if (sub === "status") return serviceStatus(env, io);
        throw new UsageError("service needs install, remove, or status");
      }
      case "mcp-stdio": {
        parseArgs(rest, { flags: [] });
        const config = loadConfig(env);
        const { runStdioProxy } = await import("../mcp/stdio-proxy.js");
        await runStdioProxy({ port: config.port, token: ensureToken(resolveGisoolHome(env)) });
        return 0;
      }
      case "export": {
        const p = parseArgs(rest, { flags: ["--with-history"] });
        const dir = oneDir(p, "export");
        return await (await loaders.exportImport()).runExport(dir, { withHistory: p.flags.has("--with-history") }, makeCliDeps(env));
      }
      case "import": {
        const p = parseArgs(rest, { flags: ["--dry-run"] });
        const dir = oneDir(p, "import");
        return await (await loaders.exportImport()).runImport(dir, { dryRun: p.flags.has("--dry-run") }, makeCliDeps(env));
      }
      case "repair-loads": {
        const p = parseArgs(rest, { flags: ["--json"], values: ["--from", "--to", "--limit", "--after"], multi: ["--session"] });
        if (p.positional.length) throw new UsageError(`unexpected argument ${p.positional[0]}`);
        const integer = (name: string, fallback?: number): number => {
          const values = p.values.get(name);
          if (values === undefined && fallback !== undefined) return fallback;
          if (values?.length !== 1 || !/^\d+$/.test(values[0]!)) throw new UsageError(`${name} needs one nonnegative integer`);
          const value = Number(values[0]);
          if (!Number.isSafeInteger(value)) throw new UsageError(`${name} must be a safe integer`);
          return value;
        };
        const from = integer("--from"), to = integer("--to"), limit = integer("--limit", 100);
        if (from >= to) throw new UsageError("--from must be less than --to");
        if (limit < 1 || limit > 1000) throw new UsageError("--limit must be between 1 and 1000");
        const after = p.values.get("--after");
        if (after !== undefined && after.length !== 1) throw new UsageError("--after needs one event ID");
        const sessionIds = p.values.get("--session");
        if (sessionIds !== undefined && sessionIds.length === 0) throw new UsageError("--session needs a session ID");
        const store = makeCliDeps(env).openStore();
        try {
          const result = store.reconcileLoads({ from, to, limit,
            ...(after ? { after: after[0]! } : {}), ...(sessionIds ? { sessionIds } : {}) });
          const report = { examined: result.examined, repaired: result.repaired, pending: result.count, next: result.next };
          io.out(p.flags.has("--json") ? JSON.stringify(report) + "\n"
            : `examined: ${report.examined}; repaired: ${report.repaired}; pending in batch: ${report.pending}; next: ${report.next ?? "none"}\n`);
          return 0;
        } finally {
          store.close();
        }
      }
      case "eval": {
        const p = parseArgs(rest, { flags: ["--json"], values: ["--cases"] });
        const cases = p.values.get("--cases")?.[0];
        return await (await loaders.evalApi()).runEval({ ...(cases ? { cases } : {}), json: p.flags.has("--json") }, makeCliDeps(env));
      }
      default:
        throw new UsageError(`unknown command ${command}`);
    }
  } catch (error) {
    if (error instanceof UsageError) {
      io.err(`usage: ${error.message}\n\n${HELP}`);
      return 2;
    }
    const code = (error as { code?: unknown }).code;
    const message = (error as Error).message ?? String(error);
    io.err(`error: ${typeof code === "string" && !message.startsWith(code) ? `${code}: ` : ""}${message}\n`);
    return 1;
  }
}

function invokedDirectly(): boolean {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  process.exitCode = await runMain(process.argv.slice(2));
}
