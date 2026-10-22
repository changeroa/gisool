import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { cliSandbox, runCli } from "./helpers/cli.mjs";
import { event, openStore } from "./helpers/store.mjs";

const T = 1_800_000_000_000;
const args = ["repair-loads", "--from", String(T), "--to", String(T + 100), "--limit", "2", "--json"];

function history(t) {
  const sb = cliSandbox({ runtimes: [] });
  const { db, store } = openStore({ path: join(sb.env.GISOOL_HOME, "gisool.db") });
  t.after(() => { store.close(); sb.cleanup(); });
  const refs = ["a", "b", "c"].map(runtimeSessionId => ({ runtime: "codex", runtimeSessionId }));
  const ids = refs.map(ref => store.upsertSession(ref, T - 1));
  function load(id, matches = [], { ts = T, candidates = ids.slice(0, 2), retained } = {}) {
    const uri = `skill://local/fixture/${id}/SKILL.md`;
    const pending = event("load", ts, refs[0], { id, skillUri: uri,
      data: { attributionCandidates: candidates, ...(retained ? { attributionMatches: retained } : {}) } });
    store.append(pending, { sessionId: "unattributed", method: "none", reason: "ambiguous" });
    for (const index of matches) store.append(event("tool_call", ts + 1, refs[index], {
      source: "otel", text: JSON.stringify({ server: "gisool", uri }), data: { success: true },
    }), { sessionId: ids[index], method: "runtime_id" });
    return uri;
  }
  const row = id => db.prepare("SELECT session_id, data_json FROM events WHERE id = ?").get(id);
  return { sb, db, store, refs, ids, load, row };
}

test("repair-loads repairs already stored history without ingest and is idempotent", async t => {
  const h = history(t);
  h.load("unique", [0]);
  const count = h.db.prepare("SELECT COUNT(*) n FROM events").get().n;
  assert.equal(h.row("unique").session_id, "unattributed");
  const result = await runCli(args, h.sb.env);
  assert.equal(result.code, 0, result.output);
  assert.deepEqual(JSON.parse(result.stdout), { examined: 1, repaired: 1, pending: 0, next: null });
  assert.equal(h.row("unique").session_id, h.ids[0]);
  assert.deepEqual(JSON.parse(h.row("unique").data_json).attributionMatches, [h.ids[0]]);
  assert.equal(h.db.prepare("SELECT COUNT(*) n FROM events").get().n, count);
  const before = h.row("unique");
  const repeated = await runCli(args, h.sb.env);
  assert.equal(repeated.code, 0, repeated.output);
  assert.deepEqual(JSON.parse(repeated.stdout), { examined: 0, repaired: 0, pending: 0, next: null });
  assert.deepEqual(h.row("unique"), before);
});

test("repair-loads advances past ambiguous rows and resumes equal timestamps in recording order", async t => {
  const h = history(t);
  h.load("pending-z");
  h.load("pending-a", [0, 1]);
  h.load("unique-z", [0]);
  h.load("unique-a", [1]);
  const first = await runCli(args, h.sb.env);
  assert.equal(first.code, 0, first.output);
  assert.deepEqual(JSON.parse(first.stdout), { examined: 2, repaired: 0, pending: 2, next: "pending-a" });
  const second = await runCli([...args, "--after", "pending-a"], h.sb.env);
  assert.equal(second.code, 0, second.output);
  assert.deepEqual(JSON.parse(second.stdout), { examined: 2, repaired: 2, pending: 0, next: "unique-a" });
  const end = await runCli([...args, "--after", "unique-a"], h.sb.env);
  assert.equal(end.code, 0, end.output);
  assert.deepEqual(JSON.parse(end.stdout), { examined: 0, repaired: 0, pending: 0, next: null });
  assert.equal(h.row("pending-z").session_id, "unattributed");
  assert.equal(h.row("pending-a").session_id, "unattributed");
  assert.equal(h.row("unique-z").session_id, h.ids[0]);
  assert.equal(h.row("unique-a").session_id, h.ids[1]);
});

test("repair-loads preserves privacy and retained proof, and late contradictions still retract attribution", async t => {
  const h = history(t);
  h.load("no-text");
  h.load("retained", [], { retained: [h.ids[0]] });
  const first = await runCli(args, h.sb.env);
  assert.equal(first.code, 0, first.output);
  assert.deepEqual(JSON.parse(first.stdout), { examined: 2, repaired: 1, pending: 1, next: "retained" });
  assert.equal(h.row("no-text").session_id, "unattributed");
  assert.equal(h.row("retained").session_id, h.ids[0]);
  const contrary = event("tool_call", T + 2, h.refs[1], { source: "otel",
    text: JSON.stringify({ server: "gisool", uri: "skill://local/fixture/retained/SKILL.md" }), data: { success: true } });
  h.store.append(contrary, { sessionId: h.ids[1], method: "runtime_id" });
  h.store.reconcileLoads({ eventId: contrary.id });
  assert.equal(h.row("retained").session_id, "unattributed");
  assert.deepEqual(JSON.parse(h.row("retained").data_json).attributionMatches.sort(), h.ids.slice(0, 2).sort());
});

test("repair-loads limits candidate sessions and uses an exclusive end boundary", async t => {
  const h = history(t);
  h.load("inside", [0]);
  h.load("other-session", [2], { candidates: [h.ids[2]] });
  h.load("before", [0], { ts: T - 1 });
  h.load("at-end", [0], { ts: T + 100 });
  const result = await runCli([...args, "--session", h.ids[0]], h.sb.env);
  assert.equal(result.code, 0, result.output);
  assert.deepEqual(JSON.parse(result.stdout), { examined: 1, repaired: 1, pending: 0, next: null });
  assert.equal(h.row("inside").session_id, h.ids[0]);
  for (const id of ["other-session", "before", "at-end"]) assert.equal(h.row(id).session_id, "unattributed", id);
});

test("repair-loads rejects invalid ranges and options before creating a database", async t => {
  const sb = cliSandbox({ runtimes: [] });
  t.after(sb.cleanup);
  for (const invalid of [
    ["repair-loads"],
    ["repair-loads", "--from", "0", "--to", "0"],
    ["repair-loads", "--from", "-1", "--to", "2"],
    ["repair-loads", "--from", "1.5", "--to", "2"],
    ["repair-loads", "--from", "0", "--to", "9007199254740992"],
    [...args, "--limit", "0"],
    [...args, "--limit", "1001"],
    [...args, "--from", String(T + 1)],
    [...args, "--after"],
    [...args, "unexpected"],
  ]) {
    const result = await runCli(invalid, sb.env);
    assert.equal(result.code, 2, JSON.stringify({ invalid, result }));
    assert.equal(existsSync(join(sb.env.GISOOL_HOME, "gisool.db")), false, invalid.join(" "));
  }
});

test("repair-loads rejects unknown or out-of-range cursors without changing history", async t => {
  const h = history(t);
  h.load("inside", [0]);
  h.load("outside", [0], { ts: T - 1 });
  const before = h.db.prepare("SELECT * FROM events ORDER BY rowid").all();
  for (const id of ["missing", "outside"]) {
    const result = await runCli([...args, "--after", id], h.sb.env);
    assert.equal(result.code, 1, result.output);
    assert.deepEqual(h.db.prepare("SELECT * FROM events ORDER BY rowid").all(), before);
  }
});
