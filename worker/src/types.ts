// 共通型（spec §5, §24）

export interface Env {
  DB: D1Database;
  RL: KVNamespace;
  EXPORTS?: R2Bucket; // §20 月次 export 先（未設定なら export 無効）
  // vars
  APP_CONFIG: string; // JSON: Record<app_id, AppConfig>
  // secrets
  METRICS_TOKENS?: string; // JSON: Record<app_id, token> (§9.4)
  NOTIFY_WEBHOOK_URL?: string; // Slack/Discord webhook (§13.4)
  IP_HASH_SECRET?: string; // §14.3
}

export interface AppLimits {
  events_per_minute: number;
  events_per_day: number;
  raw_events_rows: number;
  warn_threshold_ratio: number;
}

export interface AppConfig {
  allowed_origins: string[];
  require_origin: boolean;
  limits: AppLimits;
  retention: {
    raw_events_days: number;
    error_events_days: number;
    session_summaries_days: number;
  };
  notification: {
    enabled: boolean;
    dedupe_minutes: number;
    capacity_dedupe_minutes: number;
  };
}

// クライアントから受け取る生イベント（§5.1）
export interface IncomingEvent {
  app_id: string;
  event_name: string;
  occurred_at: string;
  session_id: string;
  page_path?: string;
  widget_id?: string;
  flow_version?: string;
  properties?: Record<string, unknown>;
}

// 正規化後にDB列へ落とし込んだイベント（§8.1）
export interface NormalizedEvent {
  occurred_at: string;
  app_id: string;
  session_id: string;
  event_name: string;
  page_path: string;
  widget_id: string;
  flow_version: string;
  step: number | null;
  target_id: string | null;
  choice_id: string | null;
  result_id: string | null;
  elapsed_ms: number | null;
  properties_json: string;
  // error 用
  message?: string;
  stack?: string | null;
  fingerprint?: string;
  source?: string | null;
}
