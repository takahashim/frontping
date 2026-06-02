# frontping Worker デプロイ手順

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

## 4. secret を投入（§9.4 / §13.4 / §14.3）

```bash
# 管理API / dashboard 用トークン（app_id ごと）
echo '{"product_recommender":"<長いランダム文字列>"}' | pnpm exec wrangler secret put METRICS_TOKENS

# エラー/容量通知の webhook（任意。未設定なら通知は no-op）
pnpm exec wrangler secret put NOTIFY_WEBHOOK_URL

# IP ハッシュ用の salt（任意。設定時のみ ip_hash を保存）
pnpm exec wrangler secret put IP_HASH_SECRET
```

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
`METRICS_TOKENS` 等の Worker secret は `wrangler secret put`（手順4）で投入済みのものが使われる。

## 6. 動作確認

```bash
# 公開ホスト名は deploy 出力に表示される（例: https://frontping.<subdomain>.workers.dev）
BASE=https://frontping.<subdomain>.workers.dev

curl -s $BASE/health
# => {"ok":true}

# ダッシュボード（ブラウザで開く）。app_id と token を入力して Load
open $BASE/dashboard

# イベント1件（Origin は APP_CONFIG の allowed_origins に含まれること）
curl -s -X POST $BASE/events \
  -H 'Content-Type: application/json' -H 'Origin: https://example.com' \
  -d '{"app_id":"product_recommender","event_name":"page_view","session_id":"s","occurred_at":"2026-06-02T00:00:00.000Z","page_path":"/"}'
# => {"ok":true} (202)
```

## 7. 手動 export（任意・再実行用, §20.1）

```bash
curl -s -X POST "$BASE/admin/export?app_id=product_recommender&year=2026&month=5" \
  -H "Authorization: Bearer <metrics token>"
```

## メモ

- 月次 export は `0 4 1 * *`（UTC）で前月分を自動実行。
- 容量逼迫アラート・retention・daily_session_metrics 再計算も Cron で自動実行（§19.4）。
- 設定変更（origins / limits / token）は再デプロイ or `wrangler secret put` で反映（静的構成）。
