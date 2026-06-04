# コーヒー診断ボット — frontping サンプルアプリ

チャットボット風のウィザードで選択肢を選ぶと、最適なコーヒーの淹れ方を提案するデモ。
各操作を frontping（ローカルの Worker）にイベント送信し、エラー通知も体験できる。

```
examples/wizard/
  index.html   チャットUI（import map で @frontping/sdk を ./sdk.js に解決）
  app.js       ウィザード + frontping SDK 連携
  serve.mjs    依存ゼロの静的サーバ（/sdk.js と /config.js を配信）
```

endpoint の解決順は `?endpoint=` > `config.js`（`window.FRONTPING_ENDPOINT`）> なし。
**なし（空）の場合は送信せず UI のみ**動く（no-op transport）。

## 動かし方

### 1. frontping Worker を起動（ターミナル A）

```bash
cd worker
pnpm install
pnpm exec wrangler d1 migrations apply frontping --local   # 初回のみ
pnpm exec wrangler dev --port 8787 --local
```

`wrangler.toml` の `APP_CONFIG` に、このデモ用の `wizard_demo`
（`allowed_origins` に `http://localhost:5173` を許可）が登録済み。

### 2. SDK をビルドしてデモを起動（ターミナル B）

```bash
cd examples/wizard
pnpm run build:sdk        # ../../sdk を build して /sdk.js で配信できるようにする
pnpm start                # http://localhost:5173
```

ブラウザで http://localhost:5173 を開き、質問に答えていく。
ローカルでは `serve.mjs` が `/config.js` で endpoint=`http://localhost:8787` を注入するので、そのまま送信される
（別の Worker に向けるなら `WIZARD_ENDPOINT=https://… pnpm start` か `?endpoint=https://…`）。

## GitHub Pages で公開する

静的サイトなので Pages で公開できる。`.github/workflows/pages.yml`（手動 or main への push）が
SDK をビルドして `sdk.js` を同梱し、`config.js` を生成して `examples/wizard` を公開する。

準備:

1. リポジトリ **Settings → Pages → Source = GitHub Actions** を有効化。
2. （送信する場合のみ）リポジトリ **Variables** に `WIZARD_ENDPOINT = https://frontping.<sub>.workers.dev` を設定。
   未設定なら **UI のみ**（イベントは送られない）。
3. デプロイ済み Worker の `APP_CONFIG.wizard_demo.allowed_origins` に
   **Pages のオリジン `https://<user>.github.io`** を追加（§15。これが無いと `403`）。

公開 URL は `https://<user>.github.io/<repo>/`。秘密情報は不要（送信系はトークン認証を使わない）。
`http://localhost` には Pages（HTTPS）から送れない点に注意。

## 送信されるイベント（§6）

| 操作 | イベント |
|---|---|
| 起動 | `page_view`, `widget_opened`, `flow_started` |
| 質問表示 | `step_viewed`（step 1..3） |
| 選択 | `choice_selected`（choice_id） |
| 結果表示 | `recommendation_shown`（result_id, step_count, elapsed_ms） |
| 採用 / 却下 | `recommendation_accepted` / `recommendation_rejected` |
| もう一度 | `flow_restarted` |
| 「デモエラーを送信」ボタン | `error_occurred`（`/errors` 経由、§13 の通知対象） |

各イベントは `analytics.flush()` で即時送信される（デモ確認用）。

## 結果を確認する

ダッシュボード（要 metrics token。ローカルは `worker/.dev.vars` の `wizard_demo` トークン）:

```
http://localhost:8787/dashboard
# app_id = wizard_demo, token = local-dev-token
```

または D1 を直接:

```bash
cd worker
pnpm exec wrangler d1 execute frontping --local --command \
  "SELECT event_name, COUNT(*) FROM raw_events WHERE app_id='wizard_demo' GROUP BY event_name"
```

## エラー通知（§13）

「デモエラーを送信」を押すと `error_occurred` が `/errors` に送られる。
`worker/.dev.vars` に `NOTIFY_WEBHOOK_URL` を設定しておくと、Slack/Discord などへ実際に通知される
（未設定ならイベント保存のみ・通知は no-op）。
