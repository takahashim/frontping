# frontping データストア仕様（db-spec）

> コア仕様は [`spec.ja.md`](./spec.ja.md)、SDK 仕様は [`sdk-spec.ja.md`](./sdk-spec.ja.md) を参照。本書のセクションは番号を持たず名前で参照する。コアの節は `§` 番号で参照する。
> 本書が扱う内容: D1 スキーマ・セッション要約・日次集計・retention・export。

## D1スキーマ

各テーブルの役割と設計上の注意を定義する。**実際の DDL（カラム・型・インデックス・制約）は `worker/migrations/*.sql` を source of truth とする**。本書はスキーマの DDL を重複して持たない。

### `raw_events`

短期保存する生イベント。

### `session_summaries`

セッション単位の要約。  
生イベント削除後も、フロー分析に必要な情報を残す。  
選択内容（`choice_selected` の詳細）は要約に保存せず、`raw_events` に保持する（「セッション要約 > 更新ルール」/ §25.5）。`choice_selected` は `max_step` の更新にのみ寄与する。

### `daily_event_counts`

日次のイベントカウンタ。  
長期保存する。

#### カーディナリティ上の注意

集計キー（「日次集計 > イベントカウント」）は `page_path × target_id × choice_id × result_id × step` を含むため、組み合わせ次第で1日あたりの行数が爆発する。  
`daily_event_counts` は**無期限保存**（§4.2）なので、肥大化を抑えるため以下を必須とする。

- `page_path` は集計前に正規化し（§25.2）、必要なら**許可パスのホワイトリスト**でそれ以外を `other` に丸める。
- 高カーディナリティになりやすい `target_id`（任意の要素クリック）は、集計対象を**計測対象として登録した要素のみ**に限定する。未登録は raw_events にのみ残し、daily には載せない。
- どうしても軸が増える場合は、`click` の `target_id` 別集計を別テーブルに分離し、保存期間を `daily_event_counts` より短くすることを検討する。

集計に使わない属性は、必ず空文字（`''`）に正規化してPKを縮約する。

### `daily_session_metrics`

日次のセッション指標。  
長期保存する。

### `error_events`

エラー詳細を保存する。

### `notification_dedupes`

通知連打を防ぐ（§13.3 / §25.4）。エラー通知は `fingerprint` にサーバ生成のエラー fingerprint、容量逼迫アラート（§16.4）は `fingerprint='capacity:<上限種別>'`、運用ジョブの失敗通知は `app_id='__ops__'` を用いて、系統ごとに独立して dedupe する。

## セッション要約

### 更新タイミング

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

### 更新ルール

| Event | Update |
|---|---|
| `widget_opened` | `opened = 1` |
| `flow_started` | `started = 1` |
| `step_viewed` | `max_step` を更新 |
| `choice_selected` | `max_step` を更新（選択内容は要約せず raw_events に保持） |
| `recommendation_shown` | `completed = 1`, `result_id` を保存 |
| `recommendation_accepted` | `accepted = 1` |
| `recommendation_rejected` | `rejected = 1` |
| `flow_restarted` | `restarted = 1` |
| `error_occurred` | `errored = 1` |
| `api_failed` | `errored = 1` |

### 冪等性と到着順序

`sendBeacon` やバッチ送信により、イベントは**順不同・重複して到着**しうる。  
そのため、各更新は冪等になるよう実装する。

- `opened` / `started` / `completed` / `accepted` / `rejected` / `restarted` / `errored` は 0→1 の**単調なフラグ**とし、`MAX(既存, 1)` 相当で更新する（重複到着しても結果は変わらない）。
- `max_step` は `MAX(既存, step)` で更新する。
- `started_at` は `MIN(既存, occurred_at)`、`ended_at` は `MAX(既存, occurred_at)` で更新し、`duration_ms = ended_at - started_at` を再計算する。
- 選択内容（`choice_selected` の `step` / `choice_id`）は重複・順序乱れ・lost update のリスクがあるため、`session_summaries` には要約として保存しない。`choice_selected` は `max_step` の更新にのみ寄与させ、選択の詳細は `raw_events` を参照する（必要なら §25.5 の方針で集計を再生成する）。

`occurred_at` はクライアント時刻のため信頼できない（§25.6）。`started_at` / `ended_at` の確定には正規化済みの値を用いる。

### page_path の扱い

1セッションが複数ページを跨ぐ場合、`session_summaries.page_path` には**最初のイベントの page_path（エントリポイント）**を保存する。  
ページ遷移の詳細は raw_events を参照する。

### 注意点

`session_summaries` は厳密なイベントログではなく、分析用の要約である。  
詳細な順序確認は `raw_events` を利用する。

---

## 日次集計

### イベントカウント

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

### セッション指標

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

更新は定期処理（Cron Triggers）または管理APIで行い、管理APIは運用者認証（GitHub ログインのセッション Cookie。§18.1）を必須とする。

---

## Retention

### 初期設定

| Table | Retention |
|---|---:|
| `raw_events` | 30 days |
| `error_events` | 90 days |
| `session_summaries` | 365 days |
| `daily_event_counts` | indefinite |
| `daily_session_metrics` | indefinite |
| `notification_dedupes` | 30 days after last notification |

### 削除SQL例

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

### 実行方法

retention 処理は **Cloudflare Workers Cron Triggers による完全自動実行を既定**とする（ポリシー §1「運用する側の手間がかからない／自動化されていること」）。  
手動管理 API・CI/CD からの実行は、再実行や障害復旧用の**補助手段**と位置づけ、通常運用では人手を必要としない。

### 定期処理一覧

運用に必要な定期処理は、すべて Cron Triggers に集約し、人手の介入なしに回るようにする。

| 処理 | 既定スケジュール | 内容 | 参照 |
|---|---|---|---|
| retention | 日次 | 期限切れ行の削除（「削除SQL例」） | Retention |
| daily_session_metrics 再計算 | 日次 | 前日確定分の集計を冪等に再生成 | 日次集計 |
| 容量チェック / 逼迫アラート | 毎時 | 総量・D1 サイズを評価し警戒閾値超過で通知 | §16.4 |
| 月次 export（Phase 4） | 月次 | R2 への自動 export | Export |

各処理は冪等に設計し（再実行で二重処理が起きない）、失敗時は次回スケジュールで自然に回復できるようにする。  
処理の成否・削除件数・ドロップ件数等は Worker のログに記録する。手動確認を前提とした運用手順書を必要としないことを目標とする。


---

## Export

### 基本方針

手動 export は **Phase 1〜3 の暫定手段**と位置づける。手動 export を恒常的な運用フローに組み込まない。

ポリシー §1（運用手間の最小化）に照らした到達点は、**月次の R2 自動 export（Cron Triggers）**である（「Retention > 定期処理一覧」）。Phase 4 でこれを実装し、手動 export は障害復旧・スポット調査用の補助に格下げする。

| 段階 | export 方式 | 位置づけ |
|---|---|---|
| Phase 1〜3 | 手動（管理 API 経由） | 暫定。必要時のみ |
| Phase 4 以降 | 月次 R2 自動 export | 標準。人手不要 |

### Export対象

優先度順に以下をexport可能にする。

```text
daily_event_counts
daily_session_metrics
session_summaries
error_events
raw_events
```

`raw_events` は短期保存であるため、必要な場合のみexportする。

### Export形式

形式は以下とする（JSONL は gzip 圧縮して保存する）。

```text
daily_event_counts: CSV
daily_session_metrics: CSV
session_summaries: JSONL (gzip)
error_events: JSONL (gzip)
raw_events: JSONL (gzip)
```

### R2保存パス案

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

### 再export時の冪等性

月途中の再export・再実行に備え、export は**同一パスを上書き（PUT で置換）**する冪等な操作とする。追記はしない。  
`daily_event_counts` / `daily_session_metrics` のように後から再生成されうる集計値は、export 時点のスナップショットとして月ファイルをまるごと再生成して置き換える。  
これにより、同じ期間を複数回 export しても二重計上が起きない。
