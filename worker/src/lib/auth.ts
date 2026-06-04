import type { Env } from "../types";

// §9.4 metrics/admin の per-app トークン認証。
// トークンは DB(metrics_tokens)に sha256 ハッシュで保存し、平文は保持しない。
// app ごとに行が独立しているため、発行・失効は app 単位で他に波及しない。

async function sha256hex(input: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function verifyMetricsToken(
  env: Env,
  appId: string,
  authHeader: string | null
): Promise<boolean> {
  if (!authHeader) return false;
  const m = /^Bearer\s+(.+)$/.exec(authHeader);
  if (!m) return false;
  const hash = await sha256hex(m[1]!);
  const row = await env.DB.prepare(
    "SELECT 1 AS ok FROM metrics_tokens WHERE app_id = ? AND token_hash = ?"
  )
    .bind(appId, hash)
    .first<{ ok: number }>();
  return !!row;
}
