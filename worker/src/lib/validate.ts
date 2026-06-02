import type { IncomingEvent } from "../types";

// §10.1 許可イベント
export const ALLOWED_EVENTS = new Set([
  "page_view",
  "click",
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

// §10.3 文字列長制限
export const MAX_LEN: Record<string, number> = {
  app_id: 64,
  event_name: 64,
  session_id: 128,
  page_path: 512,
  widget_id: 64,
  flow_version: 64,
  target_id: 128,
  choice_id: 128,
  result_id: 128,
  message: 2048,
  stack: 16000,
};

// §10.2 イベントごとの必須属性
const REQUIRED_PROPS: Record<string, string[]> = {
  click: ["target_id"],
  choice_selected: ["widget_id", "flow_version", "step", "choice_id"],
  recommendation_shown: ["widget_id", "flow_version", "result_id"],
  recommendation_accepted: ["widget_id", "flow_version"],
  recommendation_rejected: ["widget_id", "flow_version"],
  flow_restarted: ["widget_id", "flow_version"],
  step_viewed: ["step"],
  error_occurred: ["message"],
  api_failed: ["message"],
};

export interface ValidationResult {
  ok: boolean;
  reason?: string;
}

function nonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

// 共通フィールド + イベント別必須属性を検証する。クライアント値は信用しない（§25.1）。
export function validateEvent(ev: IncomingEvent): ValidationResult {
  if (!nonEmptyString(ev.app_id)) return { ok: false, reason: "app_id" };
  if (!nonEmptyString(ev.event_name)) return { ok: false, reason: "event_name" };
  if (!nonEmptyString(ev.session_id)) return { ok: false, reason: "session_id" };
  if (!nonEmptyString(ev.occurred_at)) return { ok: false, reason: "occurred_at" };

  if (!ALLOWED_EVENTS.has(ev.event_name)) {
    return { ok: false, reason: `unknown_event:${ev.event_name}` };
  }

  // widget_id / flow_version は属性ではなくトップレベル or properties のどちらでも許容する
  const props = (ev.properties ?? {}) as Record<string, unknown>;
  const lookup = (key: string): unknown => {
    if (key === "widget_id") return ev.widget_id ?? props.widget_id;
    if (key === "flow_version") return ev.flow_version ?? props.flow_version;
    return props[key];
  };

  const required = REQUIRED_PROPS[ev.event_name] ?? [];
  for (const key of required) {
    const v = lookup(key);
    if (key === "step") {
      if (typeof v !== "number" || !Number.isFinite(v)) {
        return { ok: false, reason: `missing:${ev.event_name}.${key}` };
      }
    } else if (!nonEmptyString(v)) {
      return { ok: false, reason: `missing:${ev.event_name}.${key}` };
    }
  }

  return { ok: true };
}

export function clamp(value: string | undefined | null, field: string): string {
  if (value == null) return "";
  const max = MAX_LEN[field];
  return max != null && value.length > max ? value.slice(0, max) : value;
}
