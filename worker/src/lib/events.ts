// イベント分類のドメイン知識を集約する単一ソース。
// （error 判定・セッション影響イベント・フラグ対応を1か所に）

export type SessionFlag =
  | "opened"
  | "started"
  | "completed"
  | "accepted"
  | "rejected"
  | "restarted"
  | "errored";

// エラー扱い（error_events への保存・通知・session.errored 対象）
const ERROR_EVENTS = new Set(["error_occurred", "api_failed"]);

export function isErrorEvent(name: string): boolean {
  return ERROR_EVENTS.has(name);
}

// session_summaries を更新するイベント（§11.1）
export const SESSION_EVENTS = new Set([
  "widget_opened",
  "flow_started",
  "step_viewed",
  "choice_selected",
  "recommendation_shown",
  "recommendation_accepted",
  "recommendation_rejected",
  "flow_restarted",
  "error_occurred",
  "api_failed",
]);

// イベント → セッションフラグ（§11.2）
export const SESSION_FLAG: Record<string, SessionFlag> = {
  widget_opened: "opened",
  flow_started: "started",
  recommendation_shown: "completed",
  recommendation_accepted: "accepted",
  recommendation_rejected: "rejected",
  flow_restarted: "restarted",
  error_occurred: "errored",
  api_failed: "errored",
};
