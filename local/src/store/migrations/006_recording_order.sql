-- A recording domain names a database lineage, not an ordering of UUIDs.
-- Keep its high-water mark independently of retained observations and rowids.
CREATE TABLE recording_clock (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  domain TEXT NOT NULL,
  position INTEGER NOT NULL CHECK (position BETWEEN 0 AND 9007199254740991)
);
INSERT INTO recording_clock VALUES (1, lower(hex(randomblob(16))), 0);
-- Outer INSERT OR IGNORE must not suppress exhaustion and reuse the last mark.
CREATE TRIGGER recording_clock_range BEFORE UPDATE OF position ON recording_clock
WHEN typeof(NEW.position) <> 'integer' OR NEW.position < OLD.position OR NEW.position > 9007199254740991
BEGIN
  SELECT RAISE(ABORT, 'recording clock exhausted or moved backwards');
END;

ALTER TABLE events ADD COLUMN recording_orders_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE otel_spans ADD COLUMN recording_orders_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE sessions ADD COLUMN end_orders_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE flows ADD COLUMN start_order_domain TEXT;
ALTER TABLE flows ADD COLUMN start_order INTEGER;
ALTER TABLE flows ADD COLUMN end_order_domain TEXT;
ALTER TABLE flows ADD COLUMN end_order INTEGER;

-- Old rows precede future cuts in this new domain. This does NOT reconstruct old
-- flow cuts or order the old rows against each other.
UPDATE events SET recording_orders_json = (SELECT json_object(domain, 0) FROM recording_clock);
UPDATE otel_spans SET recording_orders_json = (SELECT json_object(domain, 0) FROM recording_clock);
UPDATE sessions SET end_orders_json = (SELECT json_object(domain, 0) FROM recording_clock) WHERE ended_at IS NOT NULL;

-- Source-domain marks survive import; add local arrival order without replacing
-- a known mark when restoring history from this same lineage. Advance past it.
CREATE TRIGGER events_recording_insert AFTER INSERT ON events BEGIN
  UPDATE recording_clock SET position = MAX(position + 1,
    COALESCE(json_extract(NEW.recording_orders_json, '$."' || domain || '"'), 0));
  UPDATE events SET recording_orders_json = (SELECT
    json_insert(NEW.recording_orders_json, '$."' || domain || '"', position) FROM recording_clock)
    WHERE id = NEW.id;
END;

CREATE TRIGGER spans_recording_insert AFTER INSERT ON otel_spans BEGIN
  UPDATE recording_clock SET position = MAX(position + 1,
    COALESCE(json_extract(NEW.recording_orders_json, '$."' || domain || '"'), 0));
  UPDATE otel_spans SET recording_orders_json = (SELECT
    json_insert(NEW.recording_orders_json, '$."' || domain || '"', position) FROM recording_clock)
    WHERE trace_id = NEW.trace_id AND span_id = NEW.span_id;
END;

-- putSpans ignores replays. If stored facts are corrected, their previous order
-- cannot certify the corrected facts at a boundary that has already closed.
CREATE TRIGGER spans_recording_update AFTER UPDATE OF
  parent_span_id, name, runtime, conversation_id, turn_key, call_id, start_ms, end_ms ON otel_spans
WHEN OLD.parent_span_id IS NOT NEW.parent_span_id OR OLD.name IS NOT NEW.name
  OR OLD.runtime IS NOT NEW.runtime OR OLD.conversation_id IS NOT NEW.conversation_id
  OR OLD.turn_key IS NOT NEW.turn_key OR OLD.call_id IS NOT NEW.call_id
  OR OLD.start_ms IS NOT NEW.start_ms OR OLD.end_ms IS NOT NEW.end_ms
BEGIN
  UPDATE recording_clock SET position = position + 1;
  UPDATE otel_spans SET recording_orders_json = (SELECT json_object(domain, position) FROM recording_clock)
    WHERE trace_id = NEW.trace_id AND span_id = NEW.span_id;
END;

CREATE TRIGGER sessions_end_insert AFTER INSERT ON sessions WHEN NEW.ended_at IS NOT NULL BEGIN
  UPDATE recording_clock SET position = MAX(position + 1,
    COALESCE(json_extract(NEW.end_orders_json, '$."' || domain || '"'), 0));
  UPDATE sessions SET end_orders_json = (SELECT
    json_insert(NEW.end_orders_json, '$."' || domain || '"', position) FROM recording_clock)
    WHERE id = NEW.id;
END;
CREATE TRIGGER sessions_end_update AFTER UPDATE OF ended_at ON sessions WHEN OLD.ended_at IS NOT NEW.ended_at BEGIN
  UPDATE recording_clock SET position = position + 1;
  UPDATE sessions SET end_orders_json = (SELECT json_object(domain, position) FROM recording_clock) WHERE id = NEW.id;
END;
