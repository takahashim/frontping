# frontping Worker デプロイ手順

本番（Cloudflare）への初回デプロイ手順。すべて `worker/` ディレクトリで実行する。
リソース作成・secret 投入はあなたのアカウント認証が必要なため、各コマンドはセッションのプロンプトで
`! <command>` として実行するか、ターミナルで直接実行する。

## 0. 前提

```bash
cd worker
npm install
npx wrangler login        # ブラウザでログイン
```

## 1. リソースを作成して ID を控える

```bash
npx wrangler d1 create frontping            # → database_id を控える
npx wrangler kv namespace create RL         # → id を控える
npx wrangler r2 bucket create frontping-exports
```

## 2. wrangler.toml のプレースホルダを差し替える

- `[[d1_databases]]` の `database_id = "REPLACE_WITH_D1_ID"` → 手順1の D1 id
- `[[kv_namespaces]]` の `id = "REPLACE_WITH_KV_ID"` → 手順1の KV id
- `r2_buckets` の `bucket_name` はそのまま（`frontping-exports`）

`[vars] APP_CONFIG` を本番の app 定義に編集する（allowed_origins / limits / retention / notification）。
`compatibility_date` は実在の日付であればよい（古すぎなければ調整不要）。

## 3. マイグレーションを本番 D1 に適用

```bash
npx wrangler d1 migrations apply frontping --remote
```

## 4. secret を投入（§9.4 / §13.4 / §14.3）

```bash
# 管理API / dashboard 用トークン（app_id ごと）
echo '{"product_recommender":"<長いランダム文字列>"}' | npx wrangler secret put METRICS_TOKENS

# エラー/容量通知の webhook（任意。未設定なら通知は no-op）
npx wrangler secret put NOTIFY_WEBHOOK_URL

# IP ハッシュ用の salt（任意。設定時のみ ip_hash を保存）
npx wrangler secret put IP_HASH_SECRET
```

## 5. デプロイ

```bash
npx wrangler deploy
```

Cron Triggers（日次/毎時/月次）は `wrangler.toml` の `[triggers]` から自動登録される。

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
