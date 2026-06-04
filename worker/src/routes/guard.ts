import type { Context } from "hono";
import type { Env } from "../types";
import { getAppConfig } from "../lib/config";
import { verifyMetricsToken } from "../lib/auth";

// metrics 系ハンドラ共通の認可ガード（§9.4）。
// 成功なら appId を、失敗なら返すべき Response を返す。
// トークンは app スコープ（DB の metrics_tokens）なので、ある app のトークンで
// 別 app のデータにはアクセスできない。
export type AuthGuard = { ok: true; appId: string } | { ok: false; res: Response };

export async function requireMetricsAuth(c: Context<{ Bindings: Env }>): Promise<AuthGuard> {
  const appId = c.req.query("app_id");
  if (!appId) return { ok: false, res: c.json({ error: "app_id_required" }, 400) };
  if (!getAppConfig(c.env, appId)) return { ok: false, res: c.json({ error: "invalid_app" }, 403) };
  if (!(await verifyMetricsToken(c.env, appId, c.req.header("Authorization") ?? null))) {
    return { ok: false, res: c.json({ error: "unauthorized" }, 401) };
  }
  return { ok: true, appId };
}
