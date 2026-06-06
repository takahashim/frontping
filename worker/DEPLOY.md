# frontping Worker — Deployment

English | [日本語](./DEPLOY.ja.md)

Steps for the first deployment to production (Cloudflare). Run everything from the `worker/` directory.
Creating resources and putting secrets requires your account authentication, so run each command at the
session prompt as `! <command>`, or directly in your terminal.

## 0. Prerequisites

```bash
cd worker
pnpm install
pnpm exec wrangler login        # log in via the browser
```

## 1. Create resources and note their IDs

```bash
pnpm exec wrangler d1 create frontping            # → note the database_id
pnpm exec wrangler kv namespace create RL         # → note the id
pnpm exec wrangler r2 bucket create frontping-exports
```

## 2. Set the resource IDs locally (do not touch wrangler.toml)

Do not write the real IDs into `wrangler.toml` (**it stays as placeholders so they are never committed to a public repo**).
Put the real IDs into `.env.deploy` (untracked by git); they are injected into `wrangler.generated.toml` only at deploy time.

```bash
cp .env.deploy.example .env.deploy
# Edit .env.deploy:
#   D1_DATABASE_ID=the D1 id from step 1
#   KV_RL_ID=the KV id from step 1
```

Local development (`wrangler dev --local`) works with the placeholders as-is, so you only need to set the IDs for deploy/remote operations.
Configuration changes such as `[vars] APP_CONFIG` (allowed_origins / limits …) or cron can just be edited in `wrangler.toml` and committed normally.

## 3. Apply migrations to the production D1

`config:gen` injects the real IDs from `.env.deploy` into `wrangler.generated.toml`, which is then used to apply the migrations.

```bash
pnpm run migrate:remote
```

## 4. Put secrets (§13.4 / §14.3)

```bash
# Webhook for error / capacity notifications (optional; a no-op if unset)
pnpm exec wrangler secret put NOTIFY_WEBHOOK_URL

# Salt for IP hashing (optional; ip_hash is stored only when set)
pnpm exec wrangler secret put IP_HASH_SECRET
```

## 4a. Dashboard を GitHub ログインで保護（§18.1）

`/dashboard`・`/metrics`・`/admin` を GitHub OAuth でゲートする。**設定すると有効化**され、
未設定なら従来どおりトークン認証のみで動く（後方互換）。

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

> **`ALLOWED_GITHUB_USERS` は必須**。fail-closed なので、未設定／一覧に無いユーザーは
> 403 で拒否される（誰も入れない）。自分の GitHub ユーザー名を必ず入れる。

有効化後はダッシュボードを開くと GitHub ログインへ。ログイン中は **token 欄は空でOK**
（セッション Cookie で認可）。`/dashboard/logout` でログアウト。
プログラムから `/metrics` を叩く場合は引き続き per-app トークン（下記）を使う。

## 4b. Issue metrics/admin tokens (§9.4)

`/metrics`・`/admin` の **プログラム用**トークンは **D1 の `metrics_tokens` に sha256 ハッシュで保存**する
（app ごとに独立。発行/失効が他 app に波及しない。平文は保存しない）。
※ ダッシュボード（人間）は 4a の GitHub ログインで足りるので、トークンは外部連携が要るときだけ発行。

```bash
pnpm run config:gen
# トークンを発行 → SQL をファイルに（token=平文は STDERR に1度だけ表示）
# 注: `pnpm run` はヘッダ行を stdout に出すので node を直接呼ぶ
node scripts/issue-token.mjs product_recommender > /tmp/fp-token.sql
head -1 /tmp/fp-token.sql   # INSERT で始まることを確認
# 本番 D1 に適用（--remote の確認プロンプトに答えられるよう --file で渡す）
pnpm exec wrangler d1 execute frontping --remote --config wrangler.generated.toml --file /tmp/fp-token.sql
```

> パイプ + `--command "$(cat)"` は `--remote` の確認プロンプトで固まるため使わない。

失効はその app の行を消すだけ（他に影響なし）:

```bash
pnpm exec wrangler d1 execute frontping --remote --config wrangler.generated.toml \
  --command "DELETE FROM metrics_tokens WHERE app_id='product_recommender'"
```

ローカルは `--local`（`--config` 不要）で同様に。

## 5. Deploy

```bash
pnpm run deploy   # = config:gen, then deploy with wrangler.generated.toml
```

Cron Triggers (daily / hourly / monthly) are registered automatically from `[triggers]` in `wrangler.toml`.

### Deploying from CI (GitHub Actions)

`.github/workflows/deploy.yml` (manual `workflow_dispatch`) is provided. Configure the following on GitHub:

- Repository **Variables**: `D1_DATABASE_ID`, `KV_RL_ID` (IDs are not secrets, so variables are fine)
- Repository **Secrets**: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` (for wrangler authentication)

In CI these environment variables are used instead of `.env.deploy`, and `config:gen` injects the IDs the same way.
Worker secrets such as `METRICS_TOKENS` use the values already set via `wrangler secret put` (step 4).

## 6. Verify

```bash
# The public hostname is shown in the deploy output (e.g. https://frontping.<subdomain>.workers.dev)
BASE=https://frontping.<subdomain>.workers.dev

curl -s $BASE/health
# => {"ok":true}

# Dashboard (open in a browser). Enter app_id and token, then Load
open $BASE/dashboard

# A single event (the Origin must be in the app's allowed_origins)
curl -s -X POST $BASE/events \
  -H 'Content-Type: application/json' -H 'Origin: https://example.com' \
  -d '{"app_id":"product_recommender","event_name":"page_view","session_id":"s","occurred_at":"2026-06-02T00:00:00.000Z","page_path":"/"}'
# => {"ok":true} (202)
```

## 7. Manual export (optional, for re-runs, §20.1)

```bash
curl -s -X POST "$BASE/admin/export?app_id=product_recommender&year=2026&month=5" \
  -H "Authorization: Bearer <metrics token>"
```

## Notes

- The monthly export runs at `0 4 1 * *` (UTC) for the previous month.
- Capacity alerts, retention, and daily_session_metrics recomputation also run automatically via Cron (§19.4).
- Configuration changes (origins / limits / token) take effect via redeploy or `wrangler secret put` (static configuration).
