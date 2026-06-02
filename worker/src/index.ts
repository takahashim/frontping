import { Hono } from "hono";
import type { Env } from "./types";
import { collect } from "./routes/collect";
import { getMetrics, getTimeseries } from "./routes/metrics";
import { postExport } from "./routes/admin";
import { preflightHeaders } from "./lib/cors";
import { runRetention } from "./db/retention";
import { recomputeYesterday } from "./db/aggregate";
import { checkCapacity } from "./lib/capacity";
import { exportPreviousMonth } from "./db/exporter";
import { getAllConfigs } from "./lib/config";
import { DASHBOARD_HTML } from "./dashboard";

const app = new Hono<{ Bindings: Env }>();

// CORS プリフライト（§15.1）
app.options("*", (c) => {
  const origin = c.req.header("Origin") ?? null;
  return c.body(null, 204, preflightHeaders(origin));
});

// 収集系（§9）
app.post("/events", (c) => collect(c, "single"));
app.post("/events/batch", (c) => collect(c, "batch"));
app.post("/errors", (c) => collect(c, "error"));

// メトリクス（§9.4）
app.get("/metrics", (c) => getMetrics(c));
app.get("/metrics/timeseries", (c) => getTimeseries(c));

// §20.1 手動 export（管理API）
app.post("/admin/export", (c) => postExport(c));

// §18.1 最小ダッシュボード（読み取り専用・同一オリジンで /metrics を叩く）
app.get("/dashboard", (c) =>
  c.html(DASHBOARD_HTML, 200, { "Cache-Control": "no-store", "X-Robots-Tag": "noindex" })
);

app.get("/health", (c) => c.json({ ok: true }));

export default {
  fetch: app.fetch,

  // §19.4 定期処理。event.cron でジョブを振り分ける。
  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();
    const configs = getAllConfigs(env);

    switch (event.cron) {
      case "0 3 * * *": // 日次: retention + 前日 session metrics 再計算
        ctx.waitUntil(
          (async () => {
            await recomputeYesterday(env, nowMs);
            await runRetention(env, configs);
          })()
        );
        break;
      case "0 * * * *": // 毎時: 容量チェック / 逼迫アラート
        ctx.waitUntil(checkCapacity(env, configs, nowIso));
        break;
      case "0 4 1 * *": // 月次: 前月分を R2 export（§20）
        ctx.waitUntil(exportPreviousMonth(env, Object.keys(configs), nowMs));
        break;
    }
  },
};
