import type { AppConfig, Env } from "../types";
import { notifyCapacity } from "./notify";

// §16.4 毎時の容量チェック / 逼迫アラート。
// raw_events 行数を app ごとに確認し、警戒閾値（warn_threshold_ratio）超過で通知する。
export async function checkCapacity(
  env: Env,
  configs: Record<string, AppConfig>,
  nowIso: string
): Promise<void> {
  for (const [appId, cfg] of Object.entries(configs)) {
    const limit = cfg.limits.raw_events_rows;
    const row = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM raw_events WHERE app_id = ?"
    )
      .bind(appId)
      .first<{ n: number }>();
    const n = row?.n ?? 0;
    if (n >= limit * cfg.limits.warn_threshold_ratio) {
      await notifyCapacity(env, cfg, appId, "raw_events_rows", n, limit, nowIso);
    }
  }
}
