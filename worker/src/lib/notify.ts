import type { AppConfig, Env } from "../types";

// §13 エラー通知 + dedupe。§25.4 dedupe なしの送信は禁止。

export interface NotifyPayload {
  app_id: string;
  event_name: string;
  page_path: string;
  message: string;
  fingerprint: string;
  occurred_at: string;
}

// 抑制中か判定する（§13.3）。抑制中なら count を増やして false。
// 送信可なら true を返すが、last_notified_at はまだ進めない（送信成功後に markNotified で確定）。
async function claimNotify(
  env: Env,
  appId: string,
  fingerprint: string,
  dedupeMinutes: number,
  nowIso: string
): Promise<boolean> {
  const row = await env.DB.prepare(
    "SELECT last_notified_at FROM notification_dedupes WHERE app_id = ? AND fingerprint = ?"
  )
    .bind(appId, fingerprint)
    .first<{ last_notified_at: string }>();

  if (row) {
    const last = Date.parse(row.last_notified_at);
    if (Date.parse(nowIso) - last < dedupeMinutes * 60000) return false; // 抑制中
  }
  return true;
}

// 送信成功後に last_notified_at を確定する（送信前には呼ばない）。
async function markNotified(env: Env, appId: string, fingerprint: string, nowIso: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO notification_dedupes (app_id, fingerprint, last_notified_at)
     VALUES (?, ?, ?)
     ON CONFLICT(app_id, fingerprint) DO UPDATE SET last_notified_at = excluded.last_notified_at`
  )
    .bind(appId, fingerprint, nowIso)
    .run();
}

// 抑制を通したうえで送信し、成功時のみ dedupe を確定する。
// 送信が失敗（throw）した場合は last_notified_at を進めない＝次回は抑制されない。
async function notifyOnce(
  env: Env,
  appId: string,
  fingerprint: string,
  dedupeMinutes: number,
  nowIso: string,
  text: string
): Promise<void> {
  if (!(await claimNotify(env, appId, fingerprint, dedupeMinutes, nowIso))) return;
  await postWebhook(env, text);
  await markNotified(env, appId, fingerprint, nowIso);
}

// webhook へテキストを送る（未設定なら no-op）。非2xx は失敗として throw する
// （呼び出し側 notifyOnce が dedupe を確定しないため、復旧後に再送される）。
export async function postWebhook(env: Env, text: string): Promise<void> {
  if (!env.NOTIFY_WEBHOOK_URL) return;
  const res = await fetch(env.NOTIFY_WEBHOOK_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) throw new Error(`webhook responded ${res.status}`);
}

export async function notifyError(
  env: Env,
  cfg: AppConfig,
  p: NotifyPayload,
  nowIso: string
): Promise<void> {
  if (!cfg.notification.enabled) return;
  // §13.4 通知本文。raw IP / token / query string 等は含めない。
  const text = [
    `[frontping] ${p.event_name}`,
    `app_id: ${p.app_id}`,
    `page_path: ${p.page_path}`,
    `message: ${p.message}`,
    `fingerprint: ${p.fingerprint}`,
    `occurred_at: ${p.occurred_at}`,
  ].join("\n");
  await notifyOnce(env, p.app_id, p.fingerprint, cfg.notification.dedupe_minutes, nowIso, text);
}

// §16.4 容量逼迫アラート。fingerprint='capacity:<種別>' で別系統 dedupe。
export async function notifyCapacity(
  env: Env,
  cfg: AppConfig,
  appId: string,
  limitKind: string,
  current: number,
  limit: number,
  nowIso: string
): Promise<void> {
  if (!cfg.notification.enabled) return;
  const pct = Math.round((current / limit) * 100);
  const text = `[frontping] capacity warning\napp_id: ${appId}\nlimit: ${limitKind}\ncurrent: ${current} / ${limit} (${pct}%)`;
  await notifyOnce(env, appId, `capacity:${limitKind}`, cfg.notification.capacity_dedupe_minutes, nowIso, text);
}

// 運用ジョブ（Cron 等）の失敗通知。app 横断なので予約 app_id '__ops__' で dedupe する（§25.4）。
export async function notifyOps(
  env: Env,
  key: string,
  text: string,
  nowIso: string,
  dedupeMinutes = 60
): Promise<void> {
  await notifyOnce(env, "__ops__", key, dedupeMinutes, nowIso, text);
}
