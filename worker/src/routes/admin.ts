import type { Context } from "hono";
import type { Env } from "../types";
import { requireMetricsAuth } from "./guard";
import { exportMonth } from "../db/exporter";

// §20.1 手動 export（管理API。token 認証。自動化までの補助 / 再実行用）
export async function postExport(c: Context<{ Bindings: Env }>): Promise<Response> {
  const guard = requireMetricsAuth(c);
  if (!guard.ok) return guard.res;

  if (!c.env.EXPORTS) return c.json({ error: "export_not_configured" }, 501);

  const year = Number(c.req.query("year"));
  const month = Number(c.req.query("month"));
  if (!Number.isInteger(year) || !(month >= 1 && month <= 12)) {
    return c.json({ error: "year_month_required" }, 400);
  }

  const includeRaw = c.req.query("include_raw") === "true";
  const result = await exportMonth(c.env, guard.appId, year, month, { includeRaw });
  return c.json({ ok: true, ...result });
}
