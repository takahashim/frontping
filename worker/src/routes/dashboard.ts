import type { Context } from "hono";
import type { Env } from "../types";
import { getAllConfigs } from "../lib/config";
import { githubOAuthStatus, getSession, startLogin, devAuthBypass } from "./oauth";
import { renderConfigError } from "../views/notices";
import { renderDashboardPage, type DashboardDetail } from "../views/dashboard";
import { querySummary, queryTimeseries } from "../db/metrics";

const HTML_HEADERS = { "Cache-Control": "no-store", "X-Robots-Tag": "noindex" };

// §18.1 ダッシュボード。OAuth 状態でビューを出し分ける。
// - partial（CLIENT_ID はあるが不足）: 設定不足の案内
// - off（未設定）かつ本番: 設定不足の案内（本番では OAuth 必須）
// - off かつ development: 認証バイパスで一覧表示（開発用）
// - on かつ未ログイン: GitHub 認可画面へ
// - on（ログイン済み）: サービス一覧を配信
export async function getDashboard(c: Context<{ Bindings: Env }>): Promise<Response> {
  const oauth = githubOAuthStatus(c.env);

  // 設定不足は案内。off も本番（＝dev バイパス対象外）なら案内＝OAuth 設定を必須にする。
  if (oauth.state === "partial" || (oauth.state === "off" && !devAuthBypass(c.env))) {
    return c.html(renderConfigError(oauth.missing), 200, { "Cache-Control": "no-store" });
  }

  // on のときだけログインを要求。off（ローカル）はそのまま一覧を出す。
  if (oauth.state === "on" && !(await getSession(c))) return startLogin(c);

  // ここに到達するのは on(ログイン済み) または off(ローカル)。
  // ?app= があれば詳細（集計値をサーバ側で埋め込む）、無ければサービス一覧を出す。
  const apps = Object.keys(getAllConfigs(c.env));
  const app = c.req.query("app");
  const detail = app && apps.includes(app) ? await buildDetail(c.env, app, c.req.query("from"), c.req.query("to")) : null;

  return c.html(renderDashboardPage(apps, detail), 200, HTML_HEADERS);
}

// 詳細ビュー用のデータを集計する。from/to 未指定なら全期間（サマリ）。
// グラフは固定で過去24時間・過去30日。
async function buildDetail(env: Env, app: string, from?: string, to?: string): Promise<DashboardDetail> {
  const nowMs = Date.now();
  const summary = await querySummary(env, app, from || "0000-01-01", to || "9999-12-31");
  const ts24 = await queryTimeseries(env, app, "24h", nowMs);
  const ts30 = await queryTimeseries(env, app, "30d", nowMs);
  return { app, from: from ?? "", to: to ?? "", summary, ts24, ts30 };
}
