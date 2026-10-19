-- Candidate membership is an index over portable events.data_json, not new captured text.
-- Backfill the one proven match on stores that resolved loads before this migration.
UPDATE events SET data_json = json_set(data_json, '$.attributionMatches', json_array(session_id))
WHERE source = 'mcp' AND kind = 'load' AND attribution_method = 'trace_handle'
  AND json_extract(data_json, '$.attributionBasis') = 'tool_call_uri'
  AND json_type(data_json, '$.attributionMatches') IS NULL;

CREATE INDEX events_pending_load_ts ON events(ts)
WHERE source = 'mcp' AND kind = 'load' AND session_id = 'unattributed' AND attribution_reason = 'ambiguous';
CREATE INDEX events_reconcile_load_uri ON events(runtime, skill_uri, ts)
WHERE source = 'mcp' AND kind = 'load';
CREATE INDEX events_uri_tools ON events(runtime, session_id, ts)
WHERE source = 'otel' AND kind = 'tool_call' AND session_id != 'unattributed'
  AND json_extract(data_json, '$.success') IS NOT 0;
CREATE INDEX sessions_runtime_started ON sessions(runtime, started_at);

CREATE TABLE load_candidates (
  load_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  PRIMARY KEY (load_id, session_id)
) WITHOUT ROWID;
CREATE INDEX load_candidates_session_ts ON load_candidates(session_id, ts, load_id);

-- Old history imports may have no candidate snapshot. Reconstruct at the event's timestamp,
-- exactly once on insert, not on every report. Both branches use session/time indexes.
CREATE VIEW load_candidate_rows AS
SELECT e.id AS load_id, j.value AS session_id, e.ts
FROM events e, json_each(COALESCE(json_extract(e.data_json, '$.attributionCandidates'),
  (SELECT json_group_array(s.id) FROM sessions s
   WHERE s.runtime = e.runtime AND s.started_at <= e.ts AND (s.ended_at IS NULL OR s.ended_at >= e.ts)
     AND MAX(s.started_at, COALESCE((SELECT MAX(a.ts) FROM events a
       WHERE a.session_id = s.id AND a.ts <= e.ts), s.started_at)) >= e.ts - 120000))) j
WHERE e.source = 'mcp' AND e.kind = 'load' AND j.type = 'text'
  AND ((e.session_id = 'unattributed' AND e.attribution_reason = 'ambiguous')
    OR (e.attribution_method = 'trace_handle' AND json_extract(e.data_json, '$.attributionBasis') = 'tool_call_uri'));

INSERT INTO load_candidates SELECT * FROM load_candidate_rows;
CREATE TRIGGER events_load_candidates_insert AFTER INSERT ON events
WHEN NEW.source = 'mcp' AND NEW.kind = 'load'
BEGIN
  INSERT INTO load_candidates SELECT * FROM load_candidate_rows WHERE load_id = NEW.id;
END;
CREATE TRIGGER events_load_candidates_update AFTER UPDATE OF data_json ON events
WHEN NEW.source = 'mcp' AND NEW.kind = 'load'
  AND json_extract(NEW.data_json, '$.attributionCandidates') IS NOT json_extract(OLD.data_json, '$.attributionCandidates')
BEGIN
  DELETE FROM load_candidates WHERE load_id = NEW.id;
  INSERT INTO load_candidates SELECT * FROM load_candidate_rows WHERE load_id = NEW.id;
END;
