import { Hono } from "hono";
import type { Env } from "./types";
import { collect } from "./routes/collect";
import { getMetrics, getTimeseries, getErrors } from "./routes/metrics";
import { postExport } from "./routes/admin";
import { preflightHeaders } from "./lib/cors";
import { runRetention } from "./db/retention";
import { recomputeYesterday } from "./db/aggregate";
import { sendDailyDigest } from "./db/digest";
import { checkCapacity } from "./lib/capacity";
import { exportPreviousMonth } from "./db/exporter";
import { getAllConfigs } from "./lib/config";
import { notifyOps } from "./lib/notify";
import { handleCallback, logout } from "./routes/oauth";
import { getDashboard } from "./routes/dashboard";

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
app.get("/metrics/errors", (c) => getErrors(c));

// §20.1 手動 export（管理API）
app.post("/admin/export", (c) => postExport(c));

// §18.1 ダッシュボード
app.get("/dashboard", (c) => getDashboard(c));
app.get("/dashboard/callback", (c) => handleCallback(c));
app.get("/dashboard/logout", (c) => logout(c));

app.get("/health", (c) => c.json({ ok: true }));

// 各 Cron ジョブを失敗通知付きで実行する。1つが失敗しても他は止めない（§19.4）。
// 失敗通知（webhook）自体がさらに失敗しても、この関数は決して reject しない
// （reject すると呼び出し側のジョブチェーンが止まってしまうため）。
async function runJob(env: Env, name: string, nowIso: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[frontping] cron job failed: ${name}`, e);
    try {
      await notifyOps(env, `cron:${name}`, `[frontping] cron job failed: ${name}\n${msg}`, nowIso);
    } catch (notifyErr) {
      // 通知経路（webhook）が落ちていても後続ジョブを止めない
      console.error(`[frontping] failed to notify cron failure: ${name}`, notifyErr);
    }
  }
}

export default {
  fetch: app.fetch,

  // §19.4 定期処理。event.cron でジョブを振り分ける。
  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();
    const configs = getAllConfigs(env);

    switch (event.cron) {
      case "0 3 * * *": {
        // 日次: 前日集計 → ダイジェスト通知 → retention（各段は独立に失敗通知）
        const yesterday = new Date(nowMs - 86_400_000).toISOString().slice(0, 10);
        ctx.waitUntil(
          (async () => {
            await runJob(env, "recompute", nowIso, () => recomputeYesterday(env, nowMs));
            await runJob(env, "digest", nowIso, () => sendDailyDigest(env, configs, yesterday));
            await runJob(env, "retention", nowIso, () => runRetention(env, configs));
          })()
        );
        break;
      }
      case "0 * * * *": // 毎時: 容量チェック / 逼迫アラート
        ctx.waitUntil(runJob(env, "capacity", nowIso, () => checkCapacity(env, configs, nowIso)));
        break;
      case "0 4 1 * *": // 月次: 前月分を R2 export（§20）
        ctx.waitUntil(runJob(env, "export", nowIso, () => exportPreviousMonth(env, Object.keys(configs), nowMs)));
        break;
    }
  },
};
