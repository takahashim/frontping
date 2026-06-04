-- §9.4 metrics/admin 用の per-app トークン。
-- 平文は保存せず sha256 ハッシュで保持（API キーの定石）。発行/失効は app 単位で独立。
CREATE TABLE metrics_tokens (
  token_hash TEXT PRIMARY KEY,   -- sha256(token) の16進
  app_id TEXT NOT NULL,
  label TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_metrics_tokens_app ON metrics_tokens(app_id);
