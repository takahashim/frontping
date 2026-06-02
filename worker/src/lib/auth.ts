import type { Env } from "../types";
import { getMetricsToken } from "./config";

// §9.4 /metrics・管理API の Bearer トークン認証
export function checkMetricsAuth(env: Env, appId: string, authHeader: string | null): boolean {
  const expected = getMetricsToken(env, appId);
  if (!expected) return false;
  if (!authHeader) return false;
  const m = /^Bearer\s+(.+)$/.exec(authHeader);
  if (!m) return false;
  return timingSafeEqual(m[1]!, expected);
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
