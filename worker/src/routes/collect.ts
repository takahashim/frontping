import type { Context } from "hono";
import type { AppConfig, Env, IncomingEvent, NormalizedEvent } from "../types";
import { getAppConfig } from "../lib/config";
import { checkOrigin, corsHeaders } from "../lib/cors";
import { validateEvent } from "../lib/validate";
import { normalizeEvent } from "../lib/normalize";
import { makeFingerprint } from "../lib/fingerprint";
import { checkAndCount, type ShedDecision } from "../lib/limits";
import { notifyError } from "../lib/notify";
import { isErrorEvent } from "../lib/events";
import { writeEvents, type WriteContext } from "../db/writes";

const MAX_BATCH = 20; // §9.2
const MAX_BODY = 64 * 1024; // 64KB

type Mode = "single" | "batch" | "error";
type Ctx = Context<{ Bindings: Env }>;

async function ipHash(env: Env, ip: string | null, nowIso: string): Promise<string | null> {
  if (!ip || !env.IP_HASH_SECRET) return null;
  const data = new TextEncoder().encode(nowIso.slice(0, 10) + env.IP_HASH_SECRET + ip);
  const d = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// body を読み、mode に応じてイベント配列を取り出す。不正なら Response を返す。
async function parseEventsRequest(c: Ctx, mode: Mode): Promise<IncomingEvent[] | Response> {
  // beacon は text/plain。Content-Type に依存せず parse（§15.2）
  const text = await c.req.raw.text();
  if (text.length > MAX_BODY) return c.json({ error: "payload_too_large" }, 413);

  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }

  if (mode === "batch") {
    const arr = (body as { events?: unknown }).events;
    if (!Array.isArray(arr)) return c.json({ error: "events_not_array" }, 400);
    if (arr.length > MAX_BATCH) return c.json({ error: "batch_too_large" }, 400);
    return arr as IncomingEvent[];
  }

  const ev = body as IncomingEvent;
  if (mode === "error" && !ev.event_name) ev.event_name = "error_occurred";
  return [ev];
}

// §16.3 ロードシェディング時の応答。fetch=429+Retry-After / beacon=静かに 202。
function shedResponse(c: Ctx, shed: ShedDecision, isJsonFetch: boolean, cors: Record<string, string>): Response {
  if (isJsonFetch) {
    return c.json({ error: "rate_limited" }, 429, { ...cors, "Retry-After": String(shed.retryAfterSec ?? 60) });
  }
  return c.json({ ok: true }, 202, cors);
}

async function attachFingerprint(n: NormalizedEvent): Promise<void> {
  n.fingerprint = await makeFingerprint({
    app_id: n.app_id,
    event_name: n.event_name,
    page_path: n.page_path,
    message: n.message ?? "",
    source: n.source,
  });
}

// 受理対象を検証・正規化し、エラーには fingerprint を付ける。app 不一致/不正は破棄。
async function prepareEvents(
  events: IncomingEvent[],
  appId: string,
  nowMs: number
): Promise<{ normalized: NormalizedEvent[]; rejected: number }> {
  const normalized: NormalizedEvent[] = [];
  let rejected = 0;
  for (const ev of events) {
    if (ev.app_id !== appId || !validateEvent(ev).ok) {
      rejected++;
      continue;
    }
    const n = normalizeEvent(ev, nowMs);
    if (isErrorEvent(n.event_name)) await attachFingerprint(n);
    normalized.push(n);
  }
  return { normalized, rejected };
}

// §13 エラー通知（応答を待たせない）
function notifyErrors(c: Ctx, cfg: AppConfig, normalized: NormalizedEvent[], nowIso: string): void {
  for (const n of normalized) {
    if (!isErrorEvent(n.event_name) || !n.fingerprint) continue;
    c.executionCtx.waitUntil(
      notifyError(
        c.env,
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

// /events・/events/batch・/errors の共通処理。各段は上のヘルパーへ委譲する。
export async function collect(c: Ctx, mode: Mode): Promise<Response> {
  const env = c.env;
  const req = c.req.raw;
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();

  const parsed = await parseEventsRequest(c, mode);
  if (parsed instanceof Response) return parsed;
  const events = parsed;
  if (events.length === 0) return c.json({ ok: true, accepted: 0, rejected: 0 }, 202);

  const appId = events[0]?.app_id;
  if (!appId) return c.json({ error: "app_id" }, 400);
  const cfg = getAppConfig(env, appId);
  if (!cfg) return c.json({ error: "invalid_app" }, 403);

  // §15 Origin 検証
  const oc = checkOrigin(cfg, req.headers.get("Origin"));
  if (!oc.ok) return c.json({ error: "forbidden_origin" }, 403);
  const cors = corsHeaders(oc.origin);

  // §16 容量チェック → ロードシェディング
  const isJsonFetch = (req.headers.get("Content-Type") ?? "").includes("application/json");
  const shed = await checkAndCount(env, appId, cfg.limits, events.length, nowMs);
  if (!shed.allowed) return shedResponse(c, shed, isJsonFetch, cors);

  // 検証・正規化 → 1 batch で書き込み（§25.7）
  const writeCtx: WriteContext = {
    userAgent: req.headers.get("User-Agent"),
    ipHash: await ipHash(env, req.headers.get("CF-Connecting-IP"), nowIso),
  };
  const { normalized, rejected } = await prepareEvents(events, appId, nowMs);
  await writeEvents(env.DB, normalized, writeCtx);
  notifyErrors(c, cfg, normalized, nowIso);

  // §9.1/§9.2 成功は常に 202
  return c.json(mode === "batch" ? { ok: true, accepted: normalized.length, rejected } : { ok: true }, 202, cors);
}
