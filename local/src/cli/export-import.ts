import type { CliDeps, ExportImportApi } from "../types.js";

// STUB from todo 1; implementation owned by todo 14.
function notImplemented(): never {
  throw Object.assign(new Error("not_implemented"), { code: "not_implemented" });
}

export const runExport: ExportImportApi["runExport"] = async (dir: string, opts: { withHistory: boolean }, deps: CliDeps) => {
  void dir;
  void opts;
  void deps;
  return notImplemented();
};

export const runImport: ExportImportApi["runImport"] = async (dir: string, opts: { dryRun: boolean }, deps: CliDeps) => {
  void dir;
  void opts;
  void deps;
  return notImplemented();
};
