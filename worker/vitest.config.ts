import { defineWorkersConfig, readD1Migrations } from "@cloudflare/vitest-pool-workers/config";

// マイグレーションを読み込み、テスト用 D1 に適用する（test/apply-migrations.ts）
const migrations = await readD1Migrations("./migrations");

// テスト用 app 設定。
// - test_app:     機能テスト用（上限は十分大きく）
// - test_app_low: ロードシェディング検証用（分あたり上限を小さく）
const base = {
  allowed_origins: ["https://app.example.com"],
  require_origin: true,
  retention: { raw_events_days: 30, error_events_days: 90, session_summaries_days: 365 },
  notification: { enabled: false, dedupe_minutes: 10, capacity_dedupe_minutes: 60 },
};
const TEST_APP_CONFIG = JSON.stringify({
  test_app: {
    ...base,
    limits: { events_per_minute: 1000, events_per_day: 100000, raw_events_rows: 1000000, warn_threshold_ratio: 0.8 },
  },
  test_app_low: {
    ...base,
    limits: { events_per_minute: 3, events_per_day: 100000, raw_events_rows: 1000000, warn_threshold_ratio: 0.8 },
  },
});

export default defineWorkersConfig({
  test: {
    setupFiles: ["./test/apply-migrations.ts"],
    poolOptions: {
      workers: {
        singleWorker: true,
        wrangler: { configPath: "./wrangler.toml" },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            APP_CONFIG: TEST_APP_CONFIG,
            NOTIFY_WEBHOOK_URL: "https://hooks.example.com/wh",
            SESSION_SECRET: "test-session-secret",
          },
        },
      },
    },
  },
});
