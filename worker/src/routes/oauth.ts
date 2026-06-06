import type { Context } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import type { Env } from "../types";
import { signSession, verifySession, type Session } from "../lib/session";

// ダッシュボードの GitHub OAuth ログイン。
// 未設定環境（GITHUB_* / SESSION_SECRET なし）では無効＝従来どおりトークン認証で動作。

const SESSION_COOKIE = "fp_session";
const STATE_COOKIE = "fp_oauth_state";
const SESSION_TTL_SEC = 7 * 24 * 60 * 60;

type Ctx = Context<{ Bindings: Env }>;

// セッション検証が可能か（SESSION_SECRET があれば）
export function sessionEnabled(env: Env): boolean {
  return !!env.SESSION_SECRET;
}

// 完全な GitHub ログインが可能か
export function githubAuthEnabled(env: Env): boolean {
  return !!env.GITHUB_CLIENT_ID && !!env.GITHUB_CLIENT_SECRET && !!env.SESSION_SECRET;
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

export function logout(c: Ctx): Response {
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
  return c.redirect("/dashboard", 302);
}
