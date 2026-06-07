# frontping Worker デプロイ手順

[English](./DEPLOY.md) | 日本語

本番（Cloudflare）への初回デプロイ手順。すべて `worker/` ディレクトリで実行する。
リソース作成・secret 投入はあなたのアカウント認証が必要なため、各コマンドはセッションのプロンプトで
`! <command>` として実行するか、ターミナルで直接実行する。

## 0. 前提

```bash
cd worker
pnpm install
pnpm exec wrangler login        # ブラウザでログイン
```

## 1. リソースを作成して ID を控える

```bash
pnpm exec wrangler d1 create frontping            # → database_id を控える
pnpm exec wrangler kv namespace create RL         # → id を控える
pnpm exec wrangler r2 bucket create frontping-exports
```

## 2. リソースID をローカルに設定する（wrangler.toml は触らない）

`wrangler.toml` には実IDを書かない（**公開リポジトリに含めないため placeholder のまま**）。
実IDは git 管理外の `.env.deploy` に入れ、deploy 時にだけ `wrangler.generated.toml` へ注入する。

```bash
cp .env.deploy.example .env.deploy
# .env.deploy を編集:
#   D1_DATABASE_ID=手順1の D1 id
#   KV_RL_ID=手順1の KV id
```

ローカル開発（`wrangler dev --local`）は placeholder のままで動くため、ID 設定は deploy/remote 操作のときだけ必要。
`[vars] APP_CONFIG`（allowed_origins / limits …）や cron などの構成変更は、`wrangler.toml` を普通に編集してコミットすればよい。

## 3. マイグレーションを本番 D1 に適用

`config:gen` が `.env.deploy` の実IDを `wrangler.generated.toml` に注入し、それを使って適用する。

```bash
pnpm run migrate:remote
```

## 4. secret を投入（§13.4 / §14.3）

```bash
# エラー/容量通知の webhook（任意。未設定なら通知は no-op）
pnpm exec wrangler secret put NOTIFY_WEBHOOK_URL

# IP ハッシュ用の salt（任意。設定時のみ ip_hash を保存）
pnpm exec wrangler secret put IP_HASH_SECRET
```

## 4a. ダッシュボードを GitHub ログインで保護（§18.1）

`/dashboard`・`/admin` を GitHub OAuth でゲートする。**secret を設定すると有効化**される。
未設定の場合、本番ではダッシュボードを開けず設定不足の案内ページを表示し、ローカル開発
（`APP_ENV=development`）のときのみ認証をバイパスする。トークン認証によるフォールバックは無い。

1. GitHub で **OAuth App** を作成（Settings → Developer settings → OAuth Apps → New）:
   - Homepage URL: `https://frontping.<sub>.workers.dev`
   - **Authorization callback URL**: `https://frontping.<sub>.workers.dev/dashboard/callback`
   - Client ID を控え、Client secret を生成。
2. secret を投入:

```bash
pnpm exec wrangler secret put GITHUB_CLIENT_ID        # OAuth App の Client ID
pnpm exec wrangler secret put GITHUB_CLIENT_SECRET    # OAuth App の Client secret
pnpm exec wrangler secret put SESSION_SECRET          # 例: openssl rand -hex 32
pnpm exec wrangler secret put ALLOWED_GITHUB_USERS    # 例: takahashim,foo,bar（カンマ区切り）
```

> **`ALLOWED_GITHUB_USERS` は必須**。fail-closed なので、未設定／一覧に無いユーザーは 403 で
> 拒否される（誰も入れない）。自分の GitHub ユーザー名を必ず入れる。

有効化後はダッシュボードを開くと GitHub ログインへ遷移する。ログイン中はセッション Cookie で認可され、
`/admin` は運用者セッションのみで操作できる。`/dashboard/logout` でログアウト。
per-app の閲覧トークン認証は廃止済みで、閲覧はダッシュボードの GitHub ログインに一本化している。

## 5. デプロイ

```bash
pnpm run deploy   # = config:gen して wrangler.generated.toml で deploy
```

Cron Triggers（日次/毎時/月次）は `wrangler.toml` の `[triggers]` から自動登録される。

### CI からデプロイする場合（GitHub Actions）

`.github/workflows/deploy.yml`（手動 `workflow_dispatch`）が用意してある。GitHub 側に以下を設定する。

- Repository **Variables**: `D1_DATABASE_ID`, `KV_RL_ID`（ID は秘密ではないので variables でよい）
- Repository **Secrets**: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`（wrangler の認証用）

CI では `.env.deploy` の代わりにこれらの環境変数が使われ、`config:gen` が同じく ID を注入する。
`SESSION_SECRET` / `GITHUB_CLIENT_ID` 等の Worker secret は `wrangler secret put`（手順4・4a）で投入済みのものが使われる。

## 6. 動作確認

```bash
# 公開ホスト名は deploy 出力に表示される（例: https://frontping.<subdomain>.workers.dev）
BASE=https://frontping.<subdomain>.workers.dev

curl -s $BASE/health
# => {"ok":true}

# ダッシュボード（ブラウザで開く）。GitHub でログインしてサービスを選ぶ
open $BASE/dashboard

# イベント1件（Origin は APP_CONFIG の allowed_origins に含まれること）
curl -s -X POST $BASE/events \
  -H 'Content-Type: application/json' -H 'Origin: https://example.com' \
  -d '{"app_id":"product_recommender","event_name":"page_view","session_id":"s","occurred_at":"2026-06-02T00:00:00.000Z","page_path":"/"}'
# => {"ok":true} (202)
```

## 7. 手動 export（任意・再実行用。db-spec.ja.md「Export」）

`/admin/export` は運用者の GitHub セッションで認可される。ログイン中のブラウザから
`fp_session` Cookie をコピーして渡す:

```bash
curl -s -X POST "$BASE/admin/export?app_id=product_recommender&year=2026&month=5" \
  -H "Cookie: fp_session=<ダッシュボードのセッション Cookie>"
```

## メモ

- 月次 export は `0 4 1 * *`（UTC）で前月分を自動実行。
- 容量逼迫アラート・retention・daily_session_metrics 再計算も Cron で自動実行（db-spec.ja.md「Retention」）。
- 設定変更（origins / limits）は再デプロイ or `wrangler secret put` で反映（静的構成）。
