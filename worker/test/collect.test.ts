import { SELF, env } from "cloudflare:test";
import { describe, it, expect } from "vitest";

const ORIGIN = "https://app.example.com";

function post(path: string, body: unknown, init: RequestInit = {}): Promise<Response> {
  const { headers, ...rest } = init;
  return SELF.fetch(`https://worker.test${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: ORIGIN, ...((headers as Record<string, string>) ?? {}) },
    body: JSON.stringify(body),
    ...rest,
  });
}

const baseEvent = (over: Record<string, unknown> = {}) => ({
  app_id: "test_app",
  event_name: "page_view",
  session_id: "sess_1",
  occurred_at: new Date().toISOString(),
  page_path: "/recommend",
  ...over,
});

describe("origin / CORS (§15)", () => {
  it("rejects disallowed origin with 403", async () => {
    const res = await post("/events", baseEvent(), { headers: { Origin: "https://evil.example.com" } });
    expect(res.status).toBe(403);
  });

  it("echoes allowed origin on success", async () => {
    const res = await post("/events", baseEvent());
    expect(res.status).toBe(202);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(ORIGIN);
  });

  it("answers preflight with POST + content-type only", async () => {
    const res = await SELF.fetch("https://worker.test/events", {
      method: "OPTIONS",
      headers: { Origin: ORIGIN },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Methods")).toBe("POST");
    expect(res.headers.get("Access-Control-Allow-Headers")).toBe("content-type");
  });
});

describe("method not allowed (§9.1)", () => {
  it("returns 405 with Allow: POST for non-POST on collection endpoints", async () => {
    for (const path of ["/events", "/events/batch", "/errors"]) {
      const res = await SELF.fetch(`https://worker.test${path}`, { method: "GET" });
      expect(res.status).toBe(405);
      expect(res.headers.get("Allow")).toBe("POST");
    }
  });
});

describe("validation (§10)", () => {
  it("rejects unknown event in a batch but accepts valid ones", async () => {
    const res = await post("/events/batch", {
      events: [baseEvent(), baseEvent({ event_name: "totally_unknown" })],
    });
    expect(res.status).toBe(202);
    const json = (await res.json()) as { accepted: number; rejected: number };
    expect(json.accepted).toBe(1);
    expect(json.rejected).toBe(1);
  });

  it("rejects click without target_id", async () => {
    const res = await post("/events/batch", { events: [baseEvent({ event_name: "click" })] });
    const json = (await res.json()) as { accepted: number; rejected: number };
    expect(json.accepted).toBe(0);
    expect(json.rejected).toBe(1);
  });

  it("strips query string from page_path (§25.2)", async () => {
    await post("/events", baseEvent({ session_id: "sess_qs", page_path: "/p?email=a@b.com#x" }));
    const row = await env.DB.prepare(
      "SELECT page_path FROM raw_events WHERE session_id = ?"
    )
      .bind("sess_qs")
      .first<{ page_path: string }>();
    expect(row?.page_path).toBe("/p");
  });
});

describe("session_summaries idempotency (§11.3)", () => {
  it("keeps flags monotonic and max_step on duplicate / out-of-order arrival", async () => {
    const sid = "sess_idem";
    const ev = (over: Record<string, unknown>) =>
      baseEvent({ session_id: sid, widget_id: "main", flow_version: "v1", ...over });

    // 順不同・重複で送る
    await post("/events/batch", {
      events: [
        ev({ event_name: "step_viewed", properties: { step: 3 } }),
        ev({ event_name: "widget_opened" }),
        ev({ event_name: "step_viewed", properties: { step: 1 } }),
        ev({ event_name: "recommendation_shown", properties: { result_id: "plan_basic" } }),
        ev({ event_name: "recommendation_shown", properties: { result_id: "plan_basic" } }), // 重複
      ],
    });

    const row = await env.DB.prepare(
      "SELECT opened, completed, max_step, result_id FROM session_summaries WHERE session_id = ?"
    )
      .bind(sid)
      .first<{ opened: number; completed: number; max_step: number; result_id: string }>();

    expect(row?.opened).toBe(1);
    expect(row?.completed).toBe(1); // 重複しても 1
    expect(row?.max_step).toBe(3); // MAX(3,1)
    expect(row?.result_id).toBe("plan_basic");
  });
});

describe("daily_event_counts aggregation (§12.1)", () => {
  it("sums same-key events within one request", async () => {
    await post("/events/batch", {
      events: [
        baseEvent({ session_id: "s", event_name: "click", properties: { target_id: "btn" } }),
        baseEvent({ session_id: "s", event_name: "click", properties: { target_id: "btn" } }),
        baseEvent({ session_id: "s", event_name: "click", properties: { target_id: "btn" } }),
      ],
    });
    const row = await env.DB.prepare(
      "SELECT count FROM daily_event_counts WHERE app_id = ? AND event_name = 'click' AND target_id = 'btn'"
    )
      .bind("test_app")
      .first<{ count: number }>();
    expect(row?.count).toBe(3);
  });
});

describe("load shedding (§16.3)", () => {
  it("returns 429 + Retry-After on fetch path over the limit", async () => {
    const ev = baseEvent({ app_id: "test_app_low" });
    // events_per_minute = 3。4件目以降は超過。
    await post("/events", { ...ev });
    await post("/events", { ...ev });
    await post("/events", { ...ev });
    const res = await post("/events", { ...ev });
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBeTruthy();
  });

  it("silently drops (202) on beacon/text path over the limit", async () => {
    const ev = baseEvent({ app_id: "test_app_low" });
    for (let i = 0; i < 3; i++) await post("/events", { ...ev });
    // text/plain = beacon 経路
    const res = await post("/events", { ...ev }, { headers: { "Content-Type": "text/plain" } });
    expect(res.status).toBe(202);
  });
});
