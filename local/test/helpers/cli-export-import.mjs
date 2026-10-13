import { join } from "node:path";
import { distImport } from "../_helpers.mjs";

const { openDb } = await distImport("store/db.js");
const { createStore } = await distImport("store/index.js");

/** CliDeps over a sandbox HOME; openStore opens <gisoolHome>/gisool.db with the real store wiring. */
export function makeDeps(home, env, config = { port: 8799, captureLevel: "full", retentionDays: null, roots: [], runtimes: {} }) {
  const gisoolHome = join(home, ".gisool");
  return {
    config, home, gisoolHome, env,
    openStore: () => createStore(openDb(join(gisoolHome, "gisool.db")), { home, gisoolHome, config }),
  };
}

/** Runs fn while capturing console.log / console.error lines. */
export async function capture(fn) {
  const lines = [];
  const log = console.log, err = console.error;
  console.log = (...a) => lines.push(a.join(" "));
  console.error = (...a) => lines.push(a.join(" "));
  try {
    const code = await fn();
    return { code, out: lines.join("\n") };
  } finally {
    console.log = log;
    console.error = err;
  }
}
