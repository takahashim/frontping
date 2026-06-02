import type { NormalizedEvent } from "../types";

// §25.7 1リクエスト分の書き込みを 1 batch（単一トランザクション）にまとめる。
// raw_events を source of truth とし、daily/session はそこから再生成可能（§25.5）。

const SESSION_EVENTS = new Set([
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

// §11.2 セッションフラグの更新マップ
const FLAG: Record<string, "opened" | "started" | "completed" | "accepted" | "rejected" | "restarted" | "errored"> = {
  widget_opened: "opened",
  flow_started: "started",
  recommendation_shown: "completed",
  recommendation_accepted: "accepted",
  recommendation_rejected: "rejected",
  flow_restarted: "restarted",
  error_occurred: "errored",
  api_failed: "errored",
};

function dayOf(occurredAt: string): string {
  return occurredAt.slice(0, 10); // YYYY-MM-DD (UTC)
}

function rawInsert(db: D1Database, n: NormalizedEvent, userAgent: string | null, ipHash: string | null) {
  return db
    .prepare(
      `INSERT INTO raw_events
        (occurred_at, app_id, session_id, event_name, page_path, widget_id, flow_version,
         step, target_id, choice_id, result_id, elapsed_ms, properties_json, user_agent, ip_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      n.occurred_at, n.app_id, n.session_id, n.event_name, n.page_path, n.widget_id, n.flow_version,
      n.step, n.target_id, n.choice_id, n.result_id, n.elapsed_ms, n.properties_json, userAgent, ipHash
    );
}

function errorInsert(db: D1Database, n: NormalizedEvent, userAgent: string | null, ipHash: string | null) {
  return db
    .prepare(
      `INSERT INTO error_events
        (occurred_at, app_id, session_id, page_path, widget_id, flow_version,
         message, stack, fingerprint, source, user_agent, ip_hash, properties_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      n.occurred_at, n.app_id, n.session_id, n.page_path, n.widget_id, n.flow_version,
      n.message ?? "", n.stack ?? null, n.fingerprint ?? null, n.source ?? null,
      userAgent, ipHash, n.properties_json
    );
}

// §12.1 daily_event_counts upsert。集計キーで JS 側合算してから 1 行に。
type DailyKey = string;
function dailyAgg(events: NormalizedEvent[]): Map<DailyKey, { e: NormalizedEvent; count: number }> {
  const map = new Map<DailyKey, { e: NormalizedEvent; count: number }>();
  for (const e of events) {
    const k = [
      dayOf(e.occurred_at), e.app_id, e.event_name, e.page_path, e.widget_id, e.flow_version,
      e.step ?? 0, e.target_id ?? "", e.choice_id ?? "", e.result_id ?? "",
    ].join("");
    const hit = map.get(k);
    if (hit) hit.count++;
    else map.set(k, { e, count: 1 });
  }
  return map;
}

function dailyUpsert(db: D1Database, e: NormalizedEvent, count: number) {
  return db
    .prepare(
      `INSERT INTO daily_event_counts
        (day, app_id, event_name, page_path, widget_id, flow_version, step, target_id, choice_id, result_id, count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (day, app_id, event_name, page_path, widget_id, flow_version, step, target_id, choice_id, result_id)
       DO UPDATE SET count = count + excluded.count`
    )
    .bind(
      dayOf(e.occurred_at), e.app_id, e.event_name, e.page_path, e.widget_id, e.flow_version,
      e.step ?? 0, e.target_id ?? "", e.choice_id ?? "", e.result_id ?? "", count
    );
}

// §11.3 冪等な session_summaries upsert。
// choices_json はライブ更新せず、日次再計算で raw_events から再構築する（§25.5）。
function sessionUpsert(db: D1Database, e: NormalizedEvent) {
  const flag = FLAG[e.event_name];
  const cols = {
    opened: flag === "opened" ? 1 : 0,
    started: flag === "started" ? 1 : 0,
    completed: flag === "completed" ? 1 : 0,
    accepted: flag === "accepted" ? 1 : 0,
    rejected: flag === "rejected" ? 1 : 0,
    restarted: flag === "restarted" ? 1 : 0,
    errored: flag === "errored" ? 1 : 0,
  };
  const step = e.step ?? 0;
  const resultId = e.event_name === "recommendation_shown" ? e.result_id : null;

  return db
    .prepare(
      `INSERT INTO session_summaries
        (session_id, app_id, widget_id, flow_version, page_path, started_at, ended_at, duration_ms,
         opened, started, completed, accepted, rejected, restarted, errored, max_step, result_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         widget_id   = CASE WHEN session_summaries.widget_id = '' THEN excluded.widget_id ELSE session_summaries.widget_id END,
         flow_version= CASE WHEN session_summaries.flow_version = '' THEN excluded.flow_version ELSE session_summaries.flow_version END,
         started_at  = MIN(session_summaries.started_at, excluded.started_at),
         ended_at    = MAX(COALESCE(session_summaries.ended_at, excluded.ended_at), excluded.ended_at),
         duration_ms = (julianday(MAX(COALESCE(session_summaries.ended_at, excluded.ended_at), excluded.ended_at))
                        - julianday(MIN(session_summaries.started_at, excluded.started_at))) * 86400000,
         opened    = MAX(session_summaries.opened, excluded.opened),
         started   = MAX(session_summaries.started, excluded.started),
         completed = MAX(session_summaries.completed, excluded.completed),
         accepted  = MAX(session_summaries.accepted, excluded.accepted),
         rejected  = MAX(session_summaries.rejected, excluded.rejected),
         restarted = MAX(session_summaries.restarted, excluded.restarted),
         errored   = MAX(session_summaries.errored, excluded.errored),
         max_step  = MAX(session_summaries.max_step, excluded.max_step),
         result_id = COALESCE(excluded.result_id, session_summaries.result_id),
         updated_at = CURRENT_TIMESTAMP`
    )
    .bind(
      e.session_id, e.app_id, e.widget_id, e.flow_version, e.page_path, e.occurred_at, e.occurred_at,
      cols.opened, cols.started, cols.completed, cols.accepted, cols.rejected, cols.restarted, cols.errored,
      step, resultId
    );
}

export interface WriteContext {
  userAgent: string | null;
  ipHash: string | null;
}

// 受理イベント群を 1 batch で書き込む
export async function writeEvents(
  db: D1Database,
  events: NormalizedEvent[],
  ctx: WriteContext
): Promise<void> {
  if (events.length === 0) return;
  const stmts: D1PreparedStatement[] = [];

  for (const e of events) {
    stmts.push(rawInsert(db, e, ctx.userAgent, ctx.ipHash));
    if (e.event_name === "error_occurred" || e.event_name === "api_failed") {
      stmts.push(errorInsert(db, e, ctx.userAgent, ctx.ipHash));
    }
    if (SESSION_EVENTS.has(e.event_name)) {
      stmts.push(sessionUpsert(db, e));
    }
  }

  for (const { e, count } of dailyAgg(events).values()) {
    stmts.push(dailyUpsert(db, e, count));
  }

  await db.batch(stmts);
}
