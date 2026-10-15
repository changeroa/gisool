import type { AssignedTreeEvent, ExecutionEventScope, FlowTree, SessionTree, SkillSpan, Store, TreeEvent, TreeSessionData, TurnBasis, TurnTree } from "../types.js";
import { scopeSession } from "../store/execution.js";

const PROMPT_JOIN_WINDOW_MS = 5_000;

/** Pure assembly: prompt pairs precede keyless timestamp membership; row order breaks equal-time event ties.
 * A boundary at the same timestamp wins over the preceding turn, independent of ingest order.
 */
export function assembleSession(data: TreeSessionData): SessionTree {
  // These are local accumulators, never cached or written back to the store.
  const boundaries = new Map<string, { id: string; startedAt: number; basis: TurnBasis }>();
  const add = (id: string, startedAt: number, basis: TurnBasis) => {
    const old = boundaries.get(id);
    if (!old || startedAt < old.startedAt) boundaries.set(id, { id, startedAt, basis });
  };
  if (data.runtime === "codex") {
    for (const span of data.spans) {
      if (span.name === "codex.turn_input" && span.turnKey !== undefined && span.startMs !== undefined) {
        add(span.turnKey, span.startMs, "reported");
      }
    }
  }
  const prompts = data.events.filter((e) => e.kind === "prompt");
  // Collect every reported boundary before considering fallbacks, including telemetry received after a hook.
  for (const prompt of prompts) {
    if (prompt.turnKey !== null && !boundaries.has(prompt.turnKey)) add(prompt.turnKey, prompt.ts, "reported");
  }
  const reportedBoundaries = [...boundaries.values()].sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id));
  const pairedPrompts = new Map<string, string>();
  if (data.runtime === "claude-code" || data.runtime === "codex") {
    for (const boundary of reportedBoundaries) {
      const reference = prompts.find((p) => p.turnKey === boundary.id);
      const strength = (prompt: TreeEvent): number => {
        if (!reference) return 0; // Codex turn_input spans carry identity and time, not prompt content.
        if (reference.text !== null && prompt.text !== null && reference.text !== prompt.text) return -1;
        const length = reference.textLength ?? reference.data.promptLength;
        const observedLength = prompt.textLength ?? prompt.data.promptLength;
        if (typeof length === "number" && typeof observedLength === "number" && length !== observedLength) return -1;
        if (reference.text !== null && prompt.text !== null) return 2;
        return typeof length === "number" && length === observedLength ? 1 : 0;
      };
      // Each boundary consumes one observation, and each observation can be consumed only once.
      // Exclude contradictory capture; prefer captured identity, then nearest time, with earlier ties.
      const match = prompts.filter((p) => p.turnKey === null && !pairedPrompts.has(p.id) &&
        Math.abs(boundary.startedAt - p.ts) <= PROMPT_JOIN_WINDOW_MS && strength(p) >= 0)
        .sort((a, b) => strength(b) - strength(a) ||
          Math.abs(boundary.startedAt - a.ts) - Math.abs(boundary.startedAt - b.ts) ||
          a.ts - b.ts || a.id.localeCompare(b.id))[0];
      if (match) pairedPrompts.set(match.id, boundary.id);
    }
  }
  for (const prompt of prompts) {
    if (prompt.turnKey === null && !pairedPrompts.has(prompt.id)) {
      add(`prompt:${prompt.id}`, prompt.ts, "inferred_time");
    }
  }
  const ordered = [...boundaries.values()].sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id));
  const newestFirst = [...ordered].reverse();
  const byTurn = new Map<string, { event: TreeEvent; basis: TurnBasis }[]>();
  const unassignedEvents: TreeEvent[] = [];
  for (const event of data.events) {
    let key = event.turnKey ?? pairedPrompts.get(event.id) ?? null;
    let basis: TurnBasis = "reported";
    if (key === null && event.kind === "tool_call") {
      const joined = data.spans.filter((s) => s.turnKey !== undefined &&
        ((event.callId !== null && s.callId === event.callId) ||
          (event.spanId !== null && s.spanId === event.spanId && s.traceId === event.data.otelTraceId)));
      const keys = new Set(joined.map((s) => s.turnKey));
      if (keys.size === 1) key = joined[0]?.turnKey ?? null;
      basis = "span_join";
    }
    if (key === null) {
      key = newestFirst.find((b) => b.startedAt <= event.ts)?.id ?? null;
      basis = "inferred_time";
    }
    // A reported key without a known boundary is not silently relabelled as a different turn.
    if (key === null || !boundaries.has(key)) {
      unassignedEvents.push(event);
      continue;
    }
    const list = byTurn.get(key) ?? [];
    list.push({ event, basis });
    byTurn.set(key, list);
  }
  const lastTs = data.events.at(-1)?.ts ?? data.startedAt;
  const turns: TurnTree[] = ordered.map((boundary, i) => {
    const endedAt = ordered[i + 1]?.startedAt ?? data.endedAt ?? lastTs;
    const events: AssignedTreeEvent[] = [];
    const active = new Map<string, { id: string; skill: string; uri: string | null; name: string; startedAt: number;
      endedAt: number; activation: AssignedTreeEvent; events: AssignedTreeEvent[] }>();
    for (const { event, basis } of byTurn.get(boundary.id) ?? []) {
      const name = typeof event.data.name === "string" ? event.data.name : "";
      const uri = event.skillUri ?? (typeof event.data.uri === "string" ? event.data.uri : null);
      if (event.kind === "load" || event.kind === "native_skill") {
        const skillName = name || uri?.split("/").at(-2) || "unknown";
        const skill = uri ?? skillName;
        // Native and MCP observations of the same named skill are one activation, not two co-active skills.
        const existing = [...active.values()].find((s) => s.skill === skill || (s.name === skillName && (s.uri === null || uri === null)));
        if (!existing) {
          const activation: AssignedTreeEvent = { ...event, basis, attribution: "no_skill", skills: [] };
          active.set(skill, { id: event.id, skill, uri, name: skillName, startedAt: event.ts, endedAt, activation, events: [] });
        } else if (existing.uri === null && uri !== null) {
          existing.uri = uri;
        }
      }
      const reported = event.kind === "llm_call" && typeof event.data.skillName === "string" ? event.data.skillName : null;
      const action = event.kind === "tool_call" || event.kind === "llm_call";
      const skills = reported !== null ? [reported] : action ? [...active.keys()] : [];
      const assigned: AssignedTreeEvent = { ...event, basis, skills,
        attribution: reported !== null ? "reported" : skills.length > 1 ? "co_active" : skills.length === 1 ? "single" : "no_skill" };
      events.push(assigned);
      if (action) {
        for (const span of active.values()) {
          if (reported === null || span.name === reported || span.skill === reported) span.events.push(assigned);
        }
      }
    }
    const skillSpans: SkillSpan[] = [...active.values()];
    return { ...boundary, endedAt, events, skillSpans };
  });
  return { id: data.id, runtime: data.runtime, startedAt: data.startedAt, endedAt: data.endedAt, turns, unassignedEvents };
}

export function sessionTree(store: Pick<Store, "treeSessionData">, sessionId: string): SessionTree | undefined {
  const data = store.treeSessionData(sessionId);
  return data ? assembleSession(data) : undefined;
}

export function flowTree(store: Pick<Store, "treeSessionData" | "treeFlowData" | "flowEventScope">, flowOrWorkspaceId: string,
  scope: ExecutionEventScope | undefined = store.flowEventScope(flowOrWorkspaceId)): FlowTree | undefined {
  const data = store.treeFlowData(flowOrWorkspaceId, scope);
  if (!data) return undefined;
  const sessions = new Map<string, SessionTree | null>();
  for (const link of data.links) {
    if (link.sessionId !== null && !sessions.has(link.sessionId)) {
      const input = store.treeSessionData(link.sessionId, scope);
      const session = input ? assembleSession(input) : null;
      sessions.set(link.sessionId, session && scope ? scopeSession(session, scope) : session);
    }
  }
  return { id: data.id, workspaceId: data.workspaceId, label: data.label, registered: data.registered,
    tabs: data.tabs.map((tab) => ({ ...tab, panes: data.panes.filter((p) => p.tabId === tab.id).map((pane) => ({
      ...pane, sessions: data.links.filter((l) => l.paneId === pane.id).map((link) => ({ ...link,
        basis: link.source === "inferred:cwd_time" ? "inferred" : "reported",
        session: link.sessionId === null ? null : sessions.get(link.sessionId) ?? null })),
    })) })) };
}

export function outsideHerdr(store: Pick<Store, "treeSessionData" | "outsideHerdrSessionIds">,
  opts: { from: number; to: number; limit: number }): { readonly id: "outside-herdr"; readonly sessions: readonly SessionTree[] } {
  return { id: "outside-herdr", sessions: store.outsideHerdrSessionIds(opts).flatMap((id) => {
    const session = sessionTree(store, id);
    return session ? [session] : [];
  }) };
}
