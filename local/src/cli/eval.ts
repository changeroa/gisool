import type { CliDeps } from "../types.js";

// STUB from todo 1; implementation owned by todo 14.
function notImplemented(): never {
  throw Object.assign(new Error("not_implemented"), { code: "not_implemented" });
}

export async function runEval(opts: { cases?: string; json?: boolean }, deps: CliDeps): Promise<number> {
  void opts;
  void deps;
  return notImplemented();
}
