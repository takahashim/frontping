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

## 4a. Protect the dashboard with GitHub login (§18.1)

Gate `/dashboard` and `/admin` behind GitHub OAuth. **Setting the secrets enables it.** When unset,
the dashboard is unavailable in production (it shows a config-incomplete page); only local development
(`APP_ENV=development`) bypasses auth. There is no token-based fallback.

1. Create a GitHub **OAuth App** (Settings → Developer settings → OAuth Apps → New):
   - Homepage URL: `https://frontping.<sub>.workers.dev`
   - **Authorization callback URL**: `https://frontping.<sub>.workers.dev/dashboard/callback`
   - Note the Client ID and generate a Client secret.
2. Put the secrets:

```bash
pnpm exec wrangler secret put GITHUB_CLIENT_ID        # OAuth App Client ID
pnpm exec wrangler secret put GITHUB_CLIENT_SECRET    # OAuth App Client secret
pnpm exec wrangler secret put SESSION_SECRET          # e.g. openssl rand -hex 32
pnpm exec wrangler secret put ALLOWED_GITHUB_USERS    # e.g. takahashim,foo,bar (comma-separated)
```

> **`ALLOWED_GITHUB_USERS` is required.** It is fail-closed: users not in the list (or when unset)
> are rejected with 403 (nobody can get in). Be sure to include your own GitHub username.

Once enabled, opening the dashboard redirects to GitHub login. While logged in, the session cookie
authorizes access; `/admin` operations require the operator session. Log out via `/dashboard/logout`.
Per-app metrics token auth has been removed — viewing is unified under the dashboard's GitHub login.

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
Worker secrets such as `SESSION_SECRET` / `GITHUB_CLIENT_ID` use the values already set via `wrangler secret put` (step 4).

## 6. Verify

```bash
# The public hostname is shown in the deploy output (e.g. https://frontping.<subdomain>.workers.dev)
BASE=https://frontping.<subdomain>.workers.dev

curl -s $BASE/health
# => {"ok":true}

# Dashboard (open in a browser). Sign in with GitHub, then pick a service
open $BASE/dashboard

# A single event (the Origin must be in the app's allowed_origins)
curl -s -X POST $BASE/events \
  -H 'Content-Type: application/json' -H 'Origin: https://example.com' \
  -d '{"app_id":"product_recommender","event_name":"page_view","session_id":"s","occurred_at":"2026-06-02T00:00:00.000Z","page_path":"/"}'
# => {"ok":true} (202)
```

## 7. Manual export (optional, for re-runs; see db-spec.ja.md "Export")

`/admin/export` is gated by the operator's GitHub session, so send the dashboard's
`fp_session` cookie (copy it from your logged-in browser):

```bash
curl -s -X POST "$BASE/admin/export?app_id=product_recommender&year=2026&month=5" \
  -H "Cookie: fp_session=<your dashboard session cookie>"
```

## Notes

- The monthly export runs at `0 4 1 * *` (UTC) for the previous month.
- Capacity alerts, retention, and daily_session_metrics recomputation also run automatically via Cron (see db-spec.ja.md "Retention").
- Configuration changes (origins / limits) take effect via redeploy or `wrangler secret put` (static configuration).
