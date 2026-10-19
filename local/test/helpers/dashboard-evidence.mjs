import { join } from "node:path";
import { distImport } from "../_helpers.mjs";
import { NOW as T, uri } from "./store.mjs";

const { openDb } = await distImport("store/db.js");
const { createStore } = await distImport("store/index.js");

export function seedEvidence(gisoolHome) {
  let clock = T - 1;
  const store = createStore(openDb(join(gisoolHome, "gisool.db")), { now: () => clock });
  let seq = 0;
  const ids = {};
  const candidate = (name, rank, digest = name) => ({
    name, rank, uri: uri(name), digest, score: 10 - rank, description: "", invocation: "automatic", matched: [],
  });
  function session(key, events) {
    const ref = { runtime: "claude-code", runtimeSessionId: key };
    const id = store.upsertSession(ref, T - 10000);
    ids[key] = id;
    for (const [kind, offset, rest = {}] of events) {
      store.append({ id: `${key}-${++seq}`, ts: T + offset, kind, source: "otel", ref, data: {}, ...rest }, { sessionId: id, method: "runtime_id" });
    }
  }
  try {
    session("evidence", [
      ["prompt", 0, { turnKey: "evidence-1", text: "find a skill" }],
      ["native_skill", 1, { turnKey: "evidence-1", data: { name: "native-before", path: "/skills/native-before/SKILL.md" } }],
      ["search", 2, { turnKey: "evidence-1", data: { query: "inspect skill use", candidates: [
        candidate("first", 1, "same"), candidate("first-copy", 2, "same"), candidate("lower", 3),
      ] } }],
      ["load", 3, { turnKey: "evidence-1", skillUri: uri("lower"), data: { uri: uri("lower") } }],
      ["read_file", 4, { turnKey: "evidence-1", skillUri: uri("lower"), data: { skillUri: uri("lower"), uri: "skill://agents/lower/reference.md", bytes: 23 } }],
      ["tool_call", 5, { turnKey: "evidence-1", text: JSON.stringify({ file_path: "/skills/native-before/reference.md" }), data: { name: "Read", success: true } }],
      ["prompt", 10, { turnKey: "evidence-2", text: "wrong, try again" }],
      ["search", 11, { turnKey: "evidence-2", data: { query: "missing specialist", candidates: [], abstained: { reason: "below_threshold", hint: "Try a specific task" } } }],
      ["load", 12, { turnKey: "evidence-2", skillUri: uri("outside"), data: { uri: uri("outside") } }],
      ["prompt", 20, { turnKey: "evidence-3", textLength: 42 }],
      ["native_skill", 21, { turnKey: "evidence-3", data: { name: "later-missed" } }],
    ]);
    for (const [key, costs] of [["shared", [0.02]], ["distinct", [0.02, 0.03]], ["unknown", [0.02, null]], ["unskilled", [0.04]],
      ["repeated", [0.02, 0.02]], ["event-only", [0.02, 0.03]]]) {
      session(key, [
        ["prompt", 0, { turnKey: key }],
        ...(key === "unskilled" ? [] : [
          ["native_skill", 1, { turnKey: key, data: { name: "alpha" } }],
          ["native_skill", 2, { turnKey: key, data: { name: "beta" } }],
        ]),
        ...costs.map((cost, i) => ["llm_call", 3 + i, {
          turnKey: key, ...(key === "event-only" ? {} : { callId: key === "repeated" ? "same-call" : `call-${i}` }),
          data: { model: "fixture-model", ...(cost === null ? {} : { costUsd: cost }) },
        }]),
      ]);
    }
    const db = openDb(join(gisoolHome, "gisool.db"));
    db.prepare("INSERT INTO herdr_workspaces (id, label, created_ms) VALUES (?, ?, ?)").run("evidence-ws", "Finding and use evidence", T - 20000);
    db.prepare("INSERT INTO herdr_tabs (id, workspace_id, label, created_ms) VALUES (?, ?, ?, ?)").run("evidence-tab", "evidence-ws", "Review", T - 20000);
    db.prepare("INSERT INTO herdr_panes (id, workspace_id, tab_id, label, created_ms) VALUES (?, ?, ?, ?, ?)").run("evidence-pane", "evidence-ws", "evidence-tab", "Reused pane", T - 20000);
    const link = db.prepare("INSERT INTO pane_sessions (pane_id, agent, source, agent_session_value, session_id, first_seen_ms, last_seen_ms) VALUES (?, ?, ?, ?, ?, ?, ?)");
    link.run("evidence-pane", "claude", "herdr:reported", "evidence", ids.evidence, T, T + 21);
    // A genuinely older session, not part of step comparison.
    const ref = { runtime: "codex", runtimeSessionId: "earlier" };
    const old = store.upsertSession(ref, T - 10000);
    store.append({ id: "earlier-prompt", kind: "prompt", source: "hook", ts: T - 9000, ref, turnKey: "earlier", text: "earlier work", data: {} }, { sessionId: old, method: "runtime_id" });
    link.run("evidence-pane", "codex", "herdr:reported", "earlier", old, T - 10000, T - 9000);
    const spec = { name: "evidence-spec", steps: [
      { id: "all-skills", skills: ["native-before", "lower"], together: true, expectTools: [] },
      { id: "any-skill", skills: ["lower", "outside"], together: false, expectTools: [] },
    ] };
    const { row } = store.putWorkflowSpec(spec);
    const costFlows = {};
    for (const key of ["shared", "distinct", "unknown", "unskilled", "repeated", "event-only"]) {
      db.prepare("INSERT INTO herdr_workspaces (id, label, created_ms) VALUES (?, ?, ?)").run(`cost-${key}`, `Cost: ${key}`, T - 20000);
      db.prepare("INSERT INTO herdr_tabs (id, workspace_id, label, created_ms) VALUES (?, ?, ?, ?)").run(`tab-${key}`, `cost-${key}`, key, T - 20000);
      db.prepare("INSERT INTO herdr_panes (id, workspace_id, tab_id, label, created_ms) VALUES (?, ?, ?, ?, ?)").run(`pane-${key}`, `cost-${key}`, `tab-${key}`, key, T - 20000);
      link.run(`pane-${key}`, "claude", "herdr:reported", key, ids[key], T, T + 4);
      const costFlow = store.createFlow({ workspaceId: `cost-${key}`, tabId: `tab-${key}`, specId: row.id, label: `Cost: ${key}` }).flow;
      costFlows[key] = costFlow.id;
    }
    db.close();
    const flow = store.createFlow({ workspaceId: "evidence-ws", tabId: "evidence-tab", specId: row.id, label: "Finding and use evidence" }).flow;
    store.mapFlowStep(flow.id, "evidence-pane", "all-skills");
    for (const key of ["unresolved-one", "unresolved-two"]) store.append({
      id: key, ts: T + 25, kind: "load", source: "mcp", ref: { runtime: "claude-code" },
      skillUri: uri(key), data: { attributionCandidates: [ids.evidence] },
    }, { sessionId: "unattributed", method: "none", reason: "ambiguous" });
    clock = T + 30;
    store.endFlow(flow.id);
    return { ids, flowId: flow.id, spec, costFlows };
  } finally {
    store.close();
  }
}
