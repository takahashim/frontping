import { SELF, env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { githubOAuthStatus } from "../src/routes/oauth";
import type { Env } from "../src/types";

describe("githubOAuthStatus (設定の完全性)", () => {
  const full = {
    GITHUB_CLIENT_ID: "id",
    GITHUB_CLIENT_SECRET: "secret",
    SESSION_SECRET: "sess",
    ALLOWED_GITHUB_USERS: "takahashim",
  } as unknown as Env;

  it("off when nothing is set", () => {
    expect(githubOAuthStatus({} as Env).state).toBe("off");
  });
  it("on when all four are set", () => {
    expect(githubOAuthStatus(full).state).toBe("on");
  });
  it("partial (with missing list) when some are missing", () => {
    const r = githubOAuthStatus({ ...full, SESSION_SECRET: undefined } as Env);
    expect(r.state).toBe("partial");
    expect(r.missing).toContain("SESSION_SECRET");
  });
});

describe("GET /dashboard (§18.1)", () => {
  // OAuth 未設定 ＋ APP_ENV=development（ローカル開発扱い）→ 一覧を出す
  it("serves the dashboard and injects the service list in development", async () => {
    env.APP_ENV = "development";
    const res = await SELF.fetch("https://worker.test/dashboard");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/html");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const html = await res.text();
    expect(html).toContain("frontping dashboard");
    expect(html).toContain("/metrics?");
    expect(html).not.toContain("__FRONTPING_APPS__"); // placeholder は置換済み
    expect(html).toContain("test_app"); // APP_CONFIG のキーが一覧に注入される
    expect(html).toContain("test_app_low");
  });

  // OAuth 未設定かつ APP_ENV=production（本番）→ 設定不足の案内を必ず出す
  it("shows the config-incomplete page in production when OAuth is unset", async () => {
    const res = await SELF.fetch("https://worker.test/dashboard");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("設定が未完了");
    expect(html).toContain("GITHUB_CLIENT_ID"); // 未設定項目が列挙される
    expect(html).not.toContain("test_app"); // 一覧は出さない
  });
});

describe("GET /dashboard/logout (GitHub 連携解除へ誘導)", () => {
  it("clears the session cookie and guides to GitHub's app connection page", async () => {
    const res = await SELF.fetch("https://worker.test/dashboard/logout", {
      headers: { Cookie: "fp_session=anything" },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    // GitHub の連携管理ページへ誘導する文言・リンク
    expect(html).toContain("GitHub で連携を解除する");
    expect(html).toContain("github.com/settings/"); // CLIENT_ID 未設定時は一覧ページへフォールバック
    // 「ログアウトしました」と言い切らない
    expect(html).not.toContain("ログアウトしました");
    // セッション Cookie を失効させる
    expect(res.headers.get("Set-Cookie") ?? "").toContain("fp_session=");
  });
});
