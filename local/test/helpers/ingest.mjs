import { readFileSync } from "node:fs";

export function fixture(name) {
  return JSON.parse(readFileSync(new URL(`../fixtures/ingest/${name}`, import.meta.url), "utf8"));
}

/** In-memory implementation of the Store methods the ingest pipeline uses (the SQLite Store belongs to todo 5). */
export function memoryStore() {
  const sessions = new Map();
  const events = [];
  const counts = { accepted: 0, rejected: 0, dropped: 0, codes: [] };
  let seq = 0;
  const keyOf = (ref) => `${ref.runtime}|${ref.runtimeSessionId ?? ref.conversationId}`;
  const byId = (id) => [...sessions.values()].find((s) => s.id === id);
  const touch = (id, ts) => {
    const s = byId(id);
    if (s) s.lastActivityAt = Math.max(s.lastActivityAt, ts);
  };
  return {
    sessions,
    events,
    counts,
    addSession(ref, lastActivityAt) {
      const id = `sess-${++seq}`;
      sessions.set(keyOf(ref), { id, ref, startedAt: lastActivityAt, lastActivityAt });
      return id;
    },
    upsertSession(ref, startedAt) {
      const key = keyOf(ref);
      const existing = sessions.get(key);
      if (existing) {
        existing.lastActivityAt = Math.max(existing.lastActivityAt, startedAt);
        return existing.id;
      }
      const id = `sess-${++seq}`;
      sessions.set(key, { id, ref, startedAt, lastActivityAt: startedAt });
      return id;
    },
    openSessions(runtime, since) {
      return [...sessions.values()].filter((s) => s.ref.runtime === runtime && s.endedAt === undefined && s.lastActivityAt >= since)
        .map(({ id, startedAt, lastActivityAt, ref }) => ({ id, startedAt, lastActivityAt, ref }));
    },
    append(event, attribution) {
      const duplicate = events.some((e) => e.event.id === event.id || (event.sourceKey !== undefined && e.event.sourceKey === event.sourceKey));
      if (duplicate) return false;
      events.push({ event, attribution: { ...attribution } });
      if (attribution.sessionId !== "unattributed") {
        touch(attribution.sessionId, event.ts);
        if (event.kind === "session_end") byId(attribution.sessionId).endedAt = event.ts;
      }
      return true;
    },
    reattribute(eventId, sessionId, method) {
      const row = events.find((e) => e.event.id === eventId);
      if (row) row.attribution = { sessionId, method };
    },
    findEventByToolUseId(toolUseId) {
      return events.findLast((e) => e.event.toolUseId === toolUseId)?.event.id;
    },
    traceSession(traceId) {
      return events.find((e) => e.event.kind === "search" && e.event.traceId === traceId)?.attribution.sessionId;
    },
    countIngest(kind, code) {
      counts[kind] += 1;
      if (code) counts.codes.push(code);
    },
  };
}
