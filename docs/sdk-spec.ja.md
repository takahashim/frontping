
# frontping SDK 仕様（sdk-spec）

> コア仕様は [`spec.ja.md`](./spec.ja.md)、データストア仕様は [`db-spec.ja.md`](./db-spec.ja.md) を参照。本書のセクションは番号を持たず名前で参照する。コアの節は `§` 番号で参照する。

## Frontend SDK

### 基本方針

フロントエンドでは、自由文字列でイベントを送らない。

SDK は `createAnalytics()` で生成し、以下を提供する。

```text
track(name, props)         標準・アプリ固有イベントの送信（バッチに積む）
trackPageView(pagePath?)   page_view のショートカット
trackClick(targetId, ...)  click のショートカット
trackError(message, opts?) error_occurred を即時送信
flush()                    手動フラッシュ
destroy()                  タイマー/リスナ解除（SPA 破棄・テスト用）
```

バッチ送信は SDK 内部で自動的に行うため、専用の `trackBatch()` は設けない（「バッチ送信」参照）。

アプリ固有イベントは、イベントごとにラッパー関数を増やすのではなく、**型マップを `createAnalytics<E>()` に渡して `track()` を型付けする**。

```ts
type MyEvents = { coffee_purchased: { sku: string; price: number } };
const analytics = createAnalytics<MyEvents>({ endpoint, appId, widgetId, flowVersion });

// 標準イベント（型なしでも利用可）
analytics.track("choice_selected", { step: 1, choice_id: "budget_low" });
// アプリ固有イベント（型チェックされる）
analytics.track("coffee_purchased", { sku: "drip_01", price: 1200 });
```

### セッションID

`session_id` はページロード時に生成する。

```text
session_id = crypto.randomUUID()
```

ブラウザタブ単位の一時セッションとして扱う。

### distinct_id

初期実装では、長期的な `distinct_id` は必須としない。

長期的なユーザー追跡を避けるため、原則として `session_id` のみで分析する。

必要な場合でも、アプリ側で明示的に有効化する。

### 送信方法

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

### バッチ送信

クリックやフローイベントは、必要に応じてバッチ送信する。

```text
max events per batch: 20
flush interval: 5 seconds
flush on visibilitychange
flush on pagehide
```

エラーイベントは即時送信する。

### バックオフ（429 の扱い）

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
