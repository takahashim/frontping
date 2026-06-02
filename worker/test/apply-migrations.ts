import { applyD1Migrations, env } from "cloudflare:test";

// 各テストの分離ストレージにスキーマを適用する
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
