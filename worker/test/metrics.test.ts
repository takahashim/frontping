import { SELF, env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { querySummary, queryTimeseries } from "../src/db/metrics";

// /metrics の HTTP エンドポイントは廃止し、集計はダッシュボードがサーバ側で
// これらの純粋関数を呼んで使う（§18.1）。ここでは関数を直接検証する。

const ORIGIN = "https://app.example.com";

function postEvent(over: Record<string, unknown>): Promise<Response> {
  return SELF.fetch("https://worker.test/events", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: ORIGIN },
    body: JSON.stringify({
      app_id: "test_app",
      session_id: "s",
      occurred_at: new Date().toISOString(),
      page_path: "/recommend",
      ...over,
    }),
  });
}

const WIDE = { from: "0000-01-01", to: "9999-12-31" };

describe("querySummary (§9.4)", () => {
  it("returns event counts and null rates when no sessions", async () => {
    await postEvent({ event_name: "page_view" });
    await postEvent({ event_name: "page_view" });
    await postEvent({ event_name: "click", properties: { target_id: "btn" } });

    const s = await querySummary(env, "test_app", WIDE.from, WIDE.to);
    expect(s.page_views).toBe(2);
    expect(s.clicks).toBe(1);
    // page_view / click はセッション影響イベントではない（session_summaries 行を作らない）。
    // よって sessions=0 → completion/error rate は分母0で null。
    expect(s.sessions).toBe(0);
    expect(s.completion_rate).toBeNull();
    expect(s.error_rate).toBeNull();
  });

  it("reflects session flags live from session_summaries (no cron needed)", async () => {
    // flow_started → started, recommendation_shown → completed（lib/events.ts のマッピング）。
    // daily_session_metrics の集計 cron を待たず、その場でサマリに反映される。
    await postEvent({ session_id: "live1", event_name: "flow_started", widget_id: "w1", flow_version: "v1" });
    await postEvent({
      session_id: "live1",
      event_name: "recommendation_shown",
      widget_id: "w1",
      flow_version: "v1",
      properties: { result_id: "r1" },
    });

    const s = await querySummary(env, "test_app", WIDE.from, WIDE.to);
    expect(s.started_sessions).toBe(1);
    expect(s.completed_sessions).toBe(1);
    expect(s.completion_rate).toBe(1); // completed / started = 1/1
  });

  it("returns zeros for an app with no data", async () => {
    const s = await querySummary(env, "test_app_low", WIDE.from, WIDE.to);
    expect(s.page_views).toBe(0);
    expect(s.clicks).toBe(0);
    expect(s.sessions).toBe(0);
  });
});

describe("queryTimeseries (グラフ用)", () => {
  it("24h: returns 288 five-minute buckets with counts", async () => {
    await postEvent({ event_name: "page_view" });
    await postEvent({ event_name: "page_view" });
    await postEvent({ event_name: "click", properties: { target_id: "b" } });

    const j = await queryTimeseries(env, "test_app", "24h", Date.now());
    expect(j.unit).toBe("5min");
    expect(j.buckets).toHaveLength(288);
    // バケットラベルは 'YYYY-MM-DDTHH:MM' で、分は5の倍数
    expect(j.buckets[0]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
    expect(Number(j.buckets[0]!.slice(14, 16)) % 5).toBe(0);
    const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);
    expect(sum(j.series.page_views)).toBe(2);
    expect(sum(j.series.clicks)).toBe(1);
    expect(j.series.page_views).toHaveLength(288);
  });

  it("30d: returns 30 daily buckets from daily_event_counts", async () => {
    await postEvent({ event_name: "page_view" });
    const j = await queryTimeseries(env, "test_app", "30d", Date.now());
    expect(j.unit).toBe("day");
    expect(j.buckets).toHaveLength(30);
    const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);
    expect(sum(j.series.page_views)).toBe(1);
  });
});
