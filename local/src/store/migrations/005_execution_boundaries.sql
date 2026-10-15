-- Identity snapshots, not SQLite rowids: history import and VACUUM may reorder rows.
-- NULL means this boundary predates recording; never reconstruct a historical cut.
ALTER TABLE flows ADD COLUMN start_event_ids_json TEXT;
ALTER TABLE flows ADD COLUMN end_event_ids_json TEXT;
ALTER TABLE flows ADD COLUMN end_sessions_json TEXT;
ALTER TABLE flows ADD COLUMN end_spans_json TEXT;
