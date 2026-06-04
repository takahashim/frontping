import type {
  AnalyticsConfig,
  ErrorOptions,
  EventMap,
  EventPayload,
  PostResult,
  StandardEvents,
  Transport,
} from "./types";

export type {
  AnalyticsConfig,
  ErrorOptions,
  EventPayload,
  EventMap,
  EventProps,
  StandardEvents,
  Transport,
  PostResult,
} from "./types";

const DEFAULT_MAX_BATCH = 20;
const DEFAULT_FLUSH_MS = 5000;

// /errors へ即時送信するイベント（§17.5）
const ERROR_EVENTS = new Set(["error_occurred", "api_failed"]);

function nowMs(): number {
  return Date.now();
}

// §17.6 429 バックオフの状態を1か所に集約する値オブジェクト。
class Backoff {
  private until = 0;
  paused(): boolean {
    return nowMs() < this.until;
  }
  pauseForSec(sec: number): void {
    this.until = nowMs() + sec * 1000;
  }
}

// 環境グローバル（fetch / sendBeacon）への依存をこの実装に閉じ込める。
// 非ブラウザ環境やテストでは AnalyticsConfig.transport で差し替える。
export class DomTransport implements Transport {
  async post(url: string, body: string): Promise<PostResult | null> {
    const f = (globalThis as { fetch?: typeof fetch }).fetch;
    if (!f) return null;
    try {
      const res = await f(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        keepalive: true,
      });
      const ra = Number(res.headers.get("Retry-After"));
      return { status: res.status, retryAfterSec: Number.isFinite(ra) && ra > 0 ? ra : null };
    } catch {
      return null; // ネットワーク失敗（§22.1: ユーザーに見せない）
    }
  }

  // §15.2 / §17.4 beacon は text/plain で送る（プリフライト回避）
  beacon(url: string, body: string): boolean {
    const nav = (globalThis as { navigator?: Navigator }).navigator;
    if (nav && typeof nav.sendBeacon === "function") {
      try {
        return nav.sendBeacon(url, new Blob([body], { type: "text/plain" }));
      } catch {
        return false;
      }
    }
    return false;
  }
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
 * frontping アナリティクスクライアント（低レベル）。通常は createAnalytics を使う。
 * - 通常イベントはキューに溜め、5秒間隔・離脱時に flush（§17.5）
 * - error_occurred / api_failed は即時送信（§17.5）
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

  /** イベントを送る。error 系は即時、それ以外はバッチ。 */
  track(eventName: string, props: Record<string, unknown> = {}): void {
    this.dispatch(eventName, props);
  }

  trackPageView(pagePath?: string): void {
    this.dispatch("page_view", {}, pagePath);
  }

  trackClick(targetId: string, pagePath?: string): void {
    this.dispatch("click", { target_id: targetId }, pagePath);
  }

  /** エラーは即時送信（/errors）。429 中は破棄。 */
  trackError(message: string, opts: ErrorOptions = {}): void {
    this.dispatch(
      "error_occurred",
      {
        message,
        ...(opts.stack ? { stack: opts.stack } : {}),
        ...(opts.source ? { source: opts.source } : {}),
        ...(opts.fingerprint ? { fingerprint: opts.fingerprint } : {}),
        ...(opts.properties ?? {}),
      },
      opts.pagePath
    );
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

  private dispatch(eventName: string, props: Record<string, unknown>, pageOverride?: string): void {
    if (ERROR_EVENTS.has(eventName)) {
      // §17.5 エラーは即時送信
      if (this.backoff.paused()) {
        this.dropped++;
        return;
      }
      void this.send(`${this.cfg.endpoint}/errors`, JSON.stringify(this.build(eventName, props, pageOverride)));
      return;
    }
    this.enqueue(this.build(eventName, props, pageOverride));
  }

  private build(eventName: string, props: Record<string, unknown>, pageOverride?: string): EventPayload {
    const payload: EventPayload = {
      app_id: this.cfg.appId,
      event_name: eventName,
      session_id: this.sessionId,
      occurred_at: new Date().toISOString(),
    };
    const pagePath = pageOverride !== undefined ? stripPath(pageOverride) : currentPath();
    if (pagePath != null) payload.page_path = pagePath;
    if (this.cfg.widgetId != null) payload.widget_id = this.cfg.widgetId;
    if (this.cfg.flowVersion != null) payload.flow_version = this.cfg.flowVersion;
    if (Object.keys(props).length > 0) payload.properties = props;
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

// props が「全て任意 or 空」のとき第2引数を省略可能にする
type TrackArgs<P> = Record<string, never> extends P ? [props?: P] : [props: P];

/**
 * 型付きアナリティクス。イベント名と properties が型 E でチェックされる。
 * イベントごとに関数を増やす必要はない（track 1本で済む）。
 */
export interface Analytics<E> {
  /** イベント送信。name と props が E で型チェックされる。 */
  track<K extends keyof E>(name: K, ...args: TrackArgs<E[K]>): void;
  trackPageView(pagePath?: string): void;
  trackClick(targetId: string, pagePath?: string): void;
  trackError(message: string, opts?: ErrorOptions): void;
  flush(): Promise<void>;
  destroy(): void;
  droppedCount(): number;
  /** 低レベル実体（エスケープハッチ） */
  readonly core: Frontping;
}

/**
 * アナリティクスを生成する（§17.1）。
 *
 * 標準イベントは型なしで使える:
 *   const a = createAnalytics({ endpoint, appId, widgetId, flowVersion });
 *   a.track("choice_selected", { step: 1, choice_id: "budget_low" });
 *
 * アプリ固有イベントは型マップを1つ渡すだけ（関数追加不要）:
 *   type MyEvents = { coffee_purchased: { sku: string; price: number } };
 *   const a = createAnalytics<MyEvents>({ ... });
 *   a.track("coffee_purchased", { sku: "drip_01", price: 1200 });
 */
export function createAnalytics<E = Record<string, never>>(
  config: AnalyticsConfig
): Analytics<StandardEvents & E> {
  const fp = new Frontping(config);
  return {
    track<K extends keyof (StandardEvents & E)>(name: K, ...args: TrackArgs<(StandardEvents & E)[K]>): void {
      fp.track(name as string, (args[0] ?? {}) as Record<string, unknown>);
    },
    trackPageView: (p?: string) => fp.trackPageView(p),
    trackClick: (id: string, p?: string) => fp.trackClick(id, p),
    trackError: (m: string, o?: ErrorOptions) => fp.trackError(m, o),
    flush: () => fp.flush(),
    destroy: () => fp.destroy(),
    droppedCount: () => fp.droppedCount(),
    core: fp,
  };
}
