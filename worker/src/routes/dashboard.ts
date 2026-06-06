import type { Context } from "hono";
import type { Env } from "../types";
import { getAllConfigs } from "../lib/config";
import { githubOAuthStatus, getSession, startLogin, devAuthBypass } from "./oauth";
import { DASHBOARD_HTML, oauthConfigErrorHtml } from "../dashboard";

const HTML_HEADERS = { "Cache-Control": "no-store", "X-Robots-Tag": "noindex" };

// §18.1 ダッシュボード。OAuth 状態でビューを出し分ける。
// - partial（CLIENT_ID はあるが不足）: 設定不足の案内
// - off（未設定）かつ本番: 設定不足の案内（本番では OAuth 必須）
// - off かつ development: トークンモードで一覧表示（開発用）
// - on かつ未ログイン: GitHub 認可画面へ
// - on（ログイン済み）: サービス一覧を配信
export async function getDashboard(c: Context<{ Bindings: Env }>): Promise<Response> {
  const oauth = githubOAuthStatus(c.env);

  // 設定不足は案内。off も本番（＝dev バイパス対象外）なら案内＝OAuth 設定を必須にする。
  if (oauth.state === "partial" || (oauth.state === "off" && !devAuthBypass(c.env))) {
    return c.html(oauthConfigErrorHtml(oauth.missing), 200, { "Cache-Control": "no-store" });
  }

  // on のときだけログインを要求。off（ローカル）はそのまま一覧を出す。
  if (oauth.state === "on" && !(await getSession(c))) return startLogin(c);

  // ここに到達するのは on(ログイン済み) または off(ローカル)。いずれも一覧を出す。
  const apps = Object.keys(getAllConfigs(c.env));
  const html = DASHBOARD_HTML.replace("__FRONTPING_APPS__", () => JSON.stringify(apps));
  return c.html(html, 200, HTML_HEADERS);
}
