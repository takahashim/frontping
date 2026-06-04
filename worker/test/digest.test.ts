import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { buildDigest } from "../src/db/digest";
import type { AppConfig } from "../src/types";

const DAY = "2026-05-20";

function cfg(enabled: boolean): AppConfig {
  return {
    allowed_origins: [],
    require_origin: true,
    limits: { events_per_minute: 1, events_per_day: 1, raw_events_rows: 1, warn_threshold_ratio: 0.8 },
    retention: { raw_events_days: 30, error_events_days: 90, session_summaries_days: 365 },
    notification: { enabled, dedupe_minutes: 10, capacity_dedupe_minutes: 60 },
  };
}

async function seed(appId: string): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO daily_event_counts (day, app_id, event_name, count) VALUES (?, ?, 'page_view', 1200)`
    ).bind(DAY, appId),
    env.DB.prepare(
      `INSERT INTO daily_event_counts (day, app_id, event_name, count) VALUES (?, ?, 'error_occurred', 12)`
    ).bind(DAY, appId),
    env.DB.prepare(
      `INSERT INTO daily_session_metrics (day, app_id, widget_id, flow_version, sessions, started_sessions, completed_sessions, errored_sessions)
       VALUES (?, ?, '', '', 800, 800, 420, 12)`
    ).bind(DAY, appId),
    env.DB.prepare(
      `INSERT INTO error_events (occurred_at, app_id, message, fingerprint) VALUES (?, ?, 'TypeError: boom', 'fp1')`
    ).bind(`${DAY}T09:00:00.000Z`, appId),
  ]);
}

describe("buildDigest (combined, §運用)", () => {
  it("aggregates enabled apps into one message with per-app sections", async () => {
    await seed("app_a");
    await seed("app_b");
    const configs = { app_a: cfg(true), app_b: cfg(true) };

    const text = await buildDigest(env, configs, DAY);
    expect(text).toContain(`daily digest ${DAY}`);
    expect(text).toContain("■ app_a");
    expect(text).toContain("■ app_b");
    expect(text).toContain("page_views 1200");
    expect(text).toContain("error_rate 1.5%"); // 12 / 800
    expect(text).toContain("top error: TypeError: boom (hits 1)"); // ip_hash 未記録 → sources 省略
  });

  it("skips apps with notification disabled", async () => {
    await seed("app_a");
    const text = await buildDigest(env, { app_a: cfg(false) }, DAY);
    expect(text).toBeNull(); // 送るものなし
  });

  it("skips apps with no activity", async () => {
    const text = await buildDigest(env, { quiet_app: cfg(true) }, DAY);
    expect(text).toBeNull();
  });
});
