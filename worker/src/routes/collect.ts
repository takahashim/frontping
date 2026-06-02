import type { Context } from "hono";
import type { Env, IncomingEvent, NormalizedEvent } from "../types";
import { getAppConfig } from "../lib/config";
import { checkOrigin, corsHeaders } from "../lib/cors";
import { validateEvent } from "../lib/validate";
import { normalizeEvent } from "../lib/normalize";
import { makeFingerprint } from "../lib/fingerprint";
import { checkAndCount } from "../lib/limits";
import { notifyError } from "../lib/notify";
import { writeEvents } from "../db/writes";

const MAX_BATCH = 20; // §9.2
const MAX_BODY = 64 * 1024; // 64KB

type Mode = "single" | "batch" | "error";

async function ipHash(env: Env, ip: string | null, nowIso: string): Promise<string | null> {
  if (!ip || !env.IP_HASH_SECRET) return null;
  const data = new TextEncoder().encode(nowIso.slice(0, 10) + env.IP_HASH_SECRET + ip);
  const d = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// /events・/events/batch・/errors の共通処理
export async function collect(c: Context<{ Bindings: Env }>, mode: Mode): Promise<Response> {
  const env = c.env;
  const req = c.req.raw;
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();

  // body 読み出し（beacon は text/plain。Content-Type に依存せず parse）§15.2
  const text = await req.text();
  if (text.length > MAX_BODY) return c.json({ error: "payload_too_large" }, 413);

  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }

  // イベント配列を組み立てる
  let events: IncomingEvent[];
  if (mode === "batch") {
    const arr = (body as { events?: unknown }).events;
    if (!Array.isArray(arr)) return c.json({ error: "events_not_array" }, 400);
    if (arr.length > MAX_BATCH) return c.json({ error: "batch_too_large" }, 400);
    events = arr as IncomingEvent[];
  } else {
    const ev = body as IncomingEvent;
    if (mode === "error" && !ev.event_name) ev.event_name = "error_occurred";
    events = [ev];
  }
  if (events.length === 0) return c.json({ ok: true, accepted: 0, rejected: 0 }, 202);

  // app_id 一貫性チェック（バッチは単一 app 前提）
  const appId = events[0]?.app_id;
  if (!appId) return c.json({ error: "app_id" }, 400);
  const cfg = getAppConfig(env, appId);
  if (!cfg) return c.json({ error: "invalid_app" }, 403);

  // §15 Origin 検証
  const requestOrigin = req.headers.get("Origin");
  const oc = checkOrigin(cfg, requestOrigin);
  if (!oc.ok) return c.json({ error: "forbidden_origin" }, 403);
  const cors = corsHeaders(oc.origin);

  // §16 容量チェック → ロードシェディング
  const isJsonFetch = (req.headers.get("Content-Type") ?? "").includes("application/json");
  const shed = await checkAndCount(env, appId, cfg.limits, events.length, nowMs);
  if (!shed.allowed) {
    if (isJsonFetch) {
      // §16.3 fetch 経路: 429 + Retry-After
      return c.json({ error: "rate_limited" }, 429, {
        ...cors,
        "Retry-After": String(shed.retryAfterSec ?? 60),
      });
    }
    // beacon 経路: 受理を装い静かにドロップ
    return c.json({ ok: true }, 202, cors);
  }

  // 検証 → 正規化
  const ua = req.headers.get("User-Agent");
  const ip = req.headers.get("CF-Connecting-IP");
  const hash = await ipHash(env, ip, nowIso);

  const normalized: NormalizedEvent[] = [];
  let rejected = 0;
  for (const ev of events) {
    if (ev.app_id !== appId) {
      rejected++;
      continue;
    }
    if (!validateEvent(ev).ok) {
      rejected++;
      continue;
    }
    const n = normalizeEvent(ev, nowMs);
    if (n.event_name === "error_occurred" || n.event_name === "api_failed") {
      n.fingerprint = await makeFingerprint({
        app_id: n.app_id,
        event_name: n.event_name,
        page_path: n.page_path,
        message: n.message ?? "",
        source: n.source,
      });
    }
    normalized.push(n);
  }

  // §25.7 1 batch で書き込み
  await writeEvents(env.DB, normalized, { userAgent: ua, ipHash: hash });

  // §13 エラー通知（応答を待たせない）
  for (const n of normalized) {
    if ((n.event_name === "error_occurred" || n.event_name === "api_failed") && n.fingerprint) {
      c.executionCtx.waitUntil(
        notifyError(
          env,
          cfg,
          {
            app_id: n.app_id,
            event_name: n.event_name,
            page_path: n.page_path,
            message: n.message ?? "",
            fingerprint: n.fingerprint,
            occurred_at: n.occurred_at,
          },
          nowIso
        )
      );
    }
  }

  // §9.1/§9.2 成功は常に 202
  const accepted = normalized.length;
  return c.json(mode === "batch" ? { ok: true, accepted, rejected } : { ok: true }, 202, cors);
}
