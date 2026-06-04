// frontping SDK の公開型（spec §17）

export interface AnalyticsConfig {
  /** 収集 Worker のベース URL（末尾スラッシュ無し）。例: https://collect.example.com */
  endpoint: string;
  /** アプリ識別子（§5.1） */
  appId: string;
  /** 既定の widget_id（イベントごとに上書き可能） */
  widgetId?: string;
  /** 既定の flow_version */
  flowVersion?: string;
  /** バッチ最大件数（§17.5 既定 20） */
  maxBatch?: number;
  /** flush 間隔 ms（§17.5 既定 5000） */
  flushIntervalMs?: number;
  /** 離脱時に sendBeacon を使う（§17.4 既定 true） */
  useBeacon?: boolean;
  /** デバッグログ */
  debug?: boolean;
  /** 送信層の差し替え（テスト・非ブラウザ環境向け。未指定なら DOM 実装） */
  transport?: Transport;
}

/** POST の結果。null はネットワーク失敗（握りつぶす）。 */
export interface PostResult {
  status: number;
  retryAfterSec: number | null;
}

/** 送信層の抽象。fetch / sendBeacon などの環境依存をここに閉じ込める。 */
export interface Transport {
  /** 通常送信。失敗時は null。 */
  post(url: string, body: string): Promise<PostResult | null>;
  /** 離脱時送信（§17.4）。送信キューに入れられたら true。 */
  beacon(url: string, body: string): boolean;
}

/** Worker が受け取るペイロード形（§5.1）。SDK 内部で組み立てる。 */
export interface EventPayload {
  app_id: string;
  event_name: string;
  session_id: string;
  occurred_at: string;
  page_path?: string;
  widget_id?: string;
  flow_version?: string;
  properties?: Record<string, unknown>;
}

/** イベント名 → そのイベントの properties 形（spec §7 の属性表に対応） */
export type EventProps = Record<string, unknown>;
export type EventMap = Record<string, EventProps>;

/** 属性なしイベント（page_view 等）の properties 型 */
export type NoProps = Record<string, never>;

/** 組み込みの標準イベント（spec §6 / §7）。createAnalytics で既定で利用可能。 */
export interface StandardEvents {
  page_view: NoProps;
  click: { target_id: string };
  widget_opened: NoProps;
  flow_started: NoProps;
  step_viewed: { step: number };
  choice_selected: { step: number; choice_id: string };
  recommendation_shown: { result_id: string; step_count?: number; elapsed_ms?: number };
  recommendation_accepted: { result_id?: string };
  recommendation_rejected: { result_id?: string };
  flow_restarted: NoProps;
  error_occurred: { message: string; stack?: string; fingerprint?: string; source?: string };
  api_failed: { message: string; status?: number; source?: string; fingerprint?: string };
}

export interface ErrorOptions {
  stack?: string;
  source?: string;
  fingerprint?: string;
  pagePath?: string;
  properties?: Record<string, unknown>;
}
