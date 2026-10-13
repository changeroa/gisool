import type { GisoolConfig, Store } from "./types.js";

// STUB from todo 1; implementation owned by todo 12.
export type ServerDeps = { gisoolHome?: string; openStore?: () => Store };
export type RunningServer = { port: number; close(): Promise<void> };

function notImplemented(): never {
  throw Object.assign(new Error("not_implemented"), { code: "not_implemented" });
}

export async function startServer(config: GisoolConfig, deps?: ServerDeps): Promise<RunningServer> {
  void config;
  void deps;
  return notImplemented();
}
