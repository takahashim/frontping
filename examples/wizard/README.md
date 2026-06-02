# コーヒー診断ボット — frontping サンプルアプリ

チャットボット風のウィザードで選択肢を選ぶと、最適なコーヒーの淹れ方を提案するデモ。
各操作を frontping（ローカルの Worker）にイベント送信し、エラー通知も体験できる。

```
examples/wizard/
  index.html   チャットUI
  app.js       ウィザード + frontping SDK 連携
  serve.mjs    依存ゼロの静的サーバ（/sdk.js で SDK 成果物を配信）
```

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
