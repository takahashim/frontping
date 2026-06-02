import { SELF } from "cloudflare:test";
import { describe, it, expect } from "vitest";

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

function getMetrics(headers: Record<string, string> = {}): Promise<Response> {
  return SELF.fetch("https://worker.test/metrics?app_id=test_app", { headers });
}

describe("GET /metrics (§9.4)", () => {
  it("401 without token", async () => {
    expect((await getMetrics()).status).toBe(401);
  });

  it("403 for unknown app", async () => {
    const res = await SELF.fetch("https://worker.test/metrics?app_id=nope", {
      headers: { Authorization: "Bearer test-token" },
    });
    expect(res.status).toBe(403);
  });

  it("returns event counts and null rates when no sessions", async () => {
    await postEvent({ event_name: "page_view" });
    await postEvent({ event_name: "page_view" });
    await postEvent({ event_name: "click", properties: { target_id: "btn" } });

    const res = await getMetrics({ Authorization: "Bearer test-token" });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { summary: Record<string, number | null> };
    expect(json.summary.page_views).toBe(2);
    expect(json.summary.clicks).toBe(1);
    // daily_session_metrics は cron で生成されるため、この時点では 0 / null
    expect(json.summary.completion_rate).toBeNull();
    expect(json.summary.error_rate).toBeNull();
  });
});

describe("GET /metrics/timeseries (グラフ用)", () => {
  function ts(range: string, headers: Record<string, string> = {}): Promise<Response> {
    return SELF.fetch(`https://worker.test/metrics/timeseries?app_id=test_app&range=${range}`, { headers });
  }

  it("401 without token", async () => {
    expect((await ts("24h")).status).toBe(401);
  });

  it("24h: returns 288 five-minute buckets with counts", async () => {
    await postEvent({ event_name: "page_view" });
    await postEvent({ event_name: "page_view" });
    await postEvent({ event_name: "click", properties: { target_id: "b" } });

    const res = await ts("24h", { Authorization: "Bearer test-token" });
    expect(res.status).toBe(200);
    const j = (await res.json()) as { unit: string; buckets: string[]; series: Record<string, number[]> };
    expect(j.unit).toBe("5min");
    expect(j.buckets).toHaveLength(288);
    // バケットラベルは 'YYYY-MM-DDTHH:MM' で、分は5の倍数
    expect(j.buckets[0]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
    expect(Number(j.buckets[0]!.slice(14, 16)) % 5).toBe(0);
    const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);
    expect(sum(j.series.page_views!)).toBe(2);
    expect(sum(j.series.clicks!)).toBe(1);
    expect(j.series.page_views!).toHaveLength(288);
  });

  it("30d: returns 30 daily buckets from daily_event_counts", async () => {
    await postEvent({ event_name: "page_view" });
    const res = await ts("30d", { Authorization: "Bearer test-token" });
    const j = (await res.json()) as { unit: string; buckets: string[]; series: Record<string, number[]> };
    expect(j.unit).toBe("day");
    expect(j.buckets).toHaveLength(30);
    const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);
    expect(sum(j.series.page_views!)).toBe(1);
  });
});
