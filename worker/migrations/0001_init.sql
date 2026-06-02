-- frontping initial schema (spec §8)

-- 8.1 raw_events : 短期保存する生イベント
CREATE TABLE raw_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,

  occurred_at TEXT NOT NULL,
  received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

  app_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  event_name TEXT NOT NULL,

  page_path TEXT NOT NULL DEFAULT '',
  widget_id TEXT NOT NULL DEFAULT '',
  flow_version TEXT NOT NULL DEFAULT '',

  step INTEGER,
  target_id TEXT,
  choice_id TEXT,
  result_id TEXT,

  elapsed_ms INTEGER,
  properties_json TEXT NOT NULL DEFAULT '{}',

  user_agent TEXT,
  ip_hash TEXT
);

CREATE INDEX idx_raw_events_time ON raw_events(occurred_at);
CREATE INDEX idx_raw_events_app_event_time ON raw_events(app_id, event_name, occurred_at);
CREATE INDEX idx_raw_events_session ON raw_events(session_id, occurred_at);
CREATE INDEX idx_raw_events_widget_flow ON raw_events(app_id, widget_id, flow_version, occurred_at);

-- 8.2 session_summaries : セッション単位の要約
CREATE TABLE session_summaries (
  session_id TEXT PRIMARY KEY,

  app_id TEXT NOT NULL,
  widget_id TEXT NOT NULL DEFAULT '',
  flow_version TEXT NOT NULL DEFAULT '',

  page_path TEXT NOT NULL DEFAULT '',

  started_at TEXT NOT NULL,
  ended_at TEXT,
  duration_ms INTEGER,

  opened INTEGER NOT NULL DEFAULT 0,
  started INTEGER NOT NULL DEFAULT 0,
  completed INTEGER NOT NULL DEFAULT 0,
  accepted INTEGER NOT NULL DEFAULT 0,
  rejected INTEGER NOT NULL DEFAULT 0,
  restarted INTEGER NOT NULL DEFAULT 0,
  errored INTEGER NOT NULL DEFAULT 0,

  max_step INTEGER NOT NULL DEFAULT 0,
  step_count INTEGER NOT NULL DEFAULT 0,

  result_id TEXT,
  choices_json TEXT NOT NULL DEFAULT '[]',

  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_session_summaries_app_started ON session_summaries(app_id, started_at);
CREATE INDEX idx_session_summaries_widget_flow ON session_summaries(app_id, widget_id, flow_version, started_at);
CREATE INDEX idx_session_summaries_result ON session_summaries(app_id, result_id);

-- 8.3 daily_event_counts : 日次イベント集計（長期保存）
CREATE TABLE daily_event_counts (
  day TEXT NOT NULL,

  app_id TEXT NOT NULL,
  event_name TEXT NOT NULL,

  page_path TEXT NOT NULL DEFAULT '',
  widget_id TEXT NOT NULL DEFAULT '',
  flow_version TEXT NOT NULL DEFAULT '',

  step INTEGER NOT NULL DEFAULT 0,
  target_id TEXT NOT NULL DEFAULT '',
  choice_id TEXT NOT NULL DEFAULT '',
  result_id TEXT NOT NULL DEFAULT '',

  count INTEGER NOT NULL DEFAULT 0,

  PRIMARY KEY (
    day, app_id, event_name, page_path, widget_id, flow_version,
    step, target_id, choice_id, result_id
  )
);

-- 8.4 daily_session_metrics : 日次セッション集計（長期保存）
CREATE TABLE daily_session_metrics (
  day TEXT NOT NULL,

  app_id TEXT NOT NULL,
  widget_id TEXT NOT NULL DEFAULT '',
  flow_version TEXT NOT NULL DEFAULT '',

  sessions INTEGER NOT NULL DEFAULT 0,
  opened_sessions INTEGER NOT NULL DEFAULT 0,
  started_sessions INTEGER NOT NULL DEFAULT 0,
  completed_sessions INTEGER NOT NULL DEFAULT 0,
  accepted_sessions INTEGER NOT NULL DEFAULT 0,
  rejected_sessions INTEGER NOT NULL DEFAULT 0,
  restarted_sessions INTEGER NOT NULL DEFAULT 0,
  errored_sessions INTEGER NOT NULL DEFAULT 0,

  total_duration_ms INTEGER NOT NULL DEFAULT 0,
  total_max_step INTEGER NOT NULL DEFAULT 0,

  PRIMARY KEY (day, app_id, widget_id, flow_version)
);

-- 8.5 error_events : エラー詳細
CREATE TABLE error_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,

  occurred_at TEXT NOT NULL,
  received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

  app_id TEXT NOT NULL,
  session_id TEXT,

  page_path TEXT NOT NULL DEFAULT '',
  widget_id TEXT NOT NULL DEFAULT '',
  flow_version TEXT NOT NULL DEFAULT '',

  message TEXT NOT NULL,
  stack TEXT,
  fingerprint TEXT,
  source TEXT,

  user_agent TEXT,
  ip_hash TEXT,

  properties_json TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX idx_error_events_time ON error_events(occurred_at);
CREATE INDEX idx_error_events_app_time ON error_events(app_id, occurred_at);
CREATE INDEX idx_error_events_fingerprint ON error_events(app_id, fingerprint, occurred_at);

-- 8.6 notification_dedupes : 通知連打抑制（capacity アラートは fingerprint='capacity:<種別>'）
CREATE TABLE notification_dedupes (
  app_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  last_notified_at TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 1,

  PRIMARY KEY (app_id, fingerprint)
);
