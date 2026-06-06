import type { Env } from "../types";
import { SESSION_TTL_SEC } from "./session";

// ダッシュボードのログインセッションに紐づく GitHub access_token の保管。
// logout 時に grant を revoke するためだけに保持する（read:user スコープ、セッション TTL で失効）。
// キー書式・正規化・TTL・保管先 binding をここ1箇所に閉じ込める。
// 保管先は rate limit 用の RL KV を間借りしている（専用 binding にするならこのファイルの参照だけ差し替える）。
const KEY_PREFIX = "gh_token:";

function key(login: string): string {
  return KEY_PREFIX + login.toLowerCase();
}

export function rememberToken(env: Env, login: string, token: string): Promise<void> {
  return env.RL.put(key(login), token, { expirationTtl: SESSION_TTL_SEC });
}

export function getToken(env: Env, login: string): Promise<string | null> {
  return env.RL.get(key(login));
}

export function forgetToken(env: Env, login: string): Promise<void> {
  return env.RL.delete(key(login));
}
