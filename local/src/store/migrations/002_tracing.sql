-- gisool store migration 2: tracing keys on events, herdr topology and workflow specs (user_version 1 -> 2).
-- db.ts runs this inside a transaction and sets user_version afterwards, so this file sets no PRAGMA.

ALTER TABLE events ADD COLUMN source_key TEXT;
ALTER TABLE events ADD COLUMN turn_key TEXT;
ALTER TABLE events ADD COLUMN call_id TEXT;
ALTER TABLE events ADD COLUMN span_id TEXT;

-- source_key identifies the agent record an event was derived from, so replaying a batch stores nothing new.
CREATE UNIQUE INDEX IF NOT EXISTS events_source_key ON events(source_key) WHERE source_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS events_turn ON events(session_id, turn_key);
CREATE INDEX IF NOT EXISTS events_call ON events(call_id) WHERE call_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS otel_spans (
  trace_id TEXT NOT NULL,
  span_id TEXT NOT NULL,
  parent_span_id TEXT,
  name TEXT NOT NULL,
  runtime TEXT NOT NULL,
  conversation_id TEXT,
  turn_key TEXT,
  call_id TEXT,
  start_ms INTEGER,
  end_ms INTEGER,
  received_at INTEGER NOT NULL,
  PRIMARY KEY (trace_id, span_id)
);
CREATE INDEX IF NOT EXISTS otel_spans_call ON otel_spans(call_id);
CREATE INDEX IF NOT EXISTS otel_spans_turn ON otel_spans(turn_key);

CREATE TABLE IF NOT EXISTS herdr_workspaces (
  id TEXT PRIMARY KEY,
  label TEXT,
  created_ms INTEGER,
  closed_ms INTEGER
);

CREATE TABLE IF NOT EXISTS herdr_tabs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT,
  label TEXT,
  created_ms INTEGER,
  closed_ms INTEGER
);

CREATE TABLE IF NOT EXISTS herdr_panes (
  id TEXT PRIMARY KEY,
  workspace_id TEXT,
  tab_id TEXT,
  label TEXT,
  cwd TEXT,
  created_ms INTEGER,
  closed_ms INTEGER
);

-- session_id stays NULL until a gisool session matches the reported agent session value.
CREATE TABLE IF NOT EXISTS pane_sessions (
  pane_id TEXT NOT NULL,
  agent TEXT,
  source TEXT,
  agent_session_value TEXT NOT NULL,
  session_id TEXT REFERENCES sessions(id),
  first_seen_ms INTEGER,
  last_seen_ms INTEGER,
  PRIMARY KEY (pane_id, agent_session_value)
);

CREATE TABLE IF NOT EXISTS workflow_specs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  version INTEGER NOT NULL,
  body_json TEXT NOT NULL,
  digest TEXT NOT NULL,
  created_ms INTEGER NOT NULL,
  UNIQUE (name, version)
);

CREATE TABLE IF NOT EXISTS flows (
  id TEXT PRIMARY KEY,
  workspace_id TEXT,
  tab_id TEXT,
  spec_id TEXT REFERENCES workflow_specs(id),
  label TEXT,
  registered_ms INTEGER,
  ended_ms INTEGER
);

CREATE TABLE IF NOT EXISTS flow_steps (
  flow_id TEXT NOT NULL REFERENCES flows(id),
  pane_id TEXT NOT NULL,
  step_id TEXT NOT NULL,
  registered_ms INTEGER,
  PRIMARY KEY (flow_id, pane_id)
);
