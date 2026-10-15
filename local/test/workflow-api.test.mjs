import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { distImport } from "./_helpers.mjs";
import { bearer, http, jsonHeaders, startTestServer } from "./helpers/api.mjs";
import { event, NOW, openStore, uri } from "./helpers/store.mjs";

const { compare, compareFlow } = await distImport("workflow/compare.js");

let s;
before(async () => { s = await startTestServer(); });
after(async () => { await s.stop(); });

const get = (path) => http(s.port, { path, headers: bearer(s.token) });
const post = (path, body) => http(s.port, { method: "POST", path, headers: jsonHeaders(s.token), body: typeof body === "string" ? body : JSON.stringify(body) });

const SPEC = {
  name: "ship-feature",
  steps: [
    { id: "plan", skills: ["ulw-plan"], doneWhen: "plan written" },
    { id: "build", skills: ["programming", "debugging"], together: true, expectTools: ["Edit", "Bash"] },
  ],
};

test("the same spec keeps version 1, a changed spec becomes version 2", async () => {
  const first = await post("/api/workflows", SPEC);
  assert.equal(first.status, 201);
  assert.equal(first.json.version, 1);
  assert.equal(first.json.created, true);
  assert.match(first.json.digest, /^sha256:[0-9a-f]{64}$/);

  const sameSpelledOut = await post("/api/workflows", {
    steps: [
      { skills: ["ulw-plan"], doneWhen: "plan written", id: "plan", together: false, expectTools: [] },
      { id: "build", expectTools: ["Edit", "Bash"], together: true, skills: ["programming", "debugging"] },
    ],
    name: "ship-feature",
  });
  assert.equal(sameSpelledOut.status, 200);
  assert.equal(sameSpelledOut.json.version, 1);
  assert.equal(sameSpelledOut.json.created, false);
  assert.equal(sameSpelledOut.json.digest, first.json.digest);
  assert.equal(sameSpelledOut.json.id, first.json.id);

  const changed = await post("/api/workflows", { ...SPEC, steps: [...SPEC.steps, { id: "review", skills: ["review-work"] }] });
  assert.equal(changed.status, 201);
  assert.equal(changed.json.version, 2);
  assert.notEqual(changed.json.digest, first.json.digest);

  const latest = await get("/api/workflows");
  assert.equal(latest.status, 200);
  const rows = latest.json.filter((r) => r.name === "ship-feature");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].version, 2);
  assert.deepEqual(rows[0].steps.map((step) => step.id), ["plan", "build", "review"]);
  assert.deepEqual(rows[0].steps[0], { id: "plan", skills: ["ulw-plan"], together: false, expectTools: [], doneWhen: "plan written" });

  const versions = await get("/api/workflows/ship-feature/versions");
  assert.equal(versions.status, 200);
  assert.deepEqual(versions.json.map((r) => r.version), [2, 1]);

  const unknown = await get("/api/workflows/not-registered/versions");
  assert.equal(unknown.status, 404);
  assert.equal(unknown.json.error, "spec_not_found");
});

test("malformed specs are refused with 400 and nothing is stored", async () => {
  const before = (await get("/api/workflows")).json.length;
  const cases = [
    ["broken JSON", "{\"name\": ", "bad_json"],
    ["unknown key", { ...SPEC, name: "extra-key", extra: 1 }, "bad_request"],
    ["wrong type", { name: "wrong-type", steps: "plan" }, "bad_request"],
    ["no steps", { name: "no-steps", steps: [] }, "bad_request"],
    ["51 steps", { name: "too-many", steps: Array.from({ length: 51 }, (_, i) => ({ id: `s${i}`, skills: [] })) }, "bad_request"],
    ["11 skills", { name: "too-many-skills", steps: [{ id: "a", skills: Array.from({ length: 11 }, (_, i) => `skill-${i}`) }] }, "bad_request"],
    ["duplicate step ids", { name: "dup-steps", steps: [{ id: "a", skills: [] }, { id: "a", skills: [] }] }, "bad_request"],
    ["name is not a slug", { name: "not a slug", steps: [{ id: "a", skills: [] }] }, "bad_request"],
    ["doneWhen over 500 chars", { name: "long-done", steps: [{ id: "a", skills: [], doneWhen: "x".repeat(501) }] }, "bad_request"],
  ];
  for (const [label, body, error] of cases) {
    const res = await post("/api/workflows", body);
    assert.equal(res.status, 400, `${label}: ${res.text}`);
    assert.equal(res.json.error, error, label);
  }
  const dup = await post("/api/workflows", { name: "dup-steps", steps: [{ id: "a", skills: [] }, { id: "a", skills: [] }] });
  assert.match(JSON.stringify(dup.json.issues), /step ids must be unique/);
  assert.equal((await get("/api/workflows")).json.length, before);
});

test("flows are registered per workspace and tab, one open at a time", async () => {
  const missing = await post("/api/flows", { workspaceId: "ws-a", tabId: "tab-1", spec: { name: "never-registered" } });
  assert.equal(missing.status, 404);
  assert.equal(missing.json.error, "spec_not_found");

  const missingVersion = await post("/api/flows", { workspaceId: "ws-a", tabId: "tab-1", spec: { name: "ship-feature", version: 99 } });
  assert.equal(missingVersion.status, 404);

  const created = await post("/api/flows", { workspaceId: "ws-a", tabId: "tab-1", spec: { name: "ship-feature" }, label: "QA run" });
  assert.equal(created.status, 201);
  assert.equal(created.json.workspaceId, "ws-a");
  assert.equal(created.json.tabId, "tab-1");
  assert.equal(created.json.label, "QA run");
  assert.equal(created.json.spec.version, 2);

  const duplicate = await post("/api/flows", { workspaceId: "ws-a", tabId: "tab-1", spec: { name: "ship-feature" } });
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.json.error, "flow_already_open");
  assert.equal(duplicate.json.flowId, created.json.id);

  const otherTab = await post("/api/flows", { workspaceId: "ws-a", tabId: "tab-2", spec: { name: "ship-feature", version: 1 } });
  assert.equal(otherTab.status, 201);
  assert.equal(otherTab.json.spec.version, 1);

  const pinned = await post("/api/flows", { workspaceId: "ws-b", spec: { name: "ship-feature", version: 1 } });
  assert.equal(pinned.status, 201);
  assert.equal(pinned.json.tabId, null);

  const ended = await post(`/api/flows/${created.json.id}/end`, {});
  assert.equal(ended.status, 200);
  assert.equal(ended.json.alreadyEnded, false);
  assert.equal(typeof ended.json.endedMs, "number");

  const endedAgain = await post(`/api/flows/${created.json.id}/end`, {});
  assert.equal(endedAgain.status, 200);
  assert.equal(endedAgain.json.alreadyEnded, true);
  assert.equal(endedAgain.json.endedMs, ended.json.endedMs);

  const reopened = await post("/api/flows", { workspaceId: "ws-a", tabId: "tab-1", spec: { name: "ship-feature" } });
  assert.equal(reopened.status, 201);
  assert.notEqual(reopened.json.id, created.json.id);

  assert.equal((await post("/api/flows/does-not-exist/end", {})).status, 404);
  assert.equal((await post("/api/flows", { workspaceId: "", spec: { name: "ship-feature" } })).status, 400);
  assert.equal((await post("/api/flows", { workspaceId: "ws-c", spec: { name: "ship-feature" }, surprise: true })).status, 400);
});

test("mapping a pane to a step rejects an unknown stepId and is idempotent", async () => {
  const flow = (await post("/api/flows", { workspaceId: "ws-steps", spec: { name: "ship-feature" } })).json;

  const unknown = await post(`/api/flows/${flow.id}/steps`, { paneId: "pane-1", stepId: "nope" });
  assert.equal(unknown.status, 400);
  assert.equal(unknown.json.error, "unknown_step");
  assert.deepEqual(unknown.json.steps, ["plan", "build", "review"]);

  const mapped = await post(`/api/flows/${flow.id}/steps`, { paneId: "pane-1", stepId: "plan" });
  assert.equal(mapped.status, 201);
  assert.equal(mapped.json.created, true);

  const again = await post(`/api/flows/${flow.id}/steps`, { paneId: "pane-1", stepId: "plan" });
  assert.equal(again.status, 200);
  assert.equal(again.json.created, false);

  assert.equal((await post("/api/flows/does-not-exist/steps", { paneId: "p", stepId: "plan" })).status, 404);
  assert.equal((await post(`/api/flows/${flow.id}/steps`, { paneId: "pane-1" })).status, 400);
  assert.equal((await post(`/api/flows/${flow.id}/steps`, { paneId: 7, stepId: "plan" })).status, 400);
});

test("two concurrent registrations for one workspace and tab yield one flow and one conflict", async () => {
  const body = { workspaceId: "ws-race", tabId: "tab-race", spec: { name: "ship-feature" } };
  const [a, b] = await Promise.all([post("/api/flows", body), post("/api/flows", body)]);
  const statuses = [a.status, b.status].sort();
  assert.deepEqual(statuses, [201, 409]);
  const winner = a.status === 201 ? a : b;
  const loser = a.status === 201 ? b : a;
  assert.equal(loser.json.flowId, winner.json.id);
});

const COMPARE_SPEC = {
  name: "compare",
  steps: [
    { id: "a", skills: ["alpha"], together: false, expectTools: [] },
    { id: "b", skills: ["beta", "gamma"], together: true, expectTools: [] },
    { id: "c", skills: ["delta"], together: false, expectTools: ["Edit"] },
    { id: "d", skills: ["epsilon"], together: false, expectTools: [] },
    { id: "e", skills: ["zeta"], together: false, expectTools: [] },
  ],
};

test("compare reports one status per step plus unplanned panes", () => {
  const result = compare({
    spec: COMPARE_SPEC,
    steps: [{ stepId: "a", paneId: "p1" }, { stepId: "b", paneId: "p2" }, { stepId: "c", paneId: "p3" }, { stepId: "d", paneId: "p4" }],
    paneSkillUse: { p1: ["alpha", "extra"], p2: ["beta"], p3: ["other"], p4: [], p9: ["loose", "loose"] },
    paneTools: { p1: ["Bash"], p3: ["Edit", "Bash"] },
    panes: ["p1", "p2", "p3", "p4", "p9"],
  });
  assert.deepEqual(result.steps.map((s) => s.status), ["matched", "partial", "different", "no_skill_used", "not_run"]);

  const [a, b, c, d, e] = result.steps;
  assert.deepEqual(a, { stepId: "a", panes: ["p1"], intendedSkills: ["alpha"], usedSkills: ["alpha", "extra"], status: "matched", extraSkills: ["extra"], missingSkills: [], unexpectedTools: [] });
  assert.deepEqual(b.missingSkills, ["gamma"]);
  assert.deepEqual(c.extraSkills, ["other"]);
  assert.deepEqual(c.missingSkills, ["delta"]);
  assert.deepEqual(c.unexpectedTools, ["Bash"]);
  assert.deepEqual(d.usedSkills, []);
  assert.deepEqual(d.missingSkills, ["epsilon"]);
  assert.deepEqual(e.panes, []);
  assert.deepEqual(result.unplanned, [{ paneId: "p9", usedSkills: ["loose"] }]);
});

test("together requires every intended skill, otherwise any one of them matches", () => {
  const spec = {
    name: "together",
    steps: [
      { id: "all", skills: ["beta", "gamma"], together: true, expectTools: [] },
      { id: "any", skills: ["beta", "gamma"], together: false, expectTools: [] },
    ],
  };
  const both = compare({
    spec, steps: [{ stepId: "all", paneId: "p1" }, { stepId: "any", paneId: "p2" }],
    paneSkillUse: { p1: ["beta", "gamma"], p2: ["beta", "gamma"] }, paneTools: {}, panes: ["p1", "p2"],
  });
  assert.deepEqual(both.steps.map((s) => s.status), ["matched", "matched"]);

  const one = compare({
    spec, steps: [{ stepId: "all", paneId: "p1" }, { stepId: "any", paneId: "p2" }],
    paneSkillUse: { p1: ["beta"], p2: ["gamma"] }, paneTools: {}, panes: ["p1", "p2"],
  });
  assert.deepEqual(one.steps.map((s) => s.status), ["partial", "matched"]);
  assert.deepEqual(one.steps[1].missingSkills, ["beta"]);
});

test("a step that intends no skill matches an empty pane and differs when skills are used", () => {
  const spec = { name: "no-intent", steps: [{ id: "free", skills: [], together: false, expectTools: [] }] };
  const quiet = compare({ spec, steps: [{ stepId: "free", paneId: "p1" }], paneSkillUse: { p1: [] }, paneTools: {}, panes: ["p1"] });
  assert.equal(quiet.steps[0].status, "matched");
  const busy = compare({ spec, steps: [{ stepId: "free", paneId: "p1" }], paneSkillUse: { p1: ["alpha"] }, paneTools: {}, panes: ["p1"] });
  assert.equal(busy.steps[0].status, "different");
  assert.deepEqual(busy.steps[0].extraSkills, ["alpha"]);
});

test("compareFlow derives used skills from the events of the sessions linked to each pane", () => {
  const { db, store } = openStore();
  try {
    const { row: spec } = store.putWorkflowSpec({
      name: "trace-flow",
      steps: [
        { id: "research", skills: ["research-deep"], together: false, expectTools: [] },
        { id: "write", skills: ["docs-writer", "commit-helper"], together: true, expectTools: ["Edit"] },
        { id: "verify", skills: ["debug-trace"], together: false, expectTools: [] },
      ],
    });
    const pane = db.prepare("INSERT INTO herdr_panes (id, workspace_id, tab_id, label, cwd, created_ms) VALUES (?, ?, ?, ?, ?, ?)");
    for (const id of ["pane-1", "pane-2", "pane-3"]) pane.run(id, "ws-1", "tab-1", id, "/tmp/qa", NOW);
    const link = db.prepare("INSERT INTO pane_sessions (pane_id, agent, source, agent_session_value, session_id, first_seen_ms, last_seen_ms) VALUES (?, ?, ?, ?, ?, ?, ?)");
    const seed = (paneId, key, events) => {
      const ref = { runtime: "claude-code", runtimeSessionId: key };
      const sid = store.upsertSession(ref, NOW);
      for (const e of events) store.append(e(ref), { sessionId: sid, method: "runtime_id" });
      link.run(paneId, "claude", "herdr:reported", key, sid, NOW, NOW);
    };
    seed("pane-1", "s-research", [(ref) => event("load", NOW + 1000, ref, { skillUri: uri("research-deep"), loadId: "l1", traceId: "t1", data: {} })]);
    seed("pane-2", "s-write", [
      (ref) => event("native_skill", NOW + 2000, ref, { data: { name: "docs-writer", via: "tool" } }),
      (ref) => event("tool_call", NOW + 2500, ref, { data: { name: "Bash" } }),
    ]);
    seed("pane-3", "s-loose", [(ref) => event("load", NOW + 3000, ref, { skillUri: uri("aside-browser"), loadId: "l2", traceId: "t2", data: {} })]);

    const result = store.createFlow({ workspaceId: "ws-1", tabId: "tab-1", specId: spec.id });
    assert.equal(result.created, true);
    const flowId = result.flow.id;
    store.mapFlowStep(flowId, "pane-1", "research");
    store.mapFlowStep(flowId, "pane-2", "write");

    const comparison = compareFlow(store, flowId);
    assert.deepEqual(comparison.steps.map((s) => s.status), ["matched", "partial", "not_run"]);
    assert.deepEqual(comparison.steps[0].usedSkills, ["research-deep"]);
    assert.deepEqual(comparison.steps[1].usedSkills, ["docs-writer"]);
    assert.deepEqual(comparison.steps[1].missingSkills, ["commit-helper"]);
    assert.deepEqual(comparison.steps[1].unexpectedTools, ["Bash"]);
    assert.deepEqual(comparison.unplanned, [{ paneId: "pane-3", usedSkills: ["aside-browser"] }]);
    assert.equal(compareFlow(store, "does-not-exist"), undefined);

    store.endFlow(flowId);
    const afterEnd = compareFlow(store, flowId);
    assert.deepEqual(afterEnd.steps.map((s) => s.status), ["no_skill_used", "no_skill_used", "not_run"],
      "an ended flow stops counting at ended_ms, and every seeded event is later than that");
  } finally {
    store.close();
  }
});

test("a skill activated before the flow was registered still counts for its step", () => {
  let clock = 1000;
  const { db, store } = openStore({ storeOpts: { now: () => clock } });
  try {
    const { row: spec } = store.putWorkflowSpec({
      name: "boundary",
      steps: [{ id: "build", skills: ["alpha"], together: false, expectTools: ["Edit"] }],
    });
    const ref = { runtime: "claude-code", runtimeSessionId: "boundary" };
    const sessionId = store.upsertSession(ref, 900);
    db.prepare("INSERT INTO herdr_panes (id, workspace_id, created_ms) VALUES (?, ?, ?)").run("boundary-pane", "ws", 800);
    db.prepare("INSERT INTO pane_sessions (pane_id, agent_session_value, session_id, first_seen_ms, last_seen_ms) VALUES (?, ?, ?, ?, ?)")
      .run("boundary-pane", "boundary", sessionId, 800, 2000);
    for (const [kind, ts, data, turnKey] of [
      ["prompt", 900, {}, "turn-1"],
      ["native_skill", 950, { name: "alpha" }, "turn-1"],
      ["tool_call", 1050, { toolName: "Edit", success: true }, "turn-1"],
      ["prompt", 1200, {}, "turn-2"],
      ["native_skill", 1300, { name: "omega" }, "turn-2"],
    ]) {
      store.append({ id: `${kind}-${ts}`, kind, ts, source: "otel", ref, data, turnKey }, { sessionId, method: "runtime_id" });
    }
    const { flow } = store.createFlow({ workspaceId: "ws", specId: spec.id });
    store.mapFlowStep(flow.id, "boundary-pane", "build");
    clock = 1100;
    store.endFlow(flow.id);

    const [build] = compareFlow(store, flow.id).steps;
    assert.deepEqual(build.usedSkills, ["alpha"], "alpha was activated at 950, before the flow was registered at 1000, and omega at 1300 is after its end");
    assert.equal(build.status, "matched");
    assert.deepEqual(build.missingSkills, []);
    assert.deepEqual(build.unexpectedTools, []);
  } finally {
    store.close();
  }
});

test("expectTools has no element count limit and round-trips what it was given", async () => {
  for (const count of [21, 101, 500]) {
    const tools = Array.from({ length: count }, (_, i) => `tool${i}`);
    const name = `tools-${count}`;
    const created = await post("/api/workflows", { name, steps: [{ id: "build", skills: [], expectTools: tools }] });
    assert.equal(created.status, 201, `${count} tools: ${created.text}`);
    const stored = await get(`/api/workflows/${name}/versions`);
    assert.deepEqual(stored.json[0].steps[0].expectTools, tools, `${count} tools must round-trip unchanged`);
  }
});

test("a pane reused by a later flow does not inherit the earlier flow's skills or tools", () => {
  let clock = 1000;
  const { db, store } = openStore({ storeOpts: { now: () => clock } });
  try {
    const { row: spec } = store.putWorkflowSpec({
      name: "reuse", steps: [{ id: "build", skills: ["alpha"], together: false, expectTools: ["Edit"] }],
    });
    const ref = { runtime: "claude-code", runtimeSessionId: "reuse" };
    const sessionId = store.upsertSession(ref, 900);
    db.prepare("INSERT INTO herdr_panes (id, workspace_id, created_ms) VALUES (?, ?, ?)").run("reuse-pane", "ws", 800);
    db.prepare("INSERT INTO pane_sessions (pane_id, agent_session_value, session_id, first_seen_ms, last_seen_ms) VALUES (?, ?, ?, ?, ?)")
      .run("reuse-pane", "reuse", sessionId, 900, 2100);
    const append = (kind, ts, data, turnKey) =>
      store.append({ id: `${kind}-${ts}`, kind, ts, source: "otel", ref, data, turnKey }, { sessionId, method: "runtime_id" });
    const stepOf = (flowId) => compareFlow(store, flowId).steps[0];

    append("prompt", 900, {}, "turn-1");
    append("native_skill", 950, { name: "alpha" }, "turn-1");
    append("tool_call", 1050, { toolName: "Edit", success: true }, "turn-1");
    append("prompt", 1200, {}, "turn-2");
    const { flow: first } = store.createFlow({ workspaceId: "ws", specId: spec.id });
    store.mapFlowStep(first.id, "reuse-pane", "build");
    clock = 1100;
    store.endFlow(first.id);
    const firstStep = stepOf(first.id);
    assert.deepEqual(firstStep.usedSkills, ["alpha"], "alpha was activated at 950, before this flow was registered at 1000");
    assert.equal(firstStep.status, "matched");
    assert.deepEqual(firstStep.unexpectedTools, []);

    append("tool_call", 1060, { toolName: "Bash", success: true }, "turn-1");
    clock = 2000;
    const { flow: second } = store.createFlow({ workspaceId: "ws", specId: spec.id });
    store.mapFlowStep(second.id, "reuse-pane", "build");
    append("tool_call", 2050, { toolName: "Edit", success: true }, "turn-2");
    clock = 2100;
    store.endFlow(second.id);
    const secondStep = stepOf(second.id);
    assert.deepEqual(secondStep.usedSkills, [], "alpha belongs to the flow that ended at 1100");
    assert.equal(secondStep.status, "no_skill_used");
    assert.deepEqual(secondStep.missingSkills, ["alpha"]);
    assert.deepEqual(secondStep.unexpectedTools, [], "Bash at 1060 ran inside the earlier flow's window");

    const { row: newer } = store.putWorkflowSpec({
      name: "reuse", steps: [{ id: "build", skills: ["alpha", "beta"], together: true, expectTools: ["Edit"] }],
    });
    append("prompt", 2200, {}, "turn-3");
    append("native_skill", 2950, { name: "beta" }, "turn-3");
    clock = 3000;
    const { flow: third } = store.createFlow({ workspaceId: "ws", specId: newer.id });
    store.mapFlowStep(third.id, "reuse-pane", "build");
    append("tool_call", 3050, { toolName: "Edit", success: true }, "turn-3");
    clock = 3100;
    store.endFlow(third.id);
    const thirdStep = stepOf(third.id);
    assert.deepEqual(thirdStep.usedSkills, ["beta"], "beta was activated at 2950, after the previous flow ended at 2100");
    assert.equal(thirdStep.status, "partial");
    assert.deepEqual(thirdStep.missingSkills, ["alpha"]);
    assert.deepEqual(thirdStep.unexpectedTools, []);

    assert.deepEqual(stepOf(first.id).usedSkills, ["alpha"], "the first flow keeps its own skill after later flows ran");
  } finally {
    store.close();
  }
});
