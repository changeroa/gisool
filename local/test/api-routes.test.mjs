import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { bearer, fixtureText, http, jsonHeaders, startTestServer } from "./helpers/api.mjs";

let s;
before(async () => { s = await startTestServer(); });
after(async () => { await s.stop(); });

const get = (path) => http(s.port, { path, headers: bearer(s.token) });
const post = (path, body) => http(s.port, { method: "POST", path, headers: jsonHeaders(s.token), body: typeof body === "string" ? body : JSON.stringify(body) });

/** Opens the SSE stream and resolves once the server has registered the subscriber. */
function subscribe() {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: s.port, path: "/api/events/stream", headers: { Host: `127.0.0.1:${s.port}`, ...bearer(s.token) } }, (res) => {
      res.setEncoding("utf8");
      let buffer = "";
      const waiters = [];
      res.on("data", (chunk) => {
        buffer += chunk;
        let idx;
        while ((idx = buffer.indexOf("\n\n")) >= 0) {
          const frame = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          if (frame.startsWith(": connected")) resolve({ res, req, next, close: () => req.destroy() });
          const event = /^event: (.+)$/m.exec(frame)?.[1];
          const data = /^data: (.+)$/m.exec(frame)?.[1];
          if (event) waiters.shift()?.({ event, data: JSON.parse(data) });
        }
      });
      function next(timeoutMs) {
        return new Promise((ok, fail) => {
          const timer = setTimeout(() => fail(new Error(`no SSE event within ${timeoutMs} ms`)), timeoutMs);
          waiters.push((frame) => { clearTimeout(timer); ok(frame); });
        });
      }
      assert.equal(res.statusCode, 200);
      assert.match(res.headers["content-type"], /text\/event-stream/);
    });
    req.on("error", reject);
    req.end();
  });
}

test("OTLP POST is accepted with 202, publishes a SessionRow over SSE, and lists in /api/sessions", async () => {
  const stream = await subscribe();
  try {
    const waiting = stream.next(1000);
    const res = await post("/ingest/otlp/v1/logs", fixtureText("claude-otlp-user-prompt.json"));
    assert.equal(res.status, 202);
    const { event, data } = await waiting;
    assert.equal(event, "session");
    assert.equal(data.runtime, "claude-code");
    assert.equal(typeof data.id, "string");
    assert.ok(Array.isArray(data.skills));

    const sessions = await get("/api/sessions");
    assert.equal(sessions.status, 200);
    assert.ok(sessions.json.some((row) => row.id === data.id && row.runtime === "claude-code"));
    const filtered = await get("/api/sessions?runtime=codex");
    assert.deepEqual(filtered.json, []);

    const trace = await get(`/api/sessions/${encodeURIComponent(data.id)}/trace`);
    assert.equal(trace.status, 200);
    assert.ok(trace.json.some((step) => step.kind === "prompt"));
  } finally {
    stream.close();
  }
});

test("hook ingest accepts known runtimes with 202 and rejects unknown ones", async () => {
  const ok = await post("/ingest/hook/claude-code", fixtureText("claude-hook-user-prompt-submit.json"));
  assert.equal(ok.status, 202);
  const bad = await post("/ingest/hook/not-a-runtime", "{}");
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error, "unknown_runtime");
  const stats = await get("/api/stats");
  assert.ok(stats.json.ingest.accepted >= 1);
  assert.equal(typeof stats.json.lastEventByRuntime["claude-code"], "number");
});

test("read endpoints return their DTOs and validate parameters", async () => {
  const flow = await get("/api/flow?unit=all_loads&top=99");
  assert.equal(flow.status, 200);
  assert.equal(flow.json.unit, "all_loads");
  assert.deepEqual(flow.json.columns, ["task_type", "skill", "state"]);
  const heat = await get("/api/heatmap?tz=Asia/Seoul&weekStart=0&bucket=2");
  assert.equal(heat.status, 200);
  assert.equal(heat.json.tz, "Asia/Seoul");
  assert.equal(heat.json.bucketHours, 2);
  assert.equal(heat.json.weekStart, 0);
  assert.equal((await get("/api/heatmap?bucket=3")).status, 400);
  assert.equal((await get("/api/heatmap?tz=Not/AZone")).status, 400);
  assert.equal((await get("/api/sessions?state=bogus")).status, 400);
  assert.equal((await get("/api/sessions?dow=9")).status, 400);
  assert.equal((await get("/api/sessions?automated=yes")).status, 400);
  assert.equal((await get("/api/sessions?automated=include")).status, 200);
  assert.equal((await get("/api/sessions?automated=only")).status, 200);
  const week = await get("/api/skill-week");
  assert.equal(week.status, 200);
  assert.ok(Array.isArray(week.json.weeks));
  const skills = await get("/api/skills");
  assert.equal(skills.status, 200);
  assert.deepEqual(skills.json.map((e) => e.name), ["pr-review"]);
  assert.equal((await get("/api/nope")).status, 404);
});

test("/api/stats counts unattributed MCP activity in the filter range and reports no-data runtimes as null", async () => {
  const t0 = Date.now();
  const client = new Client({ name: "openclaw", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${s.port}/mcp`), { requestInit: { headers: bearer(s.token) } }));
  try {
    await client.callTool({ name: "search_skills", arguments: { query: "review pull request code" } });
  } finally {
    await client.close();
  }
  const stats = await get(`/api/stats?from=${t0}&runtime=openclaw`);
  assert.equal(stats.status, 200);
  assert.deepEqual(stats.json.unattributed, { searches: 1, loads: 0 });
  assert.equal(stats.json.attributionRate.openclaw, 0);
  assert.equal(stats.json.attributionRate.cursor, null);
  const past = await get(`/api/stats?to=${t0 - 86_400_000}`);
  assert.deepEqual(past.json.unattributed, { searches: 0, loads: 0 });
  assert.equal((await get("/api/stats?runtime=bogus")).status, 400);
});

test("POST /api/eval-cases stores a case and validates the body", async () => {
  assert.equal((await post("/api/eval-cases", { query: "review my PR", expectedUri: "skill://local/agents/pr-review/SKILL.md" })).status, 201);
  assert.equal((await post("/api/eval-cases", { expectedUri: "x" })).status, 400);
  assert.equal((await post("/api/eval-cases", "{not json")).status, 400);
});

test("Streamable HTTP MCP works through the composed daemon", async () => {
  const client = new Client({ name: "claude-code", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${s.port}/mcp`), {
    requestInit: { headers: bearer(s.token) },
  }));
  try {
    const tools = await client.listTools();
    assert.ok(tools.tools.some((t) => t.name === "search_skills"));
    const result = await client.callTool({ name: "search_skills", arguments: { query: "review pull request code" } });
    const body = JSON.parse(result.content[0].text);
    assert.equal(body.candidates[0].uri, "skill://local/agents/pr-review/SKILL.md");
  } finally {
    await client.close();
  }
});
