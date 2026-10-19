import type { CliDeps, ExportImportApi, RuntimePack } from "../types.js";
import type { ImportResult } from "../store/index.js";
import { claudeCodePack } from "../packs/claude-code.js";
import { codexPack } from "../packs/codex.js";
import { cursorPack } from "../packs/cursor.js";
import { gajaePack } from "../packs/gajae.js";
import { geminiPack } from "../packs/gemini.js";
import { omoPack } from "../packs/omo.js";
import { openclawPack } from "../packs/openclaw.js";

const PACKS: RuntimePack[] = [claudeCodePack, codexPack, geminiPack, cursorPack, omoPack, gajaePack, openclawPack];

function fail(error: unknown): number {
  const code = (error as { code?: unknown })?.code;
  const message = error instanceof Error ? error.message : String(error);
  console.error(typeof code === "string" ? `${code}: ${message}` : message);
  return 1;
}

export const runExport: ExportImportApi["runExport"] = async (dir, opts, deps) => {
  const store = deps.openStore();
  try {
    store.exportTo(dir, { withHistory: opts.withHistory });
    console.log(`exported to ${dir}${opts.withHistory ? " (with history)" : ""}`);
    return 0;
  } catch (error) {
    return fail(error);
  } finally {
    store.close();
  }
};

function list(label: string, items: string[]): string {
  return `  ${label}: ${items.length > 0 ? items.join(", ") : "none"}`;
}

async function printDetection(deps: CliDeps): Promise<void> {
  console.log("runtime detection:");
  for (const pack of PACKS) {
    const d = await pack.detect({ home: deps.home, env: deps.env });
    console.log(`  ${pack.id}: ${d.installed ? "detected" : "not detected"}`);
  }
}

export const runImport: ExportImportApi["runImport"] = async (dir, opts, deps) => {
  const store = deps.openStore();
  try {
    const preview = store.importFrom(dir, { merge: false }) as ImportResult;
    const d = preview.details;
    console.log(opts.dryRun ? "import preview (dry run, nothing written):" : "import preview:");
    console.log(list("roots to add", d.roots.added));
    console.log(`  eval cases to add: ${d.evalCases.added} (already present: ${d.evalCases.skipped})`);
    console.log(list("config keys to add", d.configKeys.added));
    console.log(list("config keys already present (kept)", d.configKeys.kept));
    console.log(list("aliases to add", d.aliases.added));
    if (d.history) {
      const rows = Object.entries(d.history.tables).filter(([, n]) => n > 0).map(([table, n]) => `${n} ${table}`);
      console.log(`  history to add: ${rows.length > 0 ? rows.join(", ") : "nothing new"} (already present: ${d.history.skipped})`);
    }
    if (opts.dryRun) return 0;
    store.importFrom(dir, { merge: true });
    console.log("import applied");
    await printDetection(deps);
    console.log("next: run `gisool init`");
    return 0;
  } catch (error) {
    return fail(error);
  } finally {
    store.close();
  }
};
