# frontping: Lightweight Analytics and Error Notification Specification

> **ドキュメント構成** — 本仕様は3ファイルに分割している。本書（コア）の各セクションは `§` 番号を持つ。SDK・データストアの2ファイルは番号を持たず、セクション名で参照する。本書から見当たらない内容は下記の分割先を参照する。
>
> - 本書 `spec.ja.md`（コア）: 概要・対象範囲・基本方針・イベントモデル・標準イベント・イベント属性・Worker API・バリデーション・エラー通知・プライバシー・CORS・上限と容量・ダッシュボード・非機能要件・実装上の注意（§1〜§7, §9, §10, §13〜§16, §18, §22〜§28）。
> - [`sdk-spec.ja.md`](./sdk-spec.ja.md): フロントエンド SDK。
> - [`db-spec.ja.md`](./db-spec.ja.md): D1 スキーマ・セッション要約・日次集計・retention・export。

## 1. 概要

本仕様は、小規模なフロントエンドアプリケーションおよびウィジェット向けの、軽量な解析・エラー通知基盤を定義する。

初期実装では Cloudflare Workers + D1 を利用する。

### 目的

本システムの主な目的は以下である。

- ページビューを記録する
- クリック回数を記録する
- 固定選択肢型ウィジェットの利用状況を記録する
- JavaScriptエラーおよびAPI失敗を記録する
- 重要なエラーを通知する
- 短期の生イベントと長期の集計値を保持する
- 将来的にR2等へexportできる余地を残す

本システムは、PostHog、Sentry、Google Analyticsの完全な代替を目指すものではない。 
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
- 集計値を閲覧する読み取り専用ダッシュボード
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

Cloudflare Workers を中心に、以下の要素で構成する。

```text
フロントエンド SDK（sdk-spec.ja.md）
    │  POST /events, /events/batch, /errors
    ▼
Worker（Hono）
    ├─ 検証・正規化（§10, §25）
    ├─ D1 へ書き込み（raw_events / daily_* / session_summaries / error_events）
    ├─ エラー通知（§13、Slack/Discord webhook）
    └─ 読み取り専用ダッシュボード GET /dashboard（§18、GitHub OAuth）

D1（db-spec.ja.md）            … 生イベント＋集計テーブル（source of truth）
KV                            … 総量カウンタ（§16.2）
R2                            … 月次 export 先（db-spec.ja.md）
Cron Triggers（db-spec.ja.md） … 集計再計算・retention・容量チェック・月次 export
```

データの流れは「SDK が収集 → Worker が検証・正規化して D1 に保存（生イベント＋先行集計）→ Cron が集計の確定再計算・retention・export を実行 → ダッシュボードが集計値を表示」となる。集計の真の source of truth は `raw_events` であり、集計テーブルはそこから再生成できる（§25.5）。

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

`raw_events` は詳細調査用であり、永続保存しない。短期保存（生イベント・エラー）と長期保存（日次集計）を分け、保存期間はアプリごとに変更可能とする。

具体的な保存期間と削除処理（retention）は [`db-spec.ja.md`](./db-spec.ja.md) の「Retention」を参照。

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

## 11. セッション要約 / 12. 日次集計

セッション要約（`session_summaries`）の更新ルール・冪等性・page_path の扱いと、日次集計（`daily_event_counts` / `daily_session_metrics`）の集計キー・指標・日付帰属は、データストア仕様にまとめている。[`db-spec.ja.md`](./db-spec.ja.md) の「セッション要約」「日次集計」を参照。

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

プリフライト（`OPTIONS`）には `Access-Control-Allow-Methods: POST` / `Access-Control-Allow-Headers: content-type` を返す。プリフライト結果のキャッシュのため `Access-Control-Max-Age` を付してよい。

収集系エンドポイント（`/events` / `/events/batch` / `/errors`）は `POST` のみを受け付け、それ以外のメソッドには `405 Method Not Allowed`（`Allow: POST`）を返す。

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

`429` はユーザーに不可視である（§22.1）。`fetch` は 4xx で reject せず console にも出ない。SDK が応答を握りつぶし、[`sdk-spec.ja.md`](./sdk-spec.ja.md) の「バックオフ（429 の扱い）」に従いリトライしない限り、組み込み先アプリの動作には一切影響しない。  
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

容量逼迫の評価は、Cron Triggers（[`db-spec.ja.md`](./db-spec.ja.md) の「Retention > 実行方法」）の retention 処理と同じ定期実行に相乗りしてよい。

### 16.5 将来的な追加（任意）

```text
IP hash単位の簡易rate limit
bot user-agentの除外
app_id単位の自動スロットリング（上限到達で一定時間受付停止）
```


---

## 18. 管理・メトリクス

### 18.1 提供範囲

ポリシー §1（運用手間の最小化）に照らし、ダッシュボードの提供範囲を以下に定める。

- **本システムが提供するもの**:
    - **最小の読み取り専用ダッシュボード** `GET /dashboard`。運用者が UI を自前で構築しなくても、導入直後に主要指標を確認できることを目標とする。
    - 集計値は Worker がサーバ側で計算し（`daily_*` テーブルおよび保存期間内の `raw_events` から）、ダッシュボードの HTML に埋め込んで返す（サーバーサイドレンダリング）。SVG の時系列グラフのみ、埋め込み済みデータをクライアントの軽量スクリプトが描画する（時刻のローカルTZ整形のため）。
    - 集計値を返す独立した HTTP API（旧 `GET /metrics`）は提供しない。集計ロジックはダッシュボード専用の内部関数として実装する。
- **スコープ外（運用者側の任意実装）**:
    - リッチな BI/可視化、フィルタ UI、ダッシュボードの認証基盤統合。
    - これらが必要な場合は、R2 への月次 export で書き出したデータを外部ツール（スプレッドシート連携・Grafana 等）に取り込んで構築することを前提とする。

ダッシュボードの認証は GitHub ログインのセッション Cookie を用いる。OAuth secret 群が未設定の場合、本番では設定不足の案内ページを表示し、ローカル開発（`APP_ENV=development`）のときのみ認証をバイパスする。

### 18.1.1 画面構成

- **一覧ビュー**（`GET /dashboard`）: 設定済みアプリ（`app_id`）の一覧を表示し、各アプリの詳細へリンクする。
- **詳細ビュー**（`GET /dashboard?app=<app_id>&from=<YYYY-MM-DD>&to=<YYYY-MM-DD>`）: 指定アプリのサマリー指標と時系列グラフを表示する。期間は GET フォームで指定し、サーバが再レンダリングする（クライアント側の XHR/fetch は用いない）。`app` が未指定・未知の場合は一覧ビューにフォールバックする。

### 18.2 表示項目

初期ダッシュボードの詳細ビューでは、サマリーカードとして以下を表示する。

```text
page views
clicks
sessions
started sessions
completed sessions
accepted sessions
errored sessions
error events
completion rate
acceptance rate
error rate
```

`error events` は `error_occurred` と `api_failed` のイベント件数の合計、`errored sessions` はエラーが発生したセッション数である。

加えて、時系列グラフを 2 種類表示する（系列は `page_views` / `clicks` / `errors`）。

```text
過去24時間（5分粒度・時刻はローカルTZ）
過去30日（日別）
```

`rejected_sessions` / `restarted_sessions` は `daily_session_metrics` に集計しているが、現状の同梱ダッシュボードでは表示していない（§18.3 の `restart_rate` も同様）。

### 18.3 指標定義

同梱ダッシュボードが算出・表示する比率は以下とする。

```text
completion_rate =
  completed_sessions / started_sessions

acceptance_rate =
  accepted_sessions / completed_sessions

error_rate =
  errored_sessions / sessions
```

分母が0の場合は `null` とする（UI 上は `—` と表示）。

`restart_rate = restarted_sessions / completed_sessions` も同じ要領で算出可能だが、現状の同梱ダッシュボードでは表示していない（将来の追加候補）。

### 18.4 ウィジェット向け指標（将来の追加候補・現状未実装）

固定選択肢型ウィジェットでは、将来的に以下も表示する余地を残す。**現状の同梱ダッシュボードでは未提供**だが、いずれも `daily_event_counts`（集計キーに `widget_id` / `flow_version` / `step` / `choice_id` / `result_id` を含む）および保存期間内の `raw_events` から算出可能である。

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

---

## 24. 静的設定

アプリ単位の設定は、データベースではなく Worker の環境（wrangler の vars / secrets）に静的に持つ。運用者が設定を変えるのは稀であり、起動時に読み込む静的設定で十分なためである（ポリシー §1）。

### 24.1 アプリ設定（vars）

`APP_CONFIG` に `app_id` ごとの設定をまとめて持つ。各アプリは以下を持つ。

```text
allowed_origins      許可 Origin の配列（§15）
require_origin       Origin 欠如時に拒否するか（§15.3）
limits               総量上限（events_per_minute / events_per_day /
                     raw_events_rows / warn_threshold_ratio。§16.2）
retention            保存日数（raw_events / error_events / session_summaries。db-spec「Retention」）
notification         通知設定（有効可否・dedupe 分数・容量 dedupe 分数。§13.3）
```

実行環境は `APP_ENV`（`production` / `preview` / `development`）で指定する。`development` はローカル開発用で、OAuth 未設定時の認証バイパスを有効にする（§18.1）。

### 24.2 秘匿値（secrets）

秘匿値は vars と分離し、`wrangler secret put` で投入する。

```text
NOTIFY_WEBHOOK_URL                            通知先 webhook（§13.4）
IP_HASH_SECRET                                ip_hash 生成用 salt（§14.3。未設定なら ip_hash を記録しない）
GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET /
SESSION_SECRET / ALLOWED_GITHUB_USERS         ダッシュボードの GitHub ログイン（§18.1）
```

具体的な設定値・記述例は `wrangler.toml` を参照する（本仕様では構造のみを定義する）。

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
- 日次集計・セッション帰属（[`db-spec.ja.md`](./db-spec.ja.md) の「日次集計」）の `day` は、この**正規化後の値**を UTC 日付に丸めて用いる。

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
| notification_dedupes | 通知の連打抑制用テーブル（§13.3 / §16.4） |
| fingerprint | エラーをグルーピングする識別子（抑制判定はサーバ生成値を使う。§13.2） |
| ip_hash | 日替わり salt 付き IP ハッシュ（raw IP は保存しない。§14.3） |

---

## 28. まとめ

本システムは、Cloudflare Workers + D1 上で動作する軽量な解析・通知基盤である。

初期設計では、単純なカウンタ保存だけでなく、短期の `raw_events` と中期の `session_summaries` を持つ。  
これにより、直近の詳細調査と長期トレンド分析の両方を可能にする。

一方で、raw dataを永続保存しないことで、D1の容量増加と運用コストを抑える。

初期スコープは小さく保ち、必要に応じてR2 export、詳細ファネル、Postgres/ClickHouse移行へ拡張できる構成とする。
