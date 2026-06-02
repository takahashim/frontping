import type { AppConfig, Env } from "../types";

// §19 retention。Cron から呼ぶ。app ごとの保存期間で削除する。
export async function runRetention(env: Env, configs: Record<string, AppConfig>): Promise<void> {
  for (const [appId, cfg] of Object.entries(configs)) {
    const r = cfg.retention;
    await env.DB.batch([
      env.DB.prepare(
        `DELETE FROM raw_events WHERE app_id = ? AND occurred_at < datetime('now', ?)`
      ).bind(appId, `-${r.raw_events_days} days`),
      env.DB.prepare(
        `DELETE FROM error_events WHERE app_id = ? AND occurred_at < datetime('now', ?)`
      ).bind(appId, `-${r.error_events_days} days`),
      env.DB.prepare(
        `DELETE FROM session_summaries WHERE app_id = ? AND started_at < datetime('now', ?)`
      ).bind(appId, `-${r.session_summaries_days} days`),
      env.DB.prepare(
        `DELETE FROM notification_dedupes WHERE app_id = ? AND last_notified_at < datetime('now', '-30 days')`
      ).bind(appId),
    ]);
  }
}
