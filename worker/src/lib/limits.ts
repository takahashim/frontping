import type { AppLimits, Env } from "../types";

// §16.2 総量上限の KV 概算カウンタ。
// 注意: KV には atomic increment が無いため、並行更新で取りこぼし得る＝過少カウント寄り。
// spec の「概算でよい・低コスト優先」に沿った割り切り。厳密化が必要なら Durable Objects へ。

export interface ShedDecision {
  allowed: boolean;
  retryAfterSec?: number; // §16.3 fetch 経路で 429 + Retry-After に使う
}

function minuteKey(appId: string, nowMs: number): string {
  return `rl:min:${appId}:${Math.floor(nowMs / 60000)}`;
}
function dayKey(appId: string, nowMs: number): string {
  return `rl:day:${appId}:${Math.floor(nowMs / 86400000)}`;
}

async function bump(kv: KVNamespace, key: string, by: number, ttl: number): Promise<number> {
  const cur = Number((await kv.get(key)) ?? "0");
  const next = cur + by;
  // get→put の間は非アトミック（概算）
  await kv.put(key, String(next), { expirationTtl: ttl });
  return next;
}

// イベント受理前に総量上限を判定し、超過していれば静かにドロップさせる（§16.3）
export async function checkAndCount(
  env: Env,
  appId: string,
  limits: AppLimits,
  count: number,
  nowMs: number
): Promise<ShedDecision> {
  const min = await bump(env.RL, minuteKey(appId, nowMs), count, 120);
  if (min > limits.events_per_minute) {
    const secToNextMinute = 60 - Math.floor((nowMs % 60000) / 1000);
    return { allowed: false, retryAfterSec: Math.max(1, secToNextMinute) };
  }

  const day = await bump(env.RL, dayKey(appId, nowMs), count, 2 * 86400);
  if (day > limits.events_per_day) {
    const secToNextDay = Math.ceil((86400000 - (nowMs % 86400000)) / 1000);
    return { allowed: false, retryAfterSec: secToNextDay };
  }

  return { allowed: true };
}
