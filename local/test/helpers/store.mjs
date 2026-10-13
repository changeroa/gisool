import { distImport } from "../_helpers.mjs";

const { openDb } = await distImport("store/db.js");
const { createStore } = await distImport("store/index.js");

export const NOW = Date.UTC(2026, 9, 13, 12, 0, 0); // Tue 2026-10-13 12:00 UTC
export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;

export const uri = (name) => `skill://local/agents/${name}/SKILL.md`;

export function skillEntry(name, extra = {}) {
  return {
    uri: uri(name), rootId: "agents", dir: name, name, description: `${name} skill`, tags: [], examples: [], aliasesKo: [],
    invocation: "automatic", bodyHead: "", digest: `sha256:${name}`, manifestDigest: `sha256:manifest-${name}-0123456789`, resources: [], mtimeMs: 0, ...extra,
  };
}

export const CATALOG = ["pr-review-ko", "database-query", "release-plan", "aside-browser", "commit-helper", "debug-trace", "api-design",
  "frontend-polish", "docs-writer", "research-deep"].map((n) => skillEntry(n));

export function openStore(opts = {}) {
  const db = openDb(opts.path ?? ":memory:");
  const store = createStore(db, { now: () => NOW, ...opts.storeOpts });
  return { db, store };
}

let seq = 0;
export function event(kind, ts, ref, extra = {}) {
  seq += 1;
  return { id: `ev-${seq}-${kind}`, ts, kind, source: kind === "search" || kind === "load" ? "mcp" : "hook", ref, data: {}, ...extra };
}

function candidate(name, rank) {
  return { uri: uri(name), name, description: "", score: 10 - rank, rank, invocation: "automatic", digest: "d", matched: [] };
}

/**
 * Seeds one session. kind: loaded | exposed_only | no_match | aborted | not_used.
 * Returns the session id.
 */
export function seedSession(store, { runtime, startedAt, kind, skill, prompt, key }) {
  const ref = { runtime, runtimeSessionId: key };
  const sid = store.upsertSession(ref, startedAt);
  const attr = { sessionId: sid, method: "runtime_id" };
  const traceId = `trace-${key}`;
  store.append(event("session_start", startedAt, ref), attr);
  store.append(event("prompt", startedAt + 1000, ref, { text: prompt, textLength: prompt.length }), attr);
  if (kind === "not_used") return sid;
  const cands = kind === "loaded" || kind === "exposed_only" ? [candidate(skill, 1), candidate("docs-writer", 2)] : [];
  const data = { query: prompt, mode: "discovery", candidates: cands, elapsedMs: 3, total: cands.length };
  if (kind === "no_match") data.abstained = { reason: "no_overlap", hint: "rephrase" };
  store.append(event("search", startedAt + 2000, ref, { traceId, data }), attr);
  if (kind === "loaded") {
    const loadId = `load-${key}`;
    store.putLoad({ loadId, traceId, uri: uri(skill), manifestDigest: `sha256:manifest-${skill}-0123456789`, resources: [] });
    store.append(event("load", startedAt + 3000, ref, { traceId, loadId, skillUri: uri(skill), data: { manifestDigest: `sha256:manifest-${skill}-0123456789` } }), attr);
  }
  if (kind === "aborted") store.append(event("error", startedAt + 4000, ref, { data: { code: "tool_failed", message: "boom" } }), attr);
  return sid;
}

const LOADED = [
  ...Array(5).fill("pr-review-ko"), ...Array(4).fill("database-query"), ...Array(3).fill("release-plan"), ...Array(3).fill("aside-browser"),
  ...Array(2).fill("commit-helper"), ...Array(2).fill("debug-trace"), ...Array(2).fill("api-design"), "frontend-polish", "docs-writer", "research-deep",
];
const EXPOSED = ["pr-review-ko", "pr-review-ko", "pr-review-ko", "database-query", "database-query", "release-plan"];
const PLAN = [
  ...LOADED.map((skill) => ({ kind: "loaded", skill })),
  ...EXPOSED.map((skill) => ({ kind: "exposed_only", skill })),
  ...Array(5).fill({ kind: "no_match" }),
  ...Array(2).fill({ kind: "aborted" }),
  ...Array(3).fill({ kind: "not_used" }),
];
export const EXPECTED_STATES = { loaded: 24, exposed_only: 6, no_match: 5, aborted: 2, not_used: 3 };
export const RUNTIMES = ["claude-code", "codex", "omo"];

/** 40 sessions across 3 runtimes, spread every 29 h back from NOW, plus one unattributed MCP event. */
export function seedForty(store) {
  store.upsertSkills(CATALOG);
  const ids = PLAN.map((p, i) => seedSession(store, {
    runtime: RUNTIMES[i % 3], startedAt: NOW - i * 29 * HOUR, kind: p.kind, skill: p.skill, key: `s${i}`,
    prompt: p.skill ? `please help with ${p.skill}` : "커밋 메시지 정리해줘",
  }));
  store.append(event("read_file", NOW - HOUR, { runtime: "codex" }, { source: "mcp", data: { uri: "x", bytes: 1 } }), { sessionId: "unattributed", method: "none", reason: "no_session" });
  return ids;
}
