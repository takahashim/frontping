import { env } from "cloudflare:test";

async function sha256hex(input: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// テスト用に metrics_tokens に1行入れる（auth と同じ sha256 ハッシュで保存）
export async function seedMetricsToken(appId: string, token: string): Promise<void> {
  await env.DB.prepare("INSERT INTO metrics_tokens (token_hash, app_id) VALUES (?, ?)")
    .bind(await sha256hex(token), appId)
    .run();
}
