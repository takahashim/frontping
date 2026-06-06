import { env } from "cloudflare:test";
import { beforeEach } from "vitest";

// pool-workers 0.16 は per-test ストレージ分離を廃止（per-test-file 分離）したため、
// 各テスト前に自前でデータをリセットして per-test の独立性を取り戻す。
// （スキーマは apply-migrations.ts で適用済み。DROP せず DELETE する）

const TABLES = [
  "raw_events",
  "error_events",
  "session_summaries",
  "daily_event_counts",
  "daily_session_metrics",
  "notification_dedupes",
  "metrics_tokens",
];

beforeEach(async () => {
  // APP_ENV は production を既定に戻す（dev バイパスを見るテストが上書きした分の漏れ防止）。
  env.APP_ENV = "production";
  await env.DB.batch(TABLES.map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  // KV（総量カウンタ）も掃除
  const { keys } = await env.RL.list();
  await Promise.all(keys.map((k) => env.RL.delete(k.name)));
});
