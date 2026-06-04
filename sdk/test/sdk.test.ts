import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createAnalytics, Frontping } from "../src/index";

interface FetchCall {
  url: string;
  body: any;
  headers: Record<string, string>;
}

let calls: FetchCall[] = [];
let nextStatus = 202;
let nextRetryAfter: string | null = null;

function installFetch(): void {
  calls = [];
  nextStatus = 202;
  nextRetryAfter = null;
  (globalThis as any).fetch = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({
      url,
      body: JSON.parse(String(init.body)),
      headers: (init.headers ?? {}) as Record<string, string>,
    });
    return {
      status: nextStatus,
      headers: { get: (k: string) => (k.toLowerCase() === "retry-after" ? nextRetryAfter : null) },
    } as unknown as Response;
  });
}

const ENDPOINT = "https://collect.example.com";

beforeEach(() => {
  installFetch();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-06-01T00:00:00.000Z"));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("session & payload (§5, §17.2)", () => {
  it("generates a session_id and reuses it across events", () => {
    const a = createAnalytics({ endpoint: ENDPOINT, appId: "app1" });
    a.trackPageView("/home");
    a.trackClick("btn", "/home");
    a.flush();
    expect(calls).toHaveLength(1);
    const events = calls[0]!.body.events;
    expect(events).toHaveLength(2);
    expect(events[0].session_id).toBe(events[1].session_id);
    expect(events[0].session_id).toBeTruthy();
    a.destroy();
  });

  it("strips query string / fragment client-side (§25.2)", () => {
    const a = createAnalytics({ endpoint: ENDPOINT, appId: "app1" });
    a.trackPageView("/p?email=a@b.com#frag");
    a.flush();
    expect(calls[0]!.body.events[0].page_path).toBe("/p");
    a.destroy();
  });

  it("posts to /events/batch as JSON", () => {
    const a = createAnalytics({ endpoint: ENDPOINT, appId: "app1" });
    a.trackPageView("/x");
    a.flush();
    expect(calls[0]!.url).toBe(`${ENDPOINT}/events/batch`);
    expect(calls[0]!.headers["Content-Type"]).toBe("application/json");
    a.destroy();
  });
});

describe("batching (§17.5)", () => {
  it("auto-flushes when reaching maxBatch", () => {
    const a = createAnalytics({ endpoint: ENDPOINT, appId: "app1", maxBatch: 3 });
    a.trackPageView("/1");
    a.trackPageView("/2");
    expect(calls).toHaveLength(0);
    a.trackPageView("/3"); // 3件目で自動 flush
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body.events).toHaveLength(3);
    a.destroy();
  });

  it("flushes on the interval timer", () => {
    const a = createAnalytics({ endpoint: ENDPOINT, appId: "app1", flushIntervalMs: 5000 });
    a.trackPageView("/1");
    expect(calls).toHaveLength(0);
    vi.advanceTimersByTime(5000);
    expect(calls).toHaveLength(1);
    a.destroy();
  });
});

describe("typed track (§17.1)", () => {
  it("choice_selected: props go to properties, widget/flow from config", () => {
    const a = createAnalytics({ endpoint: ENDPOINT, appId: "app1", widgetId: "main", flowVersion: "v1" });
    a.track("choice_selected", { step: 2, choice_id: "budget_low" });
    a.flush();
    const ev = calls[0]!.body.events[0];
    expect(ev.event_name).toBe("choice_selected");
    expect(ev.widget_id).toBe("main");
    expect(ev.flow_version).toBe("v1");
    expect(ev.properties).toEqual({ step: 2, choice_id: "budget_low" });
    a.destroy();
  });

  it("recommendation_shown includes result_id", () => {
    const a = createAnalytics({ endpoint: ENDPOINT, appId: "app1", widgetId: "main", flowVersion: "v1" });
    a.track("recommendation_shown", { result_id: "plan_basic", step_count: 4, elapsed_ms: 8200 });
    a.flush();
    const ev = calls[0]!.body.events[0];
    expect(ev.properties).toEqual({ result_id: "plan_basic", step_count: 4, elapsed_ms: 8200 });
    a.destroy();
  });

  it("custom events via a type map need no extra function", () => {
    interface MyEvents {
      coffee_purchased: { sku: string; price: number };
    }
    const a = createAnalytics<MyEvents>({ endpoint: ENDPOINT, appId: "app1" });
    a.track("coffee_purchased", { sku: "drip_01", price: 1200 });
    a.track("page_view"); // 標準イベントも引き続き使える
    a.flush();
    const ev = calls[0]!.body.events[0];
    expect(ev.event_name).toBe("coffee_purchased");
    expect(ev.properties).toEqual({ sku: "drip_01", price: 1200 });
    a.destroy();
  });
});

describe("errors are sent immediately (§17.5)", () => {
  it("posts to /errors right away without batching", () => {
    const a = createAnalytics({ endpoint: ENDPOINT, appId: "app1" });
    a.trackError("boom", { stack: "at x", source: "main.js" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${ENDPOINT}/errors`);
    expect(calls[0]!.body.event_name).toBe("error_occurred");
    expect(calls[0]!.body.properties.message).toBe("boom");
    a.destroy();
  });
});

describe("429 backoff (§17.6)", () => {
  it("pauses sending and drops events after 429, without retrying", async () => {
    nextStatus = 429;
    nextRetryAfter = "30";
    const a = new Frontping({ endpoint: ENDPOINT, appId: "app1" });
    a.trackPageView("/1");
    await a.flush(); // 429 を受信し pauseUntil を設定
    expect(calls).toHaveLength(1);

    // 停止中: 新規イベントは送られず破棄される
    nextStatus = 202;
    a.trackPageView("/2");
    await a.flush();
    expect(calls).toHaveLength(1); // 増えない
    expect(a.droppedCount()).toBeGreaterThan(0);
    a.destroy();
  });

  it("resumes after Retry-After elapses", async () => {
    nextStatus = 429;
    nextRetryAfter = "30";
    const a = new Frontping({ endpoint: ENDPOINT, appId: "app1" });
    a.trackPageView("/1");
    await a.flush();

    // 30秒経過後は再開
    vi.advanceTimersByTime(31_000);
    nextStatus = 202;
    a.trackPageView("/2");
    await a.flush();
    expect(calls.length).toBeGreaterThanOrEqual(2);
    a.destroy();
  });
});

describe("beacon on unload (§17.4)", () => {
  it("uses sendBeacon with text/plain when page is hidden", () => {
    const beacon = vi.fn((_url: string, _data?: BodyInit | null) => true);
    let visState = "visible";
    const listeners: Record<string, () => void> = {};
    vi.stubGlobal("navigator", { sendBeacon: beacon });
    vi.stubGlobal("document", {
      get visibilityState() {
        return visState;
      },
      addEventListener: (ev: string, cb: () => void) => (listeners[ev] = cb),
      removeEventListener: () => {},
    });

    const a = new Frontping({ endpoint: ENDPOINT, appId: "app1" });
    a.trackPageView("/1");
    visState = "hidden";
    listeners["visibilitychange"]?.();

    expect(beacon).toHaveBeenCalledTimes(1);
    const blob = beacon.mock.calls[0]![1] as unknown as Blob;
    expect(blob.type).toBe("text/plain");
    expect(calls).toHaveLength(0); // fetch は使わない

    a.destroy();
  });
});

describe("injectable transport (#1)", () => {
  it("uses the provided transport without touching global fetch", async () => {
    const calls: { url: string; body: any }[] = [];
    const transport = {
      post: vi.fn(async (url: string, body: string) => {
        calls.push({ url, body: JSON.parse(body) });
        return { status: 202, retryAfterSec: null };
      }),
      beacon: vi.fn(() => true),
    };
    const a = new Frontping({ endpoint: ENDPOINT, appId: "app1", transport });
    a.trackPageView("/x");
    await a.flush();

    expect(transport.post).toHaveBeenCalledTimes(1);
    expect(calls[0]!.url).toBe(`${ENDPOINT}/events/batch`);
    expect(calls[0]!.body.events[0].event_name).toBe("page_view");
    expect(calls).toHaveLength(1);
    a.destroy();
  });

  it("pauses when the transport returns 429 (no global stubbing)", async () => {
    const transport = {
      post: vi.fn(async () => ({ status: 429, retryAfterSec: 30 })),
      beacon: vi.fn(() => true),
    };
    const a = new Frontping({ endpoint: ENDPOINT, appId: "app1", transport });
    a.trackPageView("/1");
    await a.flush();
    a.trackPageView("/2");
    await a.flush();

    expect(transport.post).toHaveBeenCalledTimes(1); // 停止中は送られない
    expect(a.droppedCount()).toBeGreaterThan(0);
    a.destroy();
  });
});
