# frontping: Lightweight Analytics and Error Notification Specification

## 1. 概要

本仕様は、小規模なフロントエンドアプリケーションおよびウィジェット向けの、軽量な解析・エラー通知基盤を定義する。

初期実装では Cloudflare Workers + D1 を利用する。

### 目的

主な目的は以下である。

- ページビューを記録する
- クリック回数を記録する
- 固定選択肢型ウィジェットの利用状況を記録する
- JavaScriptエラーおよびAPI失敗を記録する
- 重要なエラーを通知する
- 短期の生イベントと長期の集計値を保持する
- 将来的にR2等へexportできる余地を残す

本システムは、PostHog、Sentry、Google Analyticsの完全な代替を目指さない。  
小規模アプリに低コストで導入できる、最小限のanalytics/error monitoring基盤を目指す。

### ポリシー

本サービスのポリシーは以下である。

- 運用する側の手間がかからないこと
    - 機能はシンプルにしつつ自動化されていること
- 利用するサービス側に悪影響がないこと
    - 適切な上限を設定し、上限を超えた場合は静かに無視すると同時に、超えそうになったら通知すること


---

## 2. 対象範囲

### 2.1 In scope

初期実装で扱う範囲は以下とする。

- イベント収集API
- ページビュー記録
- クリック記録
- ウィジェットのフローイベント記録
- JavaScriptエラー記録
- API失敗記録
- エラー通知
- D1への保存
- 日次集計
- 簡単なメトリクス取得API
- retention処理
- 手動exportを想定したデータ構造

### 2.2 Out of scope

初期実装では以下を扱わない。

- Session Replay
- Heatmap
- ユーザープロファイル管理
- A/Bテスト
- Feature Flag
- 複雑なファネルUI
- リアルタイム分析
- BIツール連携
- 大規模イベント処理
- 個人単位の長期トラッキング

---

## 3. 全体構成

```text
Frontend SDK
  ↓
Cloudflare Worker
  POST /events
  POST /events/batch
  POST /errors
  GET  /metrics
  ↓
Cloudflare D1
  raw_events
  session_summaries
  daily_event_counts
  daily_session_metrics
  error_events
  notification_dedupes
```

必要に応じて、将来的に以下を追加する。

```text
Cloudflare R2
  monthly export
  raw event archive
  error archive
```

---

## 4. 基本方針

### 4.1 カウンタだけにはしない

本システムでは、DBにカウンタのみを保存する設計にはしない。

理由は以下である。

- セッション内の順序が失われる
- 選択肢の組み合わせ分析ができない
- エラー直前の操作を追えない
- 結果表示後の再実行・採用・拒否を追いにくい
- 後から集計軸を追加できない

そのため、以下のハイブリッド構成とする。

```text
raw_events
  短期保存する生イベント

session_summaries
  セッション単位の要約

daily_event_counts
  長期保存する日次イベント集計

daily_session_metrics
  長期保存する日次セッション集計

error_events
  短期〜中期保存するエラー詳細
```

### 4.2 生イベントは短期保存

`raw_events` は詳細調査用であり、永続保存しない。

初期設定では以下とする。

```text
raw_events: 30日保存
error_events: 90日保存
session_summaries: 1年保存
daily_event_counts: 長期保存
daily_session_metrics: 長期保存
```

保存期間はアプリごとに変更可能とする。

---

## 5. イベントモデル

### 5.1 共通フィールド

すべてのイベントは、以下の共通フィールドを持つ。

| Field | Type | Required | Description |
|---|---|---:|---|
| `app_id` | string | yes | アプリケーションID |
| `event_name` | string | yes | イベント名 |
| `occurred_at` | string | yes | クライアント側で発生した時刻 |
| `session_id` | string | yes | セッションID |
| `page_path` | string | no | ページパス |
| `widget_id` | string | no | ウィジェットID |
| `flow_version` | string | no | フロー定義のバージョン |
| `properties` | object | no | イベント固有属性 |

### 5.2 命名規則

`event_name` は lowercase snake_case とする。

良い例:

```text
page_view
click
choice_selected
recommendation_shown
error_occurred
```

避ける例:

```text
PageView
page-view
clickedStartButton
buttonClicked
```

### 5.3 IDの命名規則

`target_id`, `choice_id`, `result_id` は、UI文言ではなく安定したIDを使う。

良い例:

```text
start_button
accept_result_button
budget_low
plan_basic
```

避ける例:

```text
「開始する」
button1
左の青いボタン
安いプラン
```

---

## 6. 標準イベント一覧

### 6.1 共通イベント

| Event | Description | Storage |
|---|---|---|
| `page_view` | ページが表示された | raw + daily count |
| `click` | 計測対象要素がクリックされた | raw + daily count |
| `error_occurred` | JavaScriptエラーが発生した | raw + error log + notification |
| `api_failed` | API呼び出しに失敗した | raw + error log or count |

### 6.2 ウィジェットフローイベント

| Event | Description | Storage |
|---|---|---|
| `widget_opened` | ウィジェットが表示またはアクティブ化された | raw + daily count |
| `flow_started` | ユーザーがフローを開始した | raw + daily count |
| `step_viewed` | 特定ステップが表示された | raw + daily count |
| `choice_selected` | ユーザーが固定選択肢を選んだ | raw + daily count |
| `recommendation_shown` | 推奨結果が表示された | raw + daily count + session summary |
| `recommendation_accepted` | ユーザーが推奨結果を採用した | raw + daily count + session summary |
| `recommendation_rejected` | ユーザーが推奨結果を拒否した | raw + daily count + session summary |
| `flow_restarted` | ユーザーがフローをやり直した | raw + daily count + session summary |

---

## 7. イベント属性

### 7.1 `page_view`

Required:

```json
{
  "app_id": "product_recommender",
  "event_name": "page_view",
  "session_id": "sess_...",
  "occurred_at": "2026-06-01T12:00:00.000Z",
  "page_path": "/recommend"
}
```

### 7.2 `click`

Required properties:

| Property | Type | Required |
|---|---|---:|
| `target_id` | string | yes |

Example:

```json
{
  "app_id": "product_recommender",
  "event_name": "click",
  "session_id": "sess_...",
  "occurred_at": "2026-06-01T12:00:00.000Z",
  "page_path": "/recommend",
  "properties": {
    "target_id": "start_button"
  }
}
```

### 7.3 `choice_selected`

Required properties:

| Property | Type | Required |
|---|---|---:|
| `widget_id` | string | yes |
| `flow_version` | string | yes |
| `step` | number | yes |
| `choice_id` | string | yes |

Example:

```json
{
  "app_id": "product_recommender",
  "event_name": "choice_selected",
  "session_id": "sess_...",
  "occurred_at": "2026-06-01T12:00:00.000Z",
  "page_path": "/recommend",
  "widget_id": "main",
  "flow_version": "2026-06-01",
  "properties": {
    "step": 2,
    "choice_id": "budget_low"
  }
}
```

### 7.4 `recommendation_shown`

Required properties:

| Property | Type | Required |
|---|---|---:|
| `widget_id` | string | yes |
| `flow_version` | string | yes |
| `result_id` | string | yes |
| `step_count` | number | no |
| `elapsed_ms` | number | no |

Example:

```json
{
  "app_id": "product_recommender",
  "event_name": "recommendation_shown",
  "session_id": "sess_...",
  "occurred_at": "2026-06-01T12:00:00.000Z",
  "page_path": "/recommend",
  "widget_id": "main",
  "flow_version": "2026-06-01",
  "properties": {
    "result_id": "plan_basic",
    "step_count": 4,
    "elapsed_ms": 8200
  }
}
```

### 7.5 `error_occurred`

Required properties:

| Property | Type | Required |
|---|---|---:|
| `message` | string | yes |
| `stack` | string | no |
| `fingerprint` | string | no |
| `source` | string | no |

Example:

```json
{
  "app_id": "product_recommender",
  "event_name": "error_occurred",
  "session_id": "sess_...",
  "occurred_at": "2026-06-01T12:00:00.000Z",
  "page_path": "/recommend",
  "properties": {
    "message": "TypeError: Cannot read properties of undefined",
    "stack": "...",
    "fingerprint": "typeerror-cannot-read-properties"
  }
}
```

`fingerprint` はクライアントから送ってもよいが、**通知抑制（§13）の主キーには使わない**。  
Worker 側は受信した `fingerprint` を参考値として `properties_json` に保持しつつ、抑制判定には §13.2 で定義するサーバ側生成の fingerprint を用いる。

### 7.6 `api_failed`

Required properties:

| Property | Type | Required |
|---|---:|---|
| `message` | string | yes |
| `source` | string | no |
| `status` | number | no |
| `fingerprint` | string | no |

`status` には失敗した API のHTTPステータス等を入れる。  
URLは `source` に入れてよいが、§14.1 に従い query string を含めてはならない。

### 7.7 フロー完了系イベント

`recommendation_accepted`, `recommendation_rejected`, `flow_restarted` は共通して以下を必須とする。

| Property | Type | Required |
|---|---:|---|
| `widget_id` | string | yes |
| `flow_version` | string | yes |
| `result_id` | string | no |

`widget_opened`, `flow_started`, `step_viewed` は共通フィールド（§5.1）に加え、`step_viewed` のみ `step`（number）を必須とする。

---

## 8. D1スキーマ

### 8.1 `raw_events`

短期保存する生イベント。

```sql
CREATE TABLE raw_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,

  occurred_at TEXT NOT NULL,
  received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

  app_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  event_name TEXT NOT NULL,

  page_path TEXT NOT NULL DEFAULT '',
  widget_id TEXT NOT NULL DEFAULT '',
  flow_version TEXT NOT NULL DEFAULT '',

  step INTEGER,
  target_id TEXT,
  choice_id TEXT,
  result_id TEXT,

  elapsed_ms INTEGER,
  properties_json TEXT NOT NULL DEFAULT '{}',

  user_agent TEXT,
  ip_hash TEXT
);

CREATE INDEX idx_raw_events_time
  ON raw_events(occurred_at);

CREATE INDEX idx_raw_events_app_event_time
  ON raw_events(app_id, event_name, occurred_at);

CREATE INDEX idx_raw_events_session
  ON raw_events(session_id, occurred_at);

CREATE INDEX idx_raw_events_widget_flow
  ON raw_events(app_id, widget_id, flow_version, occurred_at);
```

### 8.2 `session_summaries`

セッション単位の要約。  
生イベント削除後も、フロー分析に必要な情報を残す。

```sql
CREATE TABLE session_summaries (
  session_id TEXT PRIMARY KEY,

  app_id TEXT NOT NULL,
  widget_id TEXT NOT NULL DEFAULT '',
  flow_version TEXT NOT NULL DEFAULT '',

  page_path TEXT NOT NULL DEFAULT '',

  started_at TEXT NOT NULL,
  ended_at TEXT,
  duration_ms INTEGER,

  opened INTEGER NOT NULL DEFAULT 0,
  started INTEGER NOT NULL DEFAULT 0,
  completed INTEGER NOT NULL DEFAULT 0,
  accepted INTEGER NOT NULL DEFAULT 0,
  rejected INTEGER NOT NULL DEFAULT 0,
  restarted INTEGER NOT NULL DEFAULT 0,
  errored INTEGER NOT NULL DEFAULT 0,

  max_step INTEGER NOT NULL DEFAULT 0,
  step_count INTEGER NOT NULL DEFAULT 0,

  result_id TEXT,
  choices_json TEXT NOT NULL DEFAULT '[]',

  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_session_summaries_app_started
  ON session_summaries(app_id, started_at);

CREATE INDEX idx_session_summaries_widget_flow
  ON session_summaries(app_id, widget_id, flow_version, started_at);

CREATE INDEX idx_session_summaries_result
  ON session_summaries(app_id, result_id);
```

### 8.3 `daily_event_counts`

日次のイベントカウンタ。  
長期保存する。

```sql
CREATE TABLE daily_event_counts (
  day TEXT NOT NULL,

  app_id TEXT NOT NULL,
  event_name TEXT NOT NULL,

  page_path TEXT NOT NULL DEFAULT '',
  widget_id TEXT NOT NULL DEFAULT '',
  flow_version TEXT NOT NULL DEFAULT '',

  step INTEGER NOT NULL DEFAULT 0,
  target_id TEXT NOT NULL DEFAULT '',
  choice_id TEXT NOT NULL DEFAULT '',
  result_id TEXT NOT NULL DEFAULT '',

  count INTEGER NOT NULL DEFAULT 0,

  PRIMARY KEY (
    day,
    app_id,
    event_name,
    page_path,
    widget_id,
    flow_version,
    step,
    target_id,
    choice_id,
    result_id
  )
);
```

#### カーディナリティ上の注意

このPKは `page_path × target_id × choice_id × result_id × step` を含むため、組み合わせ次第で1日あたりの行数が爆発する。  
`daily_event_counts` は**無期限保存**（§4.2）なので、肥大化を抑えるため以下を必須とする。

- `page_path` は集計前に正規化し（§25.2）、必要なら**許可パスのホワイトリスト**でそれ以外を `other` に丸める。
- 高カーディナリティになりやすい `target_id`（任意の要素クリック）は、集計対象を**計測対象として登録した要素のみ**に限定する。未登録は raw_events にのみ残し、daily には載せない。
- どうしても軸が増える場合は、`click` の `target_id` 別集計を別テーブルに分離し、保存期間を `daily_event_counts` より短くすることを検討する。

集計に使わない属性は、必ず空文字（`''`）に正規化してPKを縮約する。

### 8.4 `daily_session_metrics`

日次のセッション指標。  
長期保存する。

```sql
CREATE TABLE daily_session_metrics (
  day TEXT NOT NULL,

  app_id TEXT NOT NULL,
  widget_id TEXT NOT NULL DEFAULT '',
  flow_version TEXT NOT NULL DEFAULT '',

  sessions INTEGER NOT NULL DEFAULT 0,
  opened_sessions INTEGER NOT NULL DEFAULT 0,
  started_sessions INTEGER NOT NULL DEFAULT 0,
  completed_sessions INTEGER NOT NULL DEFAULT 0,
  accepted_sessions INTEGER NOT NULL DEFAULT 0,
  rejected_sessions INTEGER NOT NULL DEFAULT 0,
  restarted_sessions INTEGER NOT NULL DEFAULT 0,
  errored_sessions INTEGER NOT NULL DEFAULT 0,

  total_duration_ms INTEGER NOT NULL DEFAULT 0,
  total_max_step INTEGER NOT NULL DEFAULT 0,

  PRIMARY KEY (
    day,
    app_id,
    widget_id,
    flow_version
  )
);
```

### 8.5 `error_events`

エラー詳細を保存する。

```sql
CREATE TABLE error_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,

  occurred_at TEXT NOT NULL,
  received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

  app_id TEXT NOT NULL,
  session_id TEXT,

  page_path TEXT NOT NULL DEFAULT '',
  widget_id TEXT NOT NULL DEFAULT '',
  flow_version TEXT NOT NULL DEFAULT '',

  message TEXT NOT NULL,
  stack TEXT,
  fingerprint TEXT,
  source TEXT,

  user_agent TEXT,
  ip_hash TEXT,

  properties_json TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX idx_error_events_time
  ON error_events(occurred_at);

CREATE INDEX idx_error_events_app_time
  ON error_events(app_id, occurred_at);

CREATE INDEX idx_error_events_fingerprint
  ON error_events(app_id, fingerprint, occurred_at);
```

### 8.6 `notification_dedupes`

同一エラーの通知連打を防ぐ。

```sql
CREATE TABLE notification_dedupes (
  app_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  last_notified_at TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 1,

  PRIMARY KEY (
    app_id,
    fingerprint
  )
);
```

---

## 9. Worker API

### 9.1 `POST /events`

単一イベントを受け取る。

Request:

```json
{
  "app_id": "product_recommender",
  "event_name": "choice_selected",
  "session_id": "sess_...",
  "occurred_at": "2026-06-01T12:00:00.000Z",
  "page_path": "/recommend",
  "widget_id": "main",
  "flow_version": "2026-06-01",
  "properties": {
    "step": 2,
    "choice_id": "budget_low"
  }
}
```

Response:

```json
{
  "ok": true
}
```

成功時は、保存・集計の完了を待たず**常に `202 Accepted`** を返す（§22.2 の非同期方針に従う）。  
`200` は使わない。クライアントはレスポンス本文に依存せず、ステータスコードのみで成否を判定する。

Status:

| Status | Meaning |
|---:|---|
| 202 | Accepted |
| 400 | Invalid payload |
| 403 | Invalid app or origin |
| 405 | Method not allowed |
| 413 | Payload too large（body size 上限超過） |
| 429 | Rate limited |

### 9.2 `POST /events/batch`

複数イベントをまとめて受け取る。

Request:

```json
{
  "events": [
    {
      "app_id": "product_recommender",
      "event_name": "page_view",
      "session_id": "sess_...",
      "occurred_at": "2026-06-01T12:00:00.000Z",
      "page_path": "/recommend"
    },
    {
      "app_id": "product_recommender",
      "event_name": "click",
      "session_id": "sess_...",
      "occurred_at": "2026-06-01T12:00:03.000Z",
      "page_path": "/recommend",
      "properties": {
        "target_id": "start_button"
      }
    }
  ]
}
```

制限:

```text
max events per batch: 20
max request body size: 64KB
```

#### 部分失敗の扱い

batch 内の一部イベントが不正だった場合の方針は以下とする。

- **受理は best-effort**とする。妥当なイベントは保存し、不正なイベントは破棄する（全体を `400` にしない）。
- リクエスト自体の構造が不正（`events` が配列でない、上限超過、body 上限超過）な場合のみ `400` / `413` を返す。
- レスポンスで受理件数と破棄件数を返す。

Response:

```json
{
  "ok": true,
  "accepted": 18,
  "rejected": 2
}
```

Status:

| Status | Meaning |
|---:|---|
| 202 | Accepted（一部破棄を含む） |
| 400 | events が配列でない / 件数上限超過 |
| 403 | Invalid app or origin |
| 405 | Method not allowed |
| 413 | Payload too large |
| 429 | Rate limited |

破棄したイベントの内容はレスポンスに含めない（ペイロード肥大とPII露出を避けるため）。  
破棄件数が多い場合は Worker のログにのみ理由を記録する。

### 9.3 `POST /errors`

エラーを明示的に送るエンドポイント。

`error_occurred` イベントとして扱い、`raw_events` と `error_events` の両方に保存する。

Response / Status は §9.1 と同じとし、成功時は **`202 Accepted`** を返す。  
`message` を欠く場合は `400` とする（§10.2）。

### 9.4 `GET /metrics`

簡易ダッシュボード用の集計値を返す。

#### 認証

`/metrics` は集計値とはいえ非公開情報である。  
`POST /events` 系の Origin 制限とは別に、**管理用トークンによる認証を必須**とする。

```text
Authorization: Bearer <metrics_token>
```

トークンは `app_id` ごとに発行し、Worker の secret として保持する。  
認証に失敗した場合は `401 Unauthorized` を返す。CORS の許可 Origin とは独立に扱う。

Query parameters:

| Parameter | Required | Description |
|---|---:|---|
| `app_id` | yes | アプリID |
| `from` | no | 開始日 |
| `to` | no | 終了日 |
| `widget_id` | no | ウィジェットID |
| `flow_version` | no | フロー版 |

Response example:

```json
{
  "app_id": "product_recommender",
  "from": "2026-06-01",
  "to": "2026-06-07",
  "summary": {
    "page_views": 1200,
    "clicks": 3400,
    "sessions": 800,
    "started_sessions": 800,
    "completed_sessions": 420,
    "accepted_sessions": 210,
    "errored_sessions": 12,
    "error_events": 15,
    "completion_rate": 0.525,
    "acceptance_rate": 0.5,
    "error_rate": 0.015
  }
}
```

各レートは §18.3 の定義に従う。上記の例では以下のとおり。

```text
completion_rate = completed_sessions / started_sessions = 420 / 800 = 0.525
acceptance_rate = accepted_sessions / completed_sessions = 210 / 420 = 0.5
error_rate      = errored_sessions  / sessions          = 12  / 800 = 0.015
```

`errored_sessions`（エラーが発生したセッション数）と `error_events`（エラーイベントの総数）は**別の値**であり、`error_rate` の分子には `errored_sessions` を用いる。

---

## 10. バリデーション

Worker側では、クライアントから送信された値を信用しない。

### 10.1 許可イベント

初期状態で許可するイベントは以下とする。

```text
page_view
click
widget_opened
flow_started
step_viewed
choice_selected
recommendation_shown
recommendation_accepted
recommendation_rejected
flow_restarted
error_occurred
api_failed
```

未知のイベント名は `400 Bad Request` とする。

### 10.2 必須属性

イベントごとに必須属性を検証する。

例:

```text
click:
  target_id required

choice_selected:
  widget_id required
  flow_version required
  step required
  choice_id required

recommendation_shown:
  widget_id required
  flow_version required
  result_id required

error_occurred:
  message required
```

### 10.3 文字列長制限

保存する文字列には上限を設ける。

| Field | Max length |
|---|---:|
| `app_id` | 64 |
| `event_name` | 64 |
| `session_id` | 128 |
| `page_path` | 512 |
| `widget_id` | 64 |
| `flow_version` | 64 |
| `target_id` | 128 |
| `choice_id` | 128 |
| `result_id` | 128 |
| `message` | 2048 |
| `stack` | 16000 |

---

## 11. セッション要約

### 11.1 更新タイミング

`session_summaries` は、以下のイベント受信時に更新する。

```text
widget_opened
flow_started
step_viewed
choice_selected
recommendation_shown
recommendation_accepted
recommendation_rejected
flow_restarted
error_occurred
api_failed
```

### 11.2 更新ルール

| Event | Update |
|---|---|
| `widget_opened` | `opened = 1` |
| `flow_started` | `started = 1` |
| `step_viewed` | `max_step` を更新 |
| `choice_selected` | `choices_json` に `{ step, choice_id }` を追加 |
| `recommendation_shown` | `completed = 1`, `result_id` を保存 |
| `recommendation_accepted` | `accepted = 1` |
| `recommendation_rejected` | `rejected = 1` |
| `flow_restarted` | `restarted = 1` |
| `error_occurred` | `errored = 1` |
| `api_failed` | `errored = 1` |

### 11.3 冪等性と到着順序

`sendBeacon` やバッチ送信により、イベントは**順不同・重複して到着**しうる。  
そのため、各更新は冪等になるよう実装する。

- `opened` / `started` / `completed` / `accepted` / `rejected` / `restarted` / `errored` は 0→1 の**単調なフラグ**とし、`MAX(既存, 1)` 相当で更新する（重複到着しても結果は変わらない）。
- `max_step` は `MAX(既存, step)` で更新する。
- `started_at` は `MIN(既存, occurred_at)`、`ended_at` は `MAX(既存, occurred_at)` で更新し、`duration_ms = ended_at - started_at` を再計算する。
- `choices_json` への append は重複・順序乱れ・lost update のリスクがあるため、**append ではなく `(step, choice_id)` でユニーク化したうえで step 昇順に正規化**して保存する。または raw_events から定期再生成する（§25.5）。

`occurred_at` はクライアント時刻のため信頼できない（§25.6）。`started_at` / `ended_at` の確定には正規化済みの値を用いる。

### 11.4 page_path の扱い

1セッションが複数ページを跨ぐ場合、`session_summaries.page_path` には**最初のイベントの page_path（エントリポイント）**を保存する。  
ページ遷移の詳細は raw_events を参照する。

### 11.5 注意点

`session_summaries` は厳密なイベントログではなく、分析用の要約である。  
詳細な順序確認は `raw_events` を利用する。

---

## 12. 日次集計

### 12.1 イベントカウント

各イベント受信時に、`daily_event_counts` をupsertする。

集計キーは以下とする。

```text
day
app_id
event_name
page_path
widget_id
flow_version
step
target_id
choice_id
result_id
```

### 12.2 セッション指標

`daily_session_metrics` は、定期処理または管理APIで更新する。

算出対象:

```text
sessions
opened_sessions
started_sessions
completed_sessions
accepted_sessions
rejected_sessions
restarted_sessions
errored_sessions
total_duration_ms
total_max_step
```

平均値は保存せず、合計値から算出する。

```text
avg_duration_ms = total_duration_ms / completed_sessions
avg_max_step = total_max_step / sessions
```

#### 日付帰属と確定タイミング

`daily_session_metrics` の `day` は、セッションの **`started_at`（UTC日付）** を基準に帰属させる。  
日をまたいだセッションも、開始日にのみ計上する（二重計上を避ける）。

集計は冪等にする。`session_summaries` を `day` 単位で全件再計算して該当行を置き換える方式とし、`raw_events` の保存期間内であればいつでも再生成できるようにする（§25.5）。  
直近日のセッションは未確定（まだ更新されうる）ため、Cron では**前日以前を確定値、当日は暫定値**として扱う。

更新は定期処理（Cron Triggers）または管理APIで行い、管理APIは §9.4 と同じトークン認証を必須とする。

---

## 13. エラー通知

### 13.1 通知対象

初期状態では以下を通知対象とする。

```text
error_occurred
api_failed
```

ただし、すべてのエラーを通知すると通知過多になるため、fingerprint単位で抑制する。

### 13.2 fingerprint

fingerprint は**必ず Worker 側で生成**する。クライアントが送る `fingerprint` は参考値として保持するだけで、抑制判定には使わない（§7.5）。

fingerprint は以下を正規化したうえで連結し、ハッシュ化して作る。

```text
app_id
event_name
page_path        // query string / fragment を除去済み（§25.2）
normalized_message
source
```

`stack` 全体は fingerprint に含めない。  
ビルドや行番号変更で fingerprint が過度に変わることを避けるためである。

#### message の正規化

`message` をそのまま使うと、可変部分（数値・ID・引用符内の値など）により同一原因のエラーが別 fingerprint になり、抑制が効かず**通知過多**になる。  
そのため `normalized_message` は以下を施す。

```text
数値列を <num> に置換          例: "reading 'item_42'" → "reading 'item_<num>'"
引用符内の値を <str> に置換      例: "Cannot read 'foo'"  → "Cannot read <str>"
UUID / hex 列を <id> に置換
連続空白を1つに圧縮、前後trim
```

正規化規則はアプリ非依存の共通ルールとし、過度に攻めすぎない（別原因を同一 fingerprint に潰さない）バランスとする。

### 13.3 通知抑制

同一 `app_id + fingerprint` の通知は、初期設定では10分に1回までとする。

```text
notification_dedupes.last_notified_at
```

を参照し、10分以内であれば通知しない。

容量逼迫アラート（§16.4）も同じ通知チャネルを使うが、抑制キーは `app_id + 上限種別` とし、エラー通知とは別系統で dedupe する（既定: 1時間に1回）。`notification_dedupes` の `fingerprint` 列に `capacity:<上限種別>` のような予約値を入れて区別してよい。

### 13.4 通知先

初期実装では以下のいずれかを想定する。

```text
Slack Incoming Webhook
Discord Webhook
Email API
```

通知の連打は外部サービス（Slack/Discord）側にも悪影響を与えうるため（§1 ポリシー）、**dedupe を経ない通知送信は禁止**する（§25.4）。

通知本文には以下を含める。

```text
app_id
event_name
page_path
message
fingerprint
occurred_at
count
```

通知本文に以下を含めてはならない。

```text
raw IP address
cookie
localStorage values
form input values
authentication token
full URL query string
```

---

## 14. プライバシー方針

### 14.1 保存しない情報

以下は保存しない。

```text
氏名
メールアドレス
電話番号
住所
raw IP address
Cookie値
認証トークン
フォーム入力値
自由入力テキスト
URL query string
URL fragment
```

#### message / stack のサニタイズ

`error_occurred.message` / `stack` / `api_failed.message` は自由入力に近く、例外メッセージにフォーム値やトークン等の PII が混入しうる。  
そのため**保存時にも**（通知時=§13 だけでなく）以下のマスクを Worker 側で行う。

```text
メールアドレス様の文字列 → <email>
JWT / Bearer トークン様の文字列 → <token>
連続する数字列（電話番号・カード等）→ <num>
```

マスク後に §10.3 の最大長で切り詰める。

### 14.2 URLの扱い

`page_path` には、原則としてquery stringとfragmentを含めない。

保存する例:

```text
/recommend
/docs/getting-started
```

保存しない例:

```text
/recommend?email=user@example.com
/recommend#private-section
```

### 14.3 IPアドレス

raw IP addressは保存しない。

必要な場合のみ、日替わりsalt付きhashとして保存する。

```text
ip_hash = sha256(date + secret + ip)
```

これにより、長期的なユーザー追跡を避ける。

### 14.4 User-Agent

`user_agent` はエラー調査用途で保存できる。  
ただし、長期分析の主キーとして使わない。

---

## 15. CORS / Origin制限

Workerは、許可されたOriginからのリクエストのみ受け付ける。

`app_id` ごとに許可Originを設定する。

Example:

```json
{
  "product_recommender": [
    "https://example.com",
    "https://www.example.com"
  ]
}
```

未知のOrigin、または `app_id` と一致しないOriginは拒否する。

### 15.1 CORS レスポンスヘッダ

許可 Origin からのリクエストには、その Origin を **echo して** `Access-Control-Allow-Origin` に設定する（ワイルドカード `*` は使わない）。

```text
Access-Control-Allow-Origin: <許可された Origin>
Vary: Origin
```

プリフライト（`OPTIONS`）には `Access-Control-Allow-Methods: POST` / `Access-Control-Allow-Headers: content-type` を返す。

### 15.2 sendBeacon と Content-Type

`navigator.sendBeacon` は `Content-Type: application/json` で送るとプリフライトが必要になり、beacon ではプリフライトを伴うリクエストを送れない。  
そのため SDK は beacon 送信時に `Content-Type: text/plain`（単純リクエストになる）で送り、**Worker 側は Content-Type に依存せず body を JSON として parse** する。

### 15.3 Origin ヘッダ欠如時の扱い

`Origin` ヘッダが存在しないリクエスト（一部の beacon・古い環境）の扱いは `app_id` 設定で選択可能にする。

- 既定: `Origin` 欠如は**拒否**（`403`）。
- 緩和モード: アプリ側で明示的に許可した場合のみ受理する。

---

## 16. 上限と容量ガードレール

本節は、ポリシー「利用するサービス側に悪影響がないこと」（§1）を満たすための要件である。  
基本原則は **「適切な上限を設定し、超えたら静かに無視し、超えそうになったら通知する」** とする。

### 16.1 リクエスト単位の上限（必須）

すべてのリクエストで以下を検証する。

```text
batch size limit          : 1リクエスト最大20イベント
request body size limit   : 64KB
event name allowlist      : §10.1
string length limit       : §10.3
origin validation         : §15
```

これらに違反するリクエストは保存しない（構造不正は §9 のステータスで返す）。

### 16.2 総量上限（必須）

per-request 防御だけでは、暴走したクライアント1つが共有 D1/Workers を食い潰すのを防げない。  
そのため `app_id` 単位の**総量上限を必須**とする（ユーザー単位の精密 rate limit は任意のまま）。

| 上限 | 既定値（目安） | 説明 |
|---|---|---|
| events per minute / app | 600 | 短期バースト防御 |
| events per day / app | 200,000 | 日次クォータ |
| `raw_events` rows / app | 1,000,000 | テーブル肥大防御 |
| D1 database size | プラン上限の 80% を warn 閾値 | 基盤保護 |

値は `app_id` ごとに変更可能とする。計数は KV / Durable Object 等の軽量カウンタで概算してよい（厳密性より低コストを優先）。

### 16.3 ロードシェディング

総量上限（§16.2）を超えた場合、**サーバは常に保存をドロップする**。これが基盤保護の本体であり、クライアントの協調には依存しない。

そのうえで、可能な経路では**クライアントにバックプレッシャーを伝えて送信そのものを止めさせる**。202 で受理を装うとドロップで D1 書き込みは減るが Worker の呼び出し・CPU は消費され続けるため、上流から負荷を断つ方がポリシー（§1）に適うためである。

#### 応答の方針

| 経路 / 状況 | サーバ応答 |
|---|---|
| `fetch` 経由・分単位バースト超過 | `429 Too Many Requests` + `Retry-After`（秒） |
| `fetch` 経由・日次/行数クォータ超過 | `429` + 長い `Retry-After`（例: 翌 UTC 0時までの秒数） |
| `sendBeacon` 経由（応答を読めない） | 受理を装い `202` を返してドロップ（クライアントは反応できないため） |

`Retry-After` は SDK が送信を停止すべき期間を示す。`429` は**協調的なヒント**であり、保護の本体ではない。

#### ドロップの優先順位

容量が逼迫し一部のみ保存できる場合、以下の優先度で残す。

1. まず `raw_events`（短期・量が多い）をドロップ対象にする。
2. `daily_event_counts` / `daily_session_metrics`（軽量・長期価値が高い）は可能な限り維持する。
3. `error_events` と通知は、容量に余裕がある限り維持する（障害検知を止めない）。

ドロップ件数は Worker のログとカウンタにのみ記録し、レスポンス本文には載せない。

#### ユーザーへの影響

`429` はユーザーに不可視である（§22.1）。`fetch` は 4xx で reject せず console にも出ない。SDK が応答を握りつぶし、§17.6 に従いリトライしない限り、組み込み先アプリの動作には一切影響しない。  
「静かに無視」とは**ユーザーに見せないこと**を指し、HTTP ステータスを 202 に固定することではない。

### 16.4 逼迫アラート（超えそうになったら通知）

総量上限・D1 容量に対して**警戒閾値（既定: 上限の 80%）**を超えたら、運用者へ通知する。

- 通知チャネルは §13.4 を再利用する。
- ただしエラー通知とは**別系統の dedupe** を持ち、連打を防ぐ（既定: 同一 `app_id + 上限種別` につき 1時間に1回）。
- 通知本文には `app_id` / 上限種別 / 現在値 / 上限値 / 期間を含める。raw IP 等 §13.4 の禁止項目は含めない。

```text
[frontping] capacity warning
app_id: product_recommender
limit: events_per_day
current: 168,000 / 200,000 (84%)
```

容量逼迫の評価は、Cron Triggers（§19.3）の retention 処理と同じ定期実行に相乗りしてよい。

### 16.5 将来的な追加（任意）

```text
IP hash単位の簡易rate limit
bot user-agentの除外
app_id単位の自動スロットリング（上限到達で一定時間受付停止）
```

---

## 17. Frontend SDK

### 17.1 基本方針

フロントエンドでは、自由文字列でイベントを送らない。

以下を提供する。

```text
track()
trackBatch()
trackPageView()
trackClick()
trackError()
```

アプリ固有イベントについては、型付きラッパーを作る。

```text
analytics.choiceSelected()
analytics.recommendationShown()
analytics.recommendationAccepted()
```

### 17.2 セッションID

`session_id` はページロード時に生成する。

```text
session_id = crypto.randomUUID()
```

ブラウザタブ単位の一時セッションとして扱う。

### 17.3 distinct_id

初期実装では、長期的な `distinct_id` は必須としない。

長期的なユーザー追跡を避けるため、原則として `session_id` のみで分析する。

必要な場合でも、アプリ側で明示的に有効化する。

### 17.4 送信方法

通常イベントは `fetch` または `sendBeacon` で送信する。

離脱時の送信には `navigator.sendBeacon` を優先する。

beacon ではプリフライトを避けるため、`Content-Type` を `text/plain` とした単純リクエストで送る（§15.2）。Worker 側は Content-Type に依存せず body を JSON として parse する。

```ts
navigator.sendBeacon(
  endpoint,
  new Blob([JSON.stringify(payload)], { type: "text/plain" })
);
```

通常の `fetch` 送信では `Content-Type: application/json` を用いてよい（この場合はプリフライトが発生するため §15.1 のヘッダを返す）。

### 17.5 バッチ送信

クリックやフローイベントは、必要に応じてバッチ送信する。

```text
max events per batch: 20
flush interval: 5 seconds
flush on visibilitychange
flush on pagehide
```

エラーイベントは即時送信する。

### 17.6 バックオフ（429 の扱い）

SDK は、サーバの容量上限（§16）に協調して送信を止める責務を持つ。これが Worker 呼び出しまで含めた基盤保護に効く。

ルールは以下とする。

- **非2xx でリトライしない**。特に `429` / `4xx` を受けたイベントは**破棄**する。リトライはリトライストームを招き、ポリシー（§1）に反する。
- `429` を受けたら、`Retry-After` で示された期間（ヘッダが無ければ既定 60 秒）は**新規イベントの送信を停止**する。停止中に発生したイベントはキューに無限堆積させず、上限を超えたぶんは捨てる。
- 停止期間が明けたら通常送信に戻る。指数バックオフは任意。
- `sendBeacon` は応答を読めないため、バックオフ判定は `fetch` 経路でのみ行う。直近に `fetch` で `429` を受けている間は、beacon 送信も控えてよい。
- いずれの失敗もユーザーに表示しない（§22.1）。`fetch` の失敗（ネットワーク断・CORS）も同様に握りつぶす。

```ts
// 概念例
if (res.status === 429) {
  const sec = Number(res.headers.get("Retry-After")) || 60;
  pauseUntil = now + sec * 1000;   // この間は送信停止・対象イベントは破棄
  return;                          // リトライしない
}
```

---

## 18. 管理・メトリクス

### 18.1 提供範囲

ポリシー §1（運用手間の最小化）に照らし、ダッシュボードの提供範囲を以下に定める。

- **本システムが提供するもの**:
    - 集計値を返す `GET /metrics`（§9.4）。
    - それを表示する**最小の読み取り専用ダッシュボード**（静的 HTML + `fetch` の薄いクライアント）。運用者が UI を自前で構築しなくても、導入直後に主要指標を確認できることを目標とする。
- **スコープ外（運用者側の任意実装）**:
    - リッチな BI/可視化、フィルタ UI、ダッシュボードの認証基盤統合、複数アプリの一覧管理画面。
    - これらは `GET /metrics` を叩く外部ツール（スプレッドシート連携・Grafana 等）で代替できることを前提とし、本システムは API の安定提供に責任を持つ。

同梱ダッシュボードも §9.4 の `metrics_token` 認証を用いる。

### 18.2 表示項目

初期ダッシュボードでは、以下を表示する。

```text
page views
clicks
sessions
started sessions
completed sessions
accepted sessions
rejected sessions
restarted sessions
errors
completion rate
acceptance rate
error rate
```

### 18.3 指標定義

```text
completion_rate =
  completed_sessions / started_sessions

acceptance_rate =
  accepted_sessions / completed_sessions

restart_rate =
  restarted_sessions / completed_sessions

error_rate =
  errored_sessions / sessions
```

分母が0の場合は `null` とする。

### 18.4 ウィジェット向け指標

固定選択肢型ウィジェットでは以下も表示する。

```text
choice_id別選択回数
result_id別表示回数
result_id別採用率
step別到達数
step別離脱推定
flow_version別完了率
```

`step別到達数` は `step_viewed` の step 別カウント（到達したセッション数の近似）から求める。  
`step別離脱推定` は「step N に到達したが N+1 に到達しなかった」割合として算出する。ただしフローが step を飛ばす／戻る設計の場合は単純な差分では正確にならないため、**到達は `MAX(step)` ベース（その step 以上に到達したセッション数）**で扱い、推定値である旨を明示する。

---

## 19. Retention

### 19.1 初期設定

| Table | Retention |
|---|---:|
| `raw_events` | 30 days |
| `error_events` | 90 days |
| `session_summaries` | 365 days |
| `daily_event_counts` | indefinite |
| `daily_session_metrics` | indefinite |
| `notification_dedupes` | 30 days after last notification |

### 19.2 削除SQL例

```sql
DELETE FROM raw_events
WHERE occurred_at < datetime('now', '-30 days');

DELETE FROM error_events
WHERE occurred_at < datetime('now', '-90 days');

DELETE FROM session_summaries
WHERE started_at < datetime('now', '-365 days');

DELETE FROM notification_dedupes
WHERE last_notified_at < datetime('now', '-30 days');
```

### 19.3 実行方法

retention 処理は **Cloudflare Workers Cron Triggers による完全自動実行を既定**とする（ポリシー §1「運用する側の手間がかからない／自動化されていること」）。  
手動管理 API・CI/CD からの実行は、再実行や障害復旧用の**補助手段**と位置づけ、通常運用では人手を必要としない。

### 19.4 定期処理一覧

運用に必要な定期処理は、すべて Cron Triggers に集約し、人手の介入なしに回るようにする。

| 処理 | 既定スケジュール | 内容 | 参照 |
|---|---|---|---|
| retention | 日次 | 期限切れ行の削除（§19.2） | §19 |
| daily_session_metrics 再計算 | 日次 | 前日確定分の集計を冪等に再生成 | §12.2 |
| 容量チェック / 逼迫アラート | 毎時 | 総量・D1 サイズを評価し警戒閾値超過で通知 | §16.4 |
| 月次 export（Phase 4） | 月次 | R2 への自動 export | §20 |

各処理は冪等に設計し（再実行で二重処理が起きない）、失敗時は次回スケジュールで自然に回復できるようにする。  
処理の成否・削除件数・ドロップ件数等は Worker のログに記録する。手動確認を前提とした運用手順書を必要としないことを目標とする。

---

## 20. Export

### 20.1 基本方針

手動 export は **Phase 1〜3 の暫定手段**と位置づける。手動 export を恒常的な運用フローに組み込まない。

ポリシー §1（運用手間の最小化）に照らした到達点は、**月次の R2 自動 export（Cron Triggers）**である（§19.4）。Phase 4 でこれを実装し、手動 export は障害復旧・スポット調査用の補助に格下げする。

| 段階 | export 方式 | 位置づけ |
|---|---|---|
| Phase 1〜3 | 手動（管理 API 経由） | 暫定。必要時のみ |
| Phase 4 以降 | 月次 R2 自動 export | 標準。人手不要 |

### 20.2 Export対象

優先度順に以下をexport可能にする。

```text
daily_event_counts
daily_session_metrics
session_summaries
error_events
raw_events
```

`raw_events` は短期保存であるため、必要な場合のみexportする。

### 20.3 Export形式

推奨形式は以下とする。

```text
daily_event_counts: CSV
daily_session_metrics: CSV
session_summaries: JSONL or CSV
error_events: JSONL
raw_events: JSONL
```

### 20.4 R2保存パス案

```text
analytics-exports/
  app_id/
    daily_event_counts/
      2026/
        06.csv
    daily_session_metrics/
      2026/
        06.csv
    session_summaries/
      2026/
        06.jsonl.gz
    error_events/
      2026/
        06.jsonl.gz
    raw_events/
      2026/
        06/
          01.jsonl.gz
```

### 20.5 再export時の冪等性

月途中の再export・再実行に備え、export は**同一パスを上書き（PUT で置換）**する冪等な操作とする。追記はしない。  
`daily_event_counts` / `daily_session_metrics` のように後から再生成されうる集計値は、export 時点のスナップショットとして月ファイルをまるごと再生成して置き換える。  
これにより、同じ期間を複数回 export しても二重計上が起きない。

---

## 21. 実装フェーズ

### Phase 1: 最小収集

実装対象:

```text
POST /events
POST /errors
raw_events
error_events
error notification
basic frontend SDK
```

目的:

```text
まずイベントとエラーを受け取れるようにする。
```

### Phase 2: 集計

実装対象:

```text
daily_event_counts
session_summaries
basic metrics API
simple dashboard
```

目的:

```text
PV、クリック、完了率、採用率、エラー率を見られるようにする。
```

### Phase 3: 運用

実装対象:

```text
retention
notification dedupe
manual export
Cron Triggers
```

目的:

```text
継続運用できる状態にする。
```

### Phase 4: 拡張

実装候補:

```text
R2 export
flow_version comparison
step drop-off report
result acceptance report
API latency metrics
bot filtering
```

目的:

```text
小規模プロダクト分析基盤として育てる。
```

---

## 22. 非機能要件

### 22.1 可用性

イベント収集APIは、アプリ本体の動作を阻害してはならない。

フロントエンド側では、イベント送信失敗をユーザーに表示しない。

### 22.2 パフォーマンス

イベント送信は非同期で行う。

ユーザー操作の完了をanalytics送信で待たない。

### 22.3 データ欠損

本システムは、厳密な監査ログではない。  
ブラウザ終了、ネットワーク切断、Ad blocker等によりイベントが欠損する可能性を許容する。

### 22.4 コスト

無料枠または低価格運用を前提にする。

そのため、以下を避ける。

```text
無期限のraw_events保存
全クリックの詳細ログ長期保存
大きなstack traceの無制限保存
高頻度のリアルタイム集計
```

---

## 23. 将来の移行性

D1で開始するが、将来的にPostgresやClickHouseへ移行できるようにする。

そのため、以下を守る。

```text
app_idを必ず持つ
event_nameを安定させる
properties_jsonに依存しすぎない
主要な分析軸はカラム化する
raw_eventsと集計テーブルを分ける
export可能な形式にする
```

将来的な移行先候補:

```text
Neon Postgres
Supabase Postgres
ClickHouse
Tinybird
BigQuery
```

---

## 24. 初期設定例

### 24.1 App config

```json
{
  "app_id": "product_recommender",
  "allowed_origins": [
    "https://example.com",
    "https://www.example.com"
  ],
  "require_origin": true,
  "metrics_token": "<secret>",
  "retention": {
    "raw_events_days": 30,
    "error_events_days": 90,
    "session_summaries_days": 365
  },
  "limits": {
    "events_per_minute": 600,
    "events_per_day": 200000,
    "raw_events_rows": 1000000,
    "warn_threshold_ratio": 0.8
  },
  "notification": {
    "enabled": true,
    "dedupe_minutes": 10,
    "capacity_dedupe_minutes": 60
  }
}
```

`metrics_token` は `/metrics` および管理API（§9.4 / §12.2 / §19.3）の認証に用いる secret であり、フロントエンドには配布しない。  
`require_origin` は `Origin` ヘッダ欠如時の扱いを切り替える（§15.3）。  
`limits` は総量上限（§16.2）、`warn_threshold_ratio` は逼迫アラートの警戒閾値（§16.4）、`capacity_dedupe_minutes` は逼迫アラートの抑制間隔（§13.3）である。

### 24.2 初期イベントセット

```text
page_view
click
widget_opened
flow_started
step_viewed
choice_selected
recommendation_shown
recommendation_accepted
recommendation_rejected
flow_restarted
error_occurred
api_failed
```

---

## 25. 実装上の注意

### 25.1 クライアント値を信用しない

以下は必ずWorker側で正規化する。

```text
event_name
page_path
step
target_id
choice_id
result_id
message
stack
```

### 25.2 query stringを落とす

`page_path` はWorker側でもquery stringを除去する。

### 25.3 stack traceを制限する

`stack` は最大長を超えた場合、切り詰めて保存する。

### 25.4 通知は必ずdedupeする

通知の連打は運用を破綻させるため、dedupeなしの通知送信は禁止する。

### 25.5 集計値は後から再生成可能にする

`raw_events` が残っている期間内であれば、`daily_event_counts` と `session_summaries` を再生成できる設計にする。

リクエスト時の即時 upsert はパフォーマンスのための先行集計であり、**真の source of truth は `raw_events`** とする。両者が乖離した場合は raw_events からの再生成を正とする。

### 25.6 occurred_at を検証する

`occurred_at` はクライアント時刻のため、時計ずれや改ざんにより未来日・過去日が混入しうる。

- 受信時に `received_at` を必ず記録する。
- `occurred_at` が `received_at` を基準とした許容範囲（例: 過去 +7 日 〜 未来 +1 時間）を外れる場合は、`received_at` で置き換える。
- 日次集計（§12）・セッション帰属（§12.2）の `day` は、この**正規化後の値**を UTC 日付に丸めて用いる。

### 25.7 D1 への書き込み戦略

1 イベントで最大 `raw_events` INSERT + `daily_event_counts` UPSERT + `session_summaries` UPSERT の 3 書き込みが発生し、batch（最大 20 件）では最大 60 書き込みになる。

- 1 リクエスト分の書き込みは D1 の `batch()`（単一トランザクション）でまとめて実行し、部分的な不整合を避ける。
- 書き込み増幅を抑えるため、`daily_event_counts` への upsert はリクエスト内で同一集計キーを**事前に合算してから** 1 文にまとめる。
- `raw_events` への保存を最優先（収集の取りこぼし防止）とし、集計テーブルは raw_events から再生成可能（§25.5）であることを前提に、失敗時のリトライ方針を許容範囲内で簡素化してよい。

---

## 26. 成功基準

初期版は以下を満たせば成功とする。

```text
小規模なフロントエンドアプリにSDKを導入できる
page_viewが記録される
clickがtarget_id別に記録される
widget flowの完了率が見られる
recommendationの採用率が見られる
JavaScript errorが保存される
重要なerrorが通知される
raw_eventsを短期保存できる
daily metricsを長期保存できる
retentionによりDB肥大化を抑えられる
```

---

## 27. 用語

| Term | Meaning |
|---|---|
| app_id | 計測対象アプリケーションの識別子 |
| widget_id | アプリ内のウィジェット識別子 |
| flow_version | 診断・推薦フロー定義のバージョン |
| session_id | ブラウザタブまたはページロード単位の一時セッションID |
| event_name | イベント種別 |
| target_id | クリック対象要素の安定ID |
| choice_id | 選択肢の安定ID |
| result_id | 推奨結果の安定ID |
| raw_events | 短期保存する生イベント |
| session_summaries | セッション単位の要約 |
| daily_event_counts | 日次イベント集計 |
| daily_session_metrics | 日次セッション集計 |
| error_events | エラー詳細ログ |

---

## 28. まとめ

本システムは、Cloudflare Workers + D1 上で動作する軽量な解析・通知基盤である。

初期設計では、単純なカウンタ保存だけでなく、短期の `raw_events` と中期の `session_summaries` を持つ。  
これにより、直近の詳細調査と長期トレンド分析の両方を可能にする。

一方で、raw dataを永続保存しないことで、D1の容量増加と運用コストを抑える。

初期スコープは小さく保ち、必要に応じてR2 export、詳細ファネル、Postgres/ClickHouse移行へ拡張できる構成とする。
