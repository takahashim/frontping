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

// 同一 app_id + fingerprint の通知を dedupe_minutes に1回までに抑制する（§13.3）
async function shouldNotify(
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

  const nowMs = Date.parse(nowIso);
  if (row) {
    const last = Date.parse(row.last_notified_at);
    if (nowMs - last < dedupeMinutes * 60000) {
      // 抑制中: count だけ増やす
      await env.DB.prepare(
        "UPDATE notification_dedupes SET count = count + 1 WHERE app_id = ? AND fingerprint = ?"
      )
        .bind(appId, fingerprint)
        .run();
      return false;
    }
    await env.DB.prepare(
      "UPDATE notification_dedupes SET last_notified_at = ?, count = count + 1 WHERE app_id = ? AND fingerprint = ?"
    )
      .bind(nowIso, appId, fingerprint)
      .run();
    return true;
  }

  await env.DB.prepare(
    "INSERT INTO notification_dedupes (app_id, fingerprint, last_notified_at, count) VALUES (?, ?, ?, 1)"
  )
    .bind(appId, fingerprint, nowIso)
    .run();
  return true;
}

async function send(env: Env, text: string): Promise<void> {
  if (!env.NOTIFY_WEBHOOK_URL) return;
  await fetch(env.NOTIFY_WEBHOOK_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }),
  });
}

export async function notifyError(
  env: Env,
  cfg: AppConfig,
  p: NotifyPayload,
  nowIso: string
): Promise<void> {
  if (!cfg.notification.enabled) return;
  if (!(await shouldNotify(env, p.app_id, p.fingerprint, cfg.notification.dedupe_minutes, nowIso))) {
    return;
  }
  // §13.4 通知本文。raw IP / token / query string 等は含めない。
  const text = [
    `[frontping] ${p.event_name}`,
    `app_id: ${p.app_id}`,
    `page_path: ${p.page_path}`,
    `message: ${p.message}`,
    `fingerprint: ${p.fingerprint}`,
    `occurred_at: ${p.occurred_at}`,
  ].join("\n");
  await send(env, text);
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
  const fp = `capacity:${limitKind}`;
  if (!(await shouldNotify(env, appId, fp, cfg.notification.capacity_dedupe_minutes, nowIso))) {
    return;
  }
  const pct = Math.round((current / limit) * 100);
  await send(
    env,
    `[frontping] capacity warning\napp_id: ${appId}\nlimit: ${limitKind}\ncurrent: ${current} / ${limit} (${pct}%)`
  );
}
