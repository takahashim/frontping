import { env, fetchMock } from "cloudflare:test";
import { beforeAll, afterEach, describe, it, expect } from "vitest";
import { notifyError } from "../src/lib/notify";
import type { NotifyPayload } from "../src/lib/notify";
import type { AppConfig } from "../src/types";

const NOW = "2026-06-02T00:00:00.000Z";

const cfg: AppConfig = {
  allowed_origins: [],
  require_origin: true,
  limits: { events_per_minute: 1, events_per_day: 1, raw_events_rows: 1, warn_threshold_ratio: 0.8 },
  retention: { raw_events_days: 30, error_events_days: 90, session_summaries_days: 365 },
  notification: { enabled: true, dedupe_minutes: 10, capacity_dedupe_minutes: 60 },
};

function payload(fingerprint: string): NotifyPayload {
  return {
    app_id: "notif_app",
    event_name: "error_occurred",
    page_path: "/",
    message: "boom",
    fingerprint,
    occurred_at: NOW,
  };
}

function dedupeRow(fp: string) {
  return env.DB.prepare(
    "SELECT last_notified_at FROM notification_dedupes WHERE app_id = ? AND fingerprint = ?"
  )
    .bind("notif_app", fp)
    .first();
}

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});
afterEach(() => fetchMock.assertNoPendingInterceptors());

describe("notify dedupe after successful delivery (#3)", () => {
  it("does NOT record dedupe when webhook delivery fails (non-2xx)", async () => {
    fetchMock.get("https://hooks.example.com").intercept({ path: "/wh", method: "POST" }).reply(500, "down");
    await expect(notifyError(env, cfg, payload("fp_fail"), NOW)).rejects.toThrow();
    // 送信失敗 → last_notified_at は進めない（次回は抑制されない）
    expect(await dedupeRow("fp_fail")).toBeNull();
  });

  it("records dedupe only after a successful delivery", async () => {
    fetchMock.get("https://hooks.example.com").intercept({ path: "/wh", method: "POST" }).reply(200, "ok");
    await notifyError(env, cfg, payload("fp_ok"), NOW);
    expect(await dedupeRow("fp_ok")).not.toBeNull();
  });
});
