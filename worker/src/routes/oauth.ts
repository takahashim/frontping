import type { Context } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import type { Env } from "../types";
import { signSession, verifySession, SESSION_TTL_SEC, type Session } from "../lib/session";
import { isDevEnv } from "../lib/local";
import { loggedOutHtml } from "../dashboard";

// ダッシュボードの GitHub OAuth ログイン。
// 未設定環境（GITHUB_* / SESSION_SECRET なし）では無効＝従来どおりトークン認証で動作。

const SESSION_COOKIE = "fp_session";
const STATE_COOKIE = "fp_oauth_state";

type Ctx = Context<{ Bindings: Env }>;

// GitHub ログインに必要な secret 一式（ALLOWED_GITHUB_USERS が無いと fail-closed で誰も入れない）
export const OAUTH_VARS = [
  "GITHUB_CLIENT_ID",
  "GITHUB_CLIENT_SECRET",
  "SESSION_SECRET",
  "ALLOWED_GITHUB_USERS",
] as const;

// off=全/大半が未設定（GITHUB_CLIENT_ID 無し）/ on=全設定（有効）/ partial=CLIENT_ID はあるが一部不足
// missing は state を問わず未設定の項目を返す（案内表示に使う）。
export function githubOAuthStatus(env: Env): { state: "off" | "partial" | "on"; missing: string[] } {
  const missing = OAUTH_VARS.filter((k) => !env[k]);
  if (missing.length === 0) return { state: "on", missing: [] };
  return { state: env.GITHUB_CLIENT_ID ? "partial" : "off", missing };
}

// ローカル開発（APP_ENV=development）かつ OAuth 完全未設定なら認証を省略してよいか。
// 本番（production/preview）では発動せず、OAuth 有効/中途半端時（state !== off）も発動しない。
// ダッシュボード UI（一覧表示）と metrics API（認可ガード）で同じ判断を共有する。
export function devAuthBypass(env: Env): boolean {
  return isDevEnv(env) && githubOAuthStatus(env).state === "off";
}

export async function getSession(c: Ctx): Promise<Session | null> {
  if (!c.env.SESSION_SECRET) return null;
  const cookie = getCookie(c, SESSION_COOKIE);
  if (!cookie) return null;
  return verifySession(cookie, c.env.SESSION_SECRET);
}

function callbackUrl(c: Ctx): string {
  return new URL(c.req.url).origin + "/dashboard/callback";
}

// GitHub の認可画面へリダイレクト（CSRF 用 state を cookie に）
export function startLogin(c: Ctx): Response {
  const state = crypto.randomUUID();
  setCookie(c, STATE_COOKIE, state, { httpOnly: true, secure: true, sameSite: "Lax", path: "/", maxAge: 600 });
  const u = new URL("https://github.com/login/oauth/authorize");
  u.searchParams.set("client_id", c.env.GITHUB_CLIENT_ID!);
  u.searchParams.set("redirect_uri", callbackUrl(c));
  u.searchParams.set("scope", "read:user");
  u.searchParams.set("state", state);
  return c.redirect(u.toString(), 302);
}

export async function handleCallback(c: Ctx): Promise<Response> {
  const code = c.req.query("code");
  const state = c.req.query("state");
  const saved = getCookie(c, STATE_COOKIE);
  deleteCookie(c, STATE_COOKIE, { path: "/" });
  if (!code || !state || !saved || state !== saved) return c.text("invalid oauth state", 400);

  // code → access_token
  const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      client_id: c.env.GITHUB_CLIENT_ID,
      client_secret: c.env.GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: callbackUrl(c),
    }),
  });
  const tok = (await tokenRes.json()) as { access_token?: string };
  if (!tok.access_token) return c.text("oauth token exchange failed", 401);

  // access_token → user.login
  const userRes = await fetch("https://api.github.com/user", {
    headers: {
      Authorization: `Bearer ${tok.access_token}`,
      "User-Agent": "frontping",
      Accept: "application/vnd.github+json",
    },
  });
  const user = (await userRes.json()) as { login?: string };
  if (!user.login) return c.text("could not read GitHub user", 401);

  // allowlist 照合（fail-closed: 未設定/不一致なら拒否）
  const allowed = (c.env.ALLOWED_GITHUB_USERS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (!allowed.includes(user.login.toLowerCase())) {
    return c.html(`<p>${user.login} はこのダッシュボードへのアクセスを許可されていません。</p>`, 403);
  }

  const value = await signSession({ login: user.login, exp: Date.now() + SESSION_TTL_SEC * 1000 }, c.env.SESSION_SECRET!);
  setCookie(c, SESSION_COOKIE, value, { httpOnly: true, secure: true, sameSite: "Lax", path: "/", maxAge: SESSION_TTL_SEC });
  return c.redirect("/dashboard", 302);
}

// GitHub の OAuth App 連携管理ページ。ユーザーがここで連携解除（Revoke）できる。
// CLIENT_ID があれば当該アプリへ直リンク、無ければ認可アプリ一覧へ。
function githubConnectionUrl(env: Env): string {
  return env.GITHUB_CLIENT_ID
    ? `https://github.com/settings/connections/applications/${env.GITHUB_CLIENT_ID}`
    : "https://github.com/settings/applications";
}

export function logout(c: Ctx): Response {
  // frontping 側のセッションを破棄（set 時と同じ属性で削除。path 一致が必須）。
  // GitHub の連携解除はこちらでは行わず、着地ページから GitHub の管理ページへ誘導する。
  deleteCookie(c, SESSION_COOKIE, { path: "/", secure: true, sameSite: "Lax" });
  return c.html(loggedOutHtml(githubConnectionUrl(c.env)), 200, { "Cache-Control": "no-store" });
}
