-- Bounded pane lifetime searches and session-local span lookups.
ALTER TABLE herdr_panes ADD COLUMN agent TEXT;
ALTER TABLE herdr_panes ADD COLUMN last_seen_ms INTEGER;
UPDATE herdr_panes SET last_seen_ms = COALESCE(closed_ms, created_ms);
CREATE INDEX pane_sessions_session ON pane_sessions(session_id);
CREATE INDEX pane_sessions_pending ON pane_sessions(session_id) WHERE session_id IS NULL;
CREATE INDEX herdr_panes_cwd ON herdr_panes(cwd, created_ms);
CREATE INDEX herdr_panes_closed ON herdr_panes(closed_ms);
CREATE INDEX herdr_panes_seen ON herdr_panes(last_seen_ms);
CREATE INDEX sessions_cwd_started ON sessions(cwd, started_at);
CREATE INDEX otel_spans_conversation ON otel_spans(conversation_id);
