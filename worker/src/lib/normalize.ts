import type { IncomingEvent, NormalizedEvent } from "../types";
import { clamp } from "./validate";
import { maskPII } from "./sanitize";
import { isErrorEvent } from "./events";

// §25.2 page_path から query string / fragment を除去
export function stripPath(path: string | undefined): string {
  if (!path) return "";
  let p = path;
  const hash = p.indexOf("#");
  if (hash >= 0) p = p.slice(0, hash);
  const q = p.indexOf("?");
  if (q >= 0) p = p.slice(0, q);
  return p;
}

// §25.6 occurred_at を received_at 基準の許容範囲にクランプ
const PAST_MS = 7 * 24 * 60 * 60 * 1000; // -7d
const FUTURE_MS = 60 * 60 * 1000; // +1h

export function clampOccurredAt(raw: string, receivedAtMs: number): string {
  const t = Date.parse(raw);
  if (Number.isNaN(t) || t < receivedAtMs - PAST_MS || t > receivedAtMs + FUTURE_MS) {
    return new Date(receivedAtMs).toISOString();
  }
  return new Date(t).toISOString();
}

function asNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function asString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

// 主要な分析軸を列に展開する（§25.1 正規化）
export function normalizeEvent(ev: IncomingEvent, receivedAtMs: number): NormalizedEvent {
  const props = (ev.properties ?? {}) as Record<string, unknown>;
  const isError = isErrorEvent(ev.event_name);

  const n: NormalizedEvent = {
    occurred_at: clampOccurredAt(ev.occurred_at, receivedAtMs),
    app_id: clamp(ev.app_id, "app_id"),
    session_id: clamp(ev.session_id, "session_id"),
    event_name: clamp(ev.event_name, "event_name"),
    page_path: clamp(stripPath(ev.page_path), "page_path"),
    widget_id: clamp(asString(ev.widget_id ?? props.widget_id) ?? "", "widget_id"),
    flow_version: clamp(asString(ev.flow_version ?? props.flow_version) ?? "", "flow_version"),
    step: asNumber(props.step),
    target_id: asString(props.target_id) && clamp(props.target_id as string, "target_id"),
    choice_id: asString(props.choice_id) && clamp(props.choice_id as string, "choice_id"),
    result_id: asString(props.result_id) && clamp(props.result_id as string, "result_id"),
    elapsed_ms: asNumber(props.elapsed_ms),
    properties_json: JSON.stringify(props ?? {}),
  };

  if (isError) {
    n.message = clamp(maskPII(asString(props.message) ?? ""), "message");
    n.stack = props.stack ? clamp(maskPII(String(props.stack)), "stack") : null;
    n.source = asString(props.source);
  }

  return n;
}
