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
