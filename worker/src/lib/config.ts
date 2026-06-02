import type { AppConfig, Env } from "../types";

// 静的設定（wrangler vars/secrets）を読み出す。§24
// APP_CONFIG は環境変数に埋め込んだ JSON 文字列。変更には再デプロイが必要。

let cache: Record<string, AppConfig> | null = null;

export function getAppConfig(env: Env, appId: string): AppConfig | null {
  if (!cache) {
    try {
      cache = JSON.parse(env.APP_CONFIG) as Record<string, AppConfig>;
    } catch {
      cache = {};
    }
  }
  return cache[appId] ?? null;
}

export function getMetricsToken(env: Env, appId: string): string | null {
  if (!env.METRICS_TOKENS) return null;
  try {
    const map = JSON.parse(env.METRICS_TOKENS) as Record<string, string>;
    return map[appId] ?? null;
  } catch {
    return null;
  }
}
