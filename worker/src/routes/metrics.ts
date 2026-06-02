import type { Context } from "hono";
import type { Env } from "../types";
import { getAppConfig } from "../lib/config";
import { checkMetricsAuth } from "../lib/auth";

// §9.4 GET /metrics（Phase 2）。daily_* から集計値を返す。要 token 認証。

function ratio(num: number, den: number): number | null {
  return den === 0 ? null : num / den; // §18.3 分母0は null
}

export async function getMetrics(c: Context<{ Bindings: Env }>): Promise<Response> {
  const env = c.env;
  const appId = c.req.query("app_id");
  if (!appId) return c.json({ error: "app_id_required" }, 400);
  if (!getAppConfig(env, appId)) return c.json({ error: "invalid_app" }, 403);

  if (!checkMetricsAuth(env, appId, c.req.header("Authorization") ?? null)) {
    return c.json({ error: "unauthorized" }, 401);
  }

  const from = c.req.query("from") ?? "0000-01-01";
  const to = c.req.query("to") ?? "9999-12-31";
  const widgetId = c.req.query("widget_id");
  const flowVersion = c.req.query("flow_version");

  // イベント系（page_view / click / errors）は daily_event_counts から
  const ev = await env.DB.prepare(
    `SELECT event_name, SUM(count) AS n FROM daily_event_counts
     WHERE app_id = ? AND day >= ? AND day <= ?
     GROUP BY event_name`
  )
    .bind(appId, from, to)
    .all<{ event_name: string; n: number }>();
  const evMap = new Map(ev.results.map((r) => [r.event_name, r.n]));

  // セッション系は daily_session_metrics から
  let sql = `SELECT
      SUM(sessions) AS sessions,
      SUM(started_sessions) AS started,
      SUM(completed_sessions) AS completed,
      SUM(accepted_sessions) AS accepted,
      SUM(errored_sessions) AS errored
    FROM daily_session_metrics
    WHERE app_id = ? AND day >= ? AND day <= ?`;
  const binds: unknown[] = [appId, from, to];
  if (widgetId) {
    sql += " AND widget_id = ?";
    binds.push(widgetId);
  }
  if (flowVersion) {
    sql += " AND flow_version = ?";
    binds.push(flowVersion);
  }
  const s = await env.DB.prepare(sql)
    .bind(...binds)
    .first<{ sessions: number; started: number; completed: number; accepted: number; errored: number }>();

  const sessions = s?.sessions ?? 0;
  const started = s?.started ?? 0;
  const completed = s?.completed ?? 0;
  const accepted = s?.accepted ?? 0;
  const errored = s?.errored ?? 0;

  return c.json({
    app_id: appId,
    from,
    to,
    summary: {
      page_views: evMap.get("page_view") ?? 0,
      clicks: evMap.get("click") ?? 0,
      sessions,
      started_sessions: started,
      completed_sessions: completed,
      accepted_sessions: accepted,
      errored_sessions: errored,
      error_events: (evMap.get("error_occurred") ?? 0) + (evMap.get("api_failed") ?? 0),
      completion_rate: ratio(completed, started),
      acceptance_rate: ratio(accepted, completed),
      error_rate: ratio(errored, sessions),
    },
  });
}
