import assert from "node:assert/strict";
import { test } from "node:test";
import { distImport } from "./_helpers.mjs";
import { fixture, memoryStore } from "./helpers/ingest.mjs";

const { createIngestDeps, ingest, ingestHook, ingestOtlp } = await distImport("ingest/pipeline.js");
const { searchEvent } = await distImport("ingest/mcp-recorder.js");
const NOW = 1_800_000_000_000;

test("QA happy: Claude OTLP user_prompt -> one session row and one prompt event with full text", () => {
  const store = memoryStore();
  const published = [];
  const deps = createIngestDeps(store, { now: () => NOW, publish: (c) => published.push(c) });
  const res = ingestOtlp(fixture("claude-otlp-user-prompt.json"), deps);
  assert.deepEqual(res, { status: 200, body: { partialSuccess: {} } });
  assert.equal(store.sessions.size, 1);
  const [session] = [...store.sessions.values()];
  assert.deepEqual(session.ref, { runtime: "claude-code", runtimeSessionId: "claude-sess-1" });
  assert.equal(store.events.length, 1);
  const { event, attribution } = store.events[0];
  assert.equal(event.kind, "prompt");
  assert.equal(event.text, "Write a commit message please");
  assert.equal(event.textLength, "Write a commit message please".length);
  assert.deepEqual(attribution, { sessionId: session.id, method: "runtime_id" });
  assert.equal(published.length, 1);
  assert.equal(published[0].sessionId, session.id);
  assert.equal(store.counts.accepted, 1);
});

test("QA failure: malformed OTLP (missing resourceLogs) -> 400 bad_otlp, nothing stored", () => {
  const store = memoryStore();
  const res = ingestOtlp({ notResourceLogs: [] }, createIngestDeps(store));
  assert.equal(res.status, 400);
  assert.equal(res.body.code, "bad_otlp");
  assert.equal(store.events.length, 0);
  assert.equal(store.sessions.size, 0);
  assert.equal(store.counts.rejected, 1);
  assert.deepEqual(store.counts.codes, ["bad_otlp"]);
});

test("unknown OTLP events and unknown hook events are counted as dropped", () => {
  const store = memoryStore();
  const deps = createIngestDeps(store);
  ingestOtlp(fixture("claude-otlp-unknown-event.json"), deps);
  assert.deepEqual(ingestHook("claude-code", { hook_event_name: "Stop", session_id: "x" }, deps), { accepted: 0, dropped: 1 });
  assert.equal(store.counts.dropped, 2);
  assert.equal(store.events.length, 0);
});

test("capture level metadata drops prompt text; redacted masks secrets in search queries", () => {
  const store = memoryStore();
  ingestHook("claude-code", fixture("claude-hook-user-prompt-submit.json"), createIngestDeps(store, { captureLevel: "metadata" }));
  const { event } = store.events[0];
  assert.equal(event.text, undefined);
  assert.equal(event.textLength, "Refactor the login form".length);
  assert.match(event.textDigest, /^[0-9a-f]{64}$/);

  const redacted = createIngestDeps(store, { captureLevel: () => "redacted" });
  const secret = "sk-" + "q".repeat(30);
  ingest(searchEvent({ clientName: "codex-mcp-client", meta: { threadId: "t1" } }, { traceId: "tr", query: `use ${secret}`, mode: "discovery", elapsedMs: 1, candidates: [] }, { total: 0 }, 1), redacted);
  const search = store.events[1].event;
  assert.equal(search.text, "use [REDACTED]");
  assert.equal(search.data.query, "use [REDACTED]");
});

test("each runtime hook fixture flows through the pipeline with runtime_id attribution", () => {
  const cases = [
    ["claude-code", "claude-hook-user-prompt-submit.json"], ["codex", "codex-hook-user-prompt-submit.json"], ["gemini", "gemini-hook-before-agent.json"],
    ["cursor", "cursor-hook-before-submit-prompt.json"], ["omo", "omo-hook-before-agent-start.json"], ["gajae", "gajae-hook-before-agent-start.json"],
    ["openclaw", "openclaw-hook-before-agent-run.json"],
  ];
  const store = memoryStore();
  const deps = createIngestDeps(store, { now: () => NOW });
  for (const [runtime, name] of cases) assert.deepEqual(ingestHook(runtime, fixture(name), deps), { accepted: 1, dropped: 0 }, name);
  assert.equal(store.sessions.size, cases.length);
  assert.ok(store.events.every((e) => e.attribution.method === "runtime_id"));
  assert.deepEqual(store.events.map((e) => e.event.ref.runtime), cases.map(([r]) => r));
});

test("store errors are logged and swallowed per event", () => {
  const store = memoryStore();
  const realAppend = store.append;
  let fail = true;
  store.append = (event, attribution) => {
    if (fail) {
      fail = false;
      throw new Error("disk full");
    }
    realAppend(event, attribution);
  };
  const logged = [];
  const deps = createIngestDeps(store, { log: (msg, err) => logged.push([msg, err.message]) });
  const body = fixture("claude-otlp-user-prompt.json");
  body.resourceLogs[0].scopeLogs[0].logRecords.push(body.resourceLogs[0].scopeLogs[0].logRecords[0]);
  assert.equal(ingestOtlp(body, deps).status, 200);
  assert.equal(store.events.length, 1);
  assert.equal(logged.length, 1);
  assert.equal(logged[0][1], "disk full");
  assert.equal(store.counts.rejected, 1);
  assert.equal(store.counts.accepted, 1);
});
