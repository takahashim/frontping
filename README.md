# frontping

English | [日本語](./README.ja.md)

A lightweight analytics / error notification backend for small frontends (Cloudflare Workers + D1).
See the specification in [docs/spec.md](./docs/spec.md).

## Layout

```
docs/spec.md   Specification (policy, data model, API, operations)
worker/        Collection Worker (Hono + D1 + KV + R2)
sdk/           Frontend SDK (zero-dependency, TypeScript)
```

## Worker

- Endpoints: `POST /events` `/events/batch` `/errors`, `GET /metrics`, `GET /dashboard`, `POST /admin/export`
- One request = one transaction, writing raw_events / daily_event_counts / session_summaries (§25.7)
- On exceeding volume limits: fetch → 429 + Retry-After, beacon → silently dropped (§16)
- Cron: daily retention + session aggregation, hourly capacity checks, monthly R2 export (§19.4)

```bash
cd worker
pnpm install
pnpm test                                  # 27 tests
pnpm exec wrangler d1 migrations apply frontping --local
pnpm exec wrangler dev                     # run locally
```

For deployment, see [worker/DEPLOY.md](./worker/DEPLOY.md).

## SDK

```bash
cd sdk
pnpm install && pnpm test                  # 11 tests
pnpm run build                             # outputs to dist/
```

Usage:

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

// Standard events are typed out of the box — one track(), no per-event functions
analytics.track("widget_opened");
analytics.track("flow_started");
analytics.track("step_viewed", { step: 1 });
analytics.track("choice_selected", { step: 1, choice_id: "budget_low" });
analytics.track("recommendation_shown", { result_id: "plan_basic", step_count: 4, elapsed_ms: 8200 });
analytics.track("recommendation_accepted", { result_id: "plan_basic" });

// Errors (sent immediately)
window.addEventListener("error", (e) => {
  analytics.trackError(e.message, { stack: e.error?.stack, source: e.filename });
});
```

App-specific events need no extra functions — just pass a type map:

```ts
interface MyEvents {
  coffee_purchased: { sku: string; price: number };
}
const analytics = createAnalytics<MyEvents>({ endpoint, appId: "shop" });

analytics.track("coffee_purchased", { sku: "drip_01", price: 1200 }); // name & props type-checked
analytics.track("page_view"); // standard events still available
```

- `session_id` is generated automatically per tab (§17.2)
- Events are batched (every 5s / 20 events) and flushed via sendBeacon on page exit (§17.4 / §17.5)
- On a 429, sending pauses for the Retry-After window and events are dropped (no retry, §17.6)
- Send failures are never surfaced to the user (§22.1)

## Dashboard

Open `GET /dashboard`, enter an app_id and metrics token to view the key metrics (§18.1).
It is read-only and calls `/metrics` from the same origin.
