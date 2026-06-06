import type { Context } from "hono";
import type { Env } from "../types";
import { getAppConfig } from "../lib/config";
import { verifyMetricsToken } from "../lib/auth";
import { getSession } from "./oauth";

// metrics 系ハンドラ共通の認可ガード（§9.4）。成功なら appId、失敗なら Response を返す。
// 認可は2経路:
//  1) GitHub セッション Cookie（運用者）→ app_id クエリで任意アプリ閲覧可
//  2) per-app トークン（DB の metrics_tokens）→ そのアプリのみ（プログラム用途）
export type AuthGuard = { ok: true; appId: string } | { ok: false; res: Response };

export async function requireMetricsAuth(c: Context<{ Bindings: Env }>): Promise<AuthGuard> {
  const appId = c.req.query("app_id");
  if (!appId) return { ok: false, res: c.json({ error: "app_id_required" }, 400) };
  if (!getAppConfig(c.env, appId)) return { ok: false, res: c.json({ error: "invalid_app" }, 403) };

  // 1) ダッシュボードのログインセッション
  if (await getSession(c)) return { ok: true, appId };
  // 2) per-app トークン
  if (await verifyMetricsToken(c.env, appId, c.req.header("Authorization") ?? null)) {
    return { ok: true, appId };
  }
  return { ok: false, res: c.json({ error: "unauthorized" }, 401) };
}
