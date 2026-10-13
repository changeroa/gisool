-- gisool store schema, user_version 1
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS skills (
  uri TEXT PRIMARY KEY,
  root_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  tags_json TEXT NOT NULL DEFAULT '[]',
  when_to_use TEXT,
  examples_json TEXT NOT NULL DEFAULT '[]',
  aliases_ko_json TEXT NOT NULL DEFAULT '[]',
  group_id TEXT,
  group_stage TEXT,
  invocation TEXT NOT NULL DEFAULT 'automatic',
  body_head TEXT NOT NULL DEFAULT '',
  digest TEXT NOT NULL,
  manifest_digest TEXT NOT NULL,
  resources_json TEXT NOT NULL DEFAULT '[]',
  mtime_ms INTEGER NOT NULL DEFAULT 0,
  removed_at INTEGER
);

-- uri is stored UNINDEXED so rows join back to skills(uri).
CREATE VIRTUAL TABLE IF NOT EXISTS skills_fts USING fts5(
  uri UNINDEXED,
  name,
  description,
  when_to_use,
  examples,
  aliases_ko,
  body_head,
  tokenize = 'trigram'
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  runtime TEXT NOT NULL,
  runtime_session_id TEXT,
  conversation_id TEXT,
  client_name TEXT,
  cwd TEXT,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  first_prompt TEXT
);
CREATE INDEX IF NOT EXISTS sessions_runtime_session ON sessions(runtime, runtime_session_id);
CREATE INDEX IF NOT EXISTS sessions_runtime_conversation ON sessions(runtime, conversation_id);
CREATE INDEX IF NOT EXISTS sessions_started ON sessions(started_at);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  ts INTEGER NOT NULL,
  kind TEXT NOT NULL,
  source TEXT NOT NULL,
  session_id TEXT NOT NULL,
  attribution_method TEXT NOT NULL,
  attribution_reason TEXT,
  runtime TEXT NOT NULL,
  trace_id TEXT,
  load_id TEXT,
  skill_uri TEXT,
  tool_use_id TEXT,
  text TEXT,
  text_digest TEXT,
  text_length INTEGER,
  data_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS events_session_ts ON events(session_id, ts);
CREATE INDEX IF NOT EXISTS events_ts ON events(ts);
CREATE INDEX IF NOT EXISTS events_trace ON events(trace_id);
CREATE INDEX IF NOT EXISTS events_skill ON events(skill_uri);
CREATE INDEX IF NOT EXISTS events_tool_use ON events(tool_use_id);

CREATE TABLE IF NOT EXISTS loads (
  load_id TEXT PRIMARY KEY,
  trace_id TEXT,
  uri TEXT NOT NULL,
  manifest_digest TEXT NOT NULL,
  resources_json TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS loads_uri_created ON loads(uri, created_at);

CREATE TABLE IF NOT EXISTS eval_cases (
  id TEXT PRIMARY KEY,
  query TEXT NOT NULL,
  expected_uri TEXT,
  from_trace_id TEXT,
  created_at INTEGER NOT NULL
);

PRAGMA user_version = 1;
