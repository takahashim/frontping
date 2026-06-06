import { SELF, env } from "cloudflare:test";
import { describe, it, expect, vi, afterEach } from "vitest";
import { githubOAuthStatus } from "../src/routes/oauth";
import { signSession } from "../src/lib/session";
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

describe("GET /dashboard/logout (GitHub grant 取り消し)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("revokes the GitHub grant, clears the token, and shows the logged-out page", async () => {
    // ログイン済み相当: 有効なセッション Cookie ＋ KV に access_token を保持
    const cookie = await signSession({ login: "takahashim", exp: Date.now() + 60000 }, "test-session-secret");
    await env.RL.put("gh_token:takahashim", "gho_secret_token");

    // GitHub revoke 呼び出しを捕捉
    const calls: Array<{ url: string; method?: string; body?: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo, init?: RequestInit) => {
        calls.push({ url: String(input), method: init?.method, body: init?.body as string });
        return new Response(null, { status: 204 });
      })
    );

    const res = await SELF.fetch("https://worker.test/dashboard/logout", {
      headers: { Cookie: `fp_session=${cookie}` },
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("ログアウトしました");

    // grant revoke が呼ばれ、保持トークンが渡る
    const revoke = calls.find((c) => c.url.includes("/applications/") && c.url.endsWith("/grant"));
    expect(revoke).toBeDefined();
    expect(revoke!.method).toBe("DELETE");
    expect(revoke!.body).toContain("gho_secret_token");

    // KV のトークンは削除済み
    expect(await env.RL.get("gh_token:takahashim")).toBeNull();
  });

  it("still shows the logged-out page when there is no session", async () => {
    const res = await SELF.fetch("https://worker.test/dashboard/logout");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("ログアウトしました");
  });
});
