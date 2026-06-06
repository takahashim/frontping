// テスト全体で共有する定数。vitest.config.ts の miniflare バインディングと
// テストコード（セッション署名）で同じ値を使うため1箇所に集約する。
export const TEST_SESSION_SECRET = "test-session-secret";
