import type { PostResult, Transport } from "./types";

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
      // ネットワーク失敗（§22.1: ユーザーに見せない）
      return null;
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
