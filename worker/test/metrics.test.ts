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
    // daily_session_metrics は cron で生成されるため、この時点では 0 / null
    expect(s.completion_rate).toBeNull();
    expect(s.error_rate).toBeNull();
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
