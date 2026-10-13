import assert from "node:assert/strict";
import { test } from "node:test";
import { DAY, NOW, event, openStore } from "./helpers/store.mjs";

function seed(store) {
  const ref = { runtime: "claude-code", runtimeSessionId: "r1" };
  const sid = store.upsertSession(ref, NOW - 40 * DAY);
  const attr = { sessionId: sid, method: "runtime_id" };
  for (const age of [40, 35, 31]) store.append(event("prompt", NOW - age * DAY, ref, { text: `old ${age}` }), attr);
  for (const age of [29, 1]) store.append(event("prompt", NOW - age * DAY, ref, { text: `new ${age}` }), attr);
  return sid;
}

const texts = (db) => db.prepare("SELECT text FROM events ORDER BY ts").all().map((r) => r.text);

test("retention nulls text of the 3 events older than N days and returns the count", () => {
  const config = { port: 8799, captureLevel: "full", retentionDays: 30, roots: [], runtimes: {} };
  const { db, store } = openStore({ storeOpts: { config } });
  const sid = seed(store);
  assert.equal(store.retention(30), 3);
  assert.deepEqual(texts(db), [null, null, null, "new 29", "new 1"]);
  assert.equal(store.sessions({}).find((s) => s.id === sid).firstPrompt, undefined);
  assert.equal(store.retention(30), 0, "second pass finds nothing left");
});

test("retention is a no-op when config retentionDays is null", () => {
  const config = { port: 8799, captureLevel: "full", retentionDays: null, roots: [], runtimes: {} };
  const { db, store } = openStore({ storeOpts: { config } });
  seed(store);
  assert.equal(store.retention(30), 0);
  assert.deepEqual(texts(db), ["old 40", "old 35", "old 31", "new 29", "new 1"]);
});
