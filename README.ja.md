# frontping

[English](./README.md) | 日本語

小規模フロントエンド向けの軽量解析/エラー通知基盤（Cloudflare Workers + D1）です。
仕様は [docs/spec.md](./docs/spec.md) を参照してください。

## 構成

```
worker/        収集 Worker（Hono + D1 + KV + R2）
sdk/           フロントエンド SDK（依存ゼロ・TypeScript）
docs/spec.md   仕様書（ポリシー・データモデル・API・運用方針）
```

## Worker

- エンドポイント: `POST /events` `/events/batch` `/errors`, `GET /metrics`, `GET /dashboard`, `POST /admin/export`
- 1リクエスト=1トランザクションで raw_events / daily_event_counts / session_summaries を書き込み（§25.7）
- 総量上限超過は fetch=429+Retry-After / beacon=静かにドロップ（§16）
- Cron: 日次 retention + セッション集計、毎時 容量チェック、月次 R2 export（§19.4）

```bash
cd worker
pnpm install
pnpm test                                  # 27 tests
pnpm exec wrangler d1 migrations apply frontping --local
pnpm exec wrangler dev                     # ローカル起動
```

デプロイは [worker/DEPLOY.ja.md](./worker/DEPLOY.ja.md)。

## SDK

```bash
cd sdk
pnpm install && pnpm test                  # 11 tests
pnpm run build                             # dist/ に出力
```

使い方:

```ts
import { createAnalytics } from "@frontping/sdk";

const analytics = createAnalytics({
  endpoint: "https://frontping.example.workers.dev",
  appId: "product_recommender",
  widgetId: "main",
  flowVersion: "2026-06-01",
});

analytics.trackPageView();
analytics.trackClick("start_button");

// 標準イベントは型付き済み。track() 1本で送れ、イベントごとの関数は不要
analytics.track("widget_opened");
analytics.track("flow_started");
analytics.track("step_viewed", { step: 1 });
analytics.track("choice_selected", { step: 1, choice_id: "budget_low" });
analytics.track("recommendation_shown", { result_id: "plan_basic", step_count: 4, elapsed_ms: 8200 });
analytics.track("recommendation_accepted", { result_id: "plan_basic" });

// エラー（即時送信）
window.addEventListener("error", (e) => {
  analytics.trackError(e.message, { stack: e.error?.stack, source: e.filename });
});
```

アプリ固有イベントは関数を増やさず、型マップを渡すだけ:

```ts
interface MyEvents {
  coffee_purchased: { sku: string; price: number };
}
const analytics = createAnalytics<MyEvents>({ endpoint, appId: "shop" });

analytics.track("coffee_purchased", { sku: "drip_01", price: 1200 }); // 名前・属性とも型チェック
analytics.track("page_view"); // 標準イベントも引き続き使える
```

- session_id はタブ単位で自動生成（§17.2）
- イベントは5秒間隔／20件でバッチ送信、離脱時は sendBeacon（§17.4/§17.5）
- 429 を受けたら Retry-After の間は送信停止しイベントを破棄（リトライしない, §17.6）
- 送信失敗はユーザーに見せない（§22.1）

## ダッシュボード

`GET /dashboard` を開き、app_id と metrics token を入力すると主要指標を表示（§18.1）。
読み取り専用・同一オリジンで `/metrics` を呼ぶ。
