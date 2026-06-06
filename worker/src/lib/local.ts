import type { Env } from "../types";

// 実行環境がローカル開発（wrangler dev）かどうかを APP_ENV で判定する。
// 値は wrangler.toml の [vars]/[env.*.vars]（または .dev.vars）で与える。
// development = ローカル開発。production / preview = デプロイ環境。
export function isDevEnv(env: Env): boolean {
  return env.APP_ENV === "development";
}
