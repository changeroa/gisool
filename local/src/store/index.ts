import type { Db } from "./db.js";
import { createPortable } from "./export.js";
import { createQueries } from "./queries.js";
import { createWrites, type StoreOptions } from "./writes.js";
import type { Store } from "../types.js";

export type { StoreOptions } from "./writes.js";
export type { ExportDoc, ImportDetails, ImportResult } from "./export.js";
export { EXPORT_FILE, HISTORY_FILE } from "./export.js";
export { adoptionState, classifyTaskType, localDowHour, taskTypeRules } from "./queries.js";

/**
 * importFrom(dir, { merge: false }) is a dry run: it returns the same counts (plus `details`) without writing anything;
 * { merge: true } applies, never overwriting existing config keys, roots, aliases, eval cases, sessions, or events.
 */
export function createStore(db: Db, opts: StoreOptions = {}): Store {
  const ctx = { db, opts, now: opts.now ?? Date.now };
  return { ...createWrites(ctx), ...createQueries(ctx), ...createPortable(ctx), close: () => db.close() };
}
