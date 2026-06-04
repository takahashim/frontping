import type { Env } from "../types";

// §12.2 daily_session_metrics の冪等再計算。
// 指定 day（既定: 前日 UTC）の session_summaries を集計して該当行を置き換える。
// day 帰属は started_at ベース（§12.2）。
async function recomputeSessionMetrics(env: Env, day: string): Promise<void> {
  // 当該 day に開始したセッションを widget/flow 単位で集計
  await env.DB.prepare(
    `INSERT INTO daily_session_metrics
       (day, app_id, widget_id, flow_version,
        sessions, opened_sessions, started_sessions, completed_sessions,
        accepted_sessions, rejected_sessions, restarted_sessions, errored_sessions,
        total_duration_ms, total_max_step)
     SELECT
        ?, app_id, widget_id, flow_version,
        COUNT(*),
        SUM(opened), SUM(started), SUM(completed),
        SUM(accepted), SUM(rejected), SUM(restarted), SUM(errored),
        SUM(COALESCE(duration_ms, 0)), SUM(max_step)
     FROM session_summaries
     WHERE substr(started_at, 1, 10) = ?
     GROUP BY app_id, widget_id, flow_version
     ON CONFLICT (day, app_id, widget_id, flow_version) DO UPDATE SET
        sessions = excluded.sessions,
        opened_sessions = excluded.opened_sessions,
        started_sessions = excluded.started_sessions,
        completed_sessions = excluded.completed_sessions,
        accepted_sessions = excluded.accepted_sessions,
        rejected_sessions = excluded.rejected_sessions,
        restarted_sessions = excluded.restarted_sessions,
        errored_sessions = excluded.errored_sessions,
        total_duration_ms = excluded.total_duration_ms,
        total_max_step = excluded.total_max_step`
  )
    .bind(day, day)
    .run();
}

function yesterdayUtc(nowMs: number): string {
  return new Date(nowMs - 86400000).toISOString().slice(0, 10);
}

export async function recomputeYesterday(env: Env, nowMs: number): Promise<void> {
  await recomputeSessionMetrics(env, yesterdayUtc(nowMs));
}
