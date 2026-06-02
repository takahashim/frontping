import type { AnalyticsConfig, ErrorOptions, EventPayload, Transport, TrackOptions } from "./types";
import { DomTransport } from "./transport";
import { Backoff } from "./backoff";

export type { AnalyticsConfig, TrackOptions, ErrorOptions, EventPayload, Transport, PostResult } from "./types";
export { DomTransport } from "./transport";

const DEFAULT_MAX_BATCH = 20;
const DEFAULT_FLUSH_MS = 5000;

function nowMs(): number {
  return Date.now();
}

function genSessionId(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  // 非対応環境向けフォールバック
  return "sess_" + Math.random().toString(36).slice(2) + nowMs().toString(36);
}

// §25.2 と一貫: クライアント側でも query string / fragment を落とす
function stripPath(path: string | undefined): string | undefined {
  if (path == null) return undefined;
  let p = path;
  const h = p.indexOf("#");
  if (h >= 0) p = p.slice(0, h);
  const q = p.indexOf("?");
  if (q >= 0) p = p.slice(0, q);
  return p;
}

function currentPath(): string | undefined {
  const loc = (globalThis as { location?: Location }).location;
  return loc ? stripPath(loc.pathname) : undefined;
}

/**
 * frontping アナリティクスクライアント。
 * - イベントはキューに溜め、5秒間隔・離脱時に flush（§17.5）
 * - エラーは即時送信（§17.5）
 * - 429 を受けたら Retry-After の間は送信停止しイベントを破棄（リトライしない, §17.6）
 */
export class Frontping {
  private readonly cfg: Required<Pick<AnalyticsConfig, "endpoint" | "appId" | "maxBatch" | "flushIntervalMs" | "useBeacon">> &
    AnalyticsConfig;
  private readonly sessionId: string;
  private readonly transport: Transport;
  private readonly backoff = new Backoff();
  private queue: EventPayload[] = [];
  private dropped = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private unloadHandlers: Array<() => void> = [];

  constructor(config: AnalyticsConfig) {
    this.cfg = {
      maxBatch: DEFAULT_MAX_BATCH,
      flushIntervalMs: DEFAULT_FLUSH_MS,
      useBeacon: true,
      ...config,
      endpoint: config.endpoint.replace(/\/+$/, ""),
    };
    this.transport = config.transport ?? new DomTransport();
    this.sessionId = genSessionId();
    this.startTimer();
    this.registerUnload();
  }

  /** 任意イベントを送る（許可イベント名は Worker 側で検証） */
  track(eventName: string, opts: TrackOptions = {}): void {
    this.enqueue(this.build(eventName, opts));
  }

  /** 複数イベントをまとめてキューに積む */
  trackBatch(events: Array<{ eventName: string } & TrackOptions>): void {
    for (const e of events) {
      const { eventName, ...opts } = e;
      this.enqueue(this.build(eventName, opts));
    }
  }

  trackPageView(pagePath?: string): void {
    this.track("page_view", { pagePath });
  }

  trackClick(targetId: string, pagePath?: string): void {
    this.track("click", { pagePath, properties: { target_id: targetId } });
  }

  /** エラーは即時送信（/errors）。429 中は破棄。 */
  trackError(message: string, opts: ErrorOptions = {}): void {
    if (this.backoff.paused()) {
      this.dropped++;
      return;
    }
    const payload = this.build("error_occurred", {
      pagePath: opts.pagePath,
      properties: {
        message,
        ...(opts.stack ? { stack: opts.stack } : {}),
        ...(opts.source ? { source: opts.source } : {}),
        ...(opts.fingerprint ? { fingerprint: opts.fingerprint } : {}),
        ...(opts.properties ?? {}),
      },
    });
    void this.send(`${this.cfg.endpoint}/errors`, JSON.stringify(payload));
  }

  /** キューを即時 flush（手動）。完了を待ちたい場合は await できる。 */
  flush(): Promise<void> {
    return this.flushInternal(false);
  }

  /** タイマー解除・リスナ解除（テスト/SPA 破棄時） */
  destroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const off of this.unloadHandlers) off();
    this.unloadHandlers = [];
  }

  /** 破棄されたイベント数（デバッグ用） */
  droppedCount(): number {
    return this.dropped;
  }

  // ---- 内部 ----

  private build(eventName: string, opts: TrackOptions): EventPayload {
    const widgetId = opts.widgetId ?? this.cfg.widgetId;
    const flowVersion = opts.flowVersion ?? this.cfg.flowVersion;
    const payload: EventPayload = {
      app_id: this.cfg.appId,
      event_name: eventName,
      session_id: this.sessionId,
      occurred_at: opts.occurredAt ?? new Date().toISOString(),
    };
    const pagePath = stripPath(opts.pagePath) ?? currentPath();
    if (pagePath != null) payload.page_path = pagePath;
    if (widgetId != null) payload.widget_id = widgetId;
    if (flowVersion != null) payload.flow_version = flowVersion;
    if (opts.properties) payload.properties = opts.properties;
    return payload;
  }

  private enqueue(ev: EventPayload): void {
    if (this.backoff.paused()) {
      this.dropped++;
      return;
    }
    this.queue.push(ev);
    if (this.queue.length >= this.cfg.maxBatch) void this.flushInternal(false);
  }

  private async flushInternal(useBeacon: boolean): Promise<void> {
    if (this.queue.length === 0) return;
    if (this.backoff.paused()) {
      // 停止中はキューを破棄（無限堆積させない, §17.6）
      this.dropped += this.queue.length;
      this.queue = [];
      return;
    }
    const batch = this.queue.splice(0, this.cfg.maxBatch);
    const url = `${this.cfg.endpoint}/events/batch`;
    const body = JSON.stringify({ events: batch });

    if (useBeacon && this.cfg.useBeacon && this.transport.beacon(url, body)) return;
    await this.send(url, body);
  }

  // 送信し、429 ならバックオフ。リトライはしない（§17.6 / §22.1）。
  private async send(url: string, body: string): Promise<void> {
    const res = await this.transport.post(url, body);
    if (res?.status === 429) {
      const sec = res.retryAfterSec ?? 60;
      this.backoff.pauseForSec(sec);
      if (this.cfg.debug) console.warn(`[frontping] rate limited, pausing ${sec}s`);
    }
    // 他の非2xx・ネットワーク失敗もリトライしない（握りつぶす）
  }

  private startTimer(): void {
    const g = globalThis as { setInterval?: typeof setInterval };
    if (typeof g.setInterval !== "function") return;
    this.timer = setInterval(() => void this.flushInternal(false), this.cfg.flushIntervalMs);
    // node 等で process を保持しないように
    (this.timer as { unref?: () => void })?.unref?.();
  }

  // §17.5 visibilitychange / pagehide で beacon flush
  private registerUnload(): void {
    const doc = (globalThis as { document?: Document }).document;
    const win = globalThis as {
      addEventListener?: typeof addEventListener;
      removeEventListener?: typeof removeEventListener;
    };
    if (doc && typeof doc.addEventListener === "function") {
      const onVis = (): void => {
        if (doc.visibilityState === "hidden") void this.flushInternal(true);
      };
      doc.addEventListener("visibilitychange", onVis);
      this.unloadHandlers.push(() => doc.removeEventListener("visibilitychange", onVis));
    }
    if (typeof win.addEventListener === "function") {
      const onHide = (): void => void this.flushInternal(true);
      win.addEventListener("pagehide", onHide);
      this.unloadHandlers.push(() => win.removeEventListener?.("pagehide", onHide));
    }
  }
}

/** 型付きラッパー付きのアナリティクスを生成する（§17.1） */
export function createAnalytics(config: AnalyticsConfig) {
  const fp = new Frontping(config);
  return {
    core: fp,
    track: fp.track.bind(fp),
    trackBatch: fp.trackBatch.bind(fp),
    trackPageView: fp.trackPageView.bind(fp),
    trackClick: fp.trackClick.bind(fp),
    trackError: fp.trackError.bind(fp),
    flush: fp.flush.bind(fp),
    destroy: fp.destroy.bind(fp),

    // --- アプリ固有イベントの型付きラッパー ---
    widgetOpened: (a: { widgetId?: string; flowVersion?: string } = {}) =>
      fp.track("widget_opened", a),
    flowStarted: (a: { widgetId?: string; flowVersion?: string } = {}) =>
      fp.track("flow_started", a),
    stepViewed: (a: { step: number; widgetId?: string; flowVersion?: string }) =>
      fp.track("step_viewed", { widgetId: a.widgetId, flowVersion: a.flowVersion, properties: { step: a.step } }),
    choiceSelected: (a: { step: number; choiceId: string; widgetId?: string; flowVersion?: string }) =>
      fp.track("choice_selected", {
        widgetId: a.widgetId,
        flowVersion: a.flowVersion,
        properties: { step: a.step, choice_id: a.choiceId },
      }),
    recommendationShown: (a: {
      resultId: string;
      stepCount?: number;
      elapsedMs?: number;
      widgetId?: string;
      flowVersion?: string;
    }) =>
      fp.track("recommendation_shown", {
        widgetId: a.widgetId,
        flowVersion: a.flowVersion,
        properties: {
          result_id: a.resultId,
          ...(a.stepCount != null ? { step_count: a.stepCount } : {}),
          ...(a.elapsedMs != null ? { elapsed_ms: a.elapsedMs } : {}),
        },
      }),
    recommendationAccepted: (a: { resultId?: string; widgetId?: string; flowVersion?: string } = {}) =>
      fp.track("recommendation_accepted", {
        widgetId: a.widgetId,
        flowVersion: a.flowVersion,
        properties: a.resultId ? { result_id: a.resultId } : {},
      }),
    recommendationRejected: (a: { resultId?: string; widgetId?: string; flowVersion?: string } = {}) =>
      fp.track("recommendation_rejected", {
        widgetId: a.widgetId,
        flowVersion: a.flowVersion,
        properties: a.resultId ? { result_id: a.resultId } : {},
      }),
    flowRestarted: (a: { widgetId?: string; flowVersion?: string } = {}) =>
      fp.track("flow_restarted", a),
  };
}

export type Analytics = ReturnType<typeof createAnalytics>;
