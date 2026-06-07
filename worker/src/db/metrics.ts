import type { Env } from "../types";

// §9.4 / §12 ダッシュボード用の集計クエリ。daily_* / raw_events から読み取る純粋関数。
// HTTP エンドポイントは持たず、/dashboard ルートがサーバ側で直接呼ぶ。

function ratio(num: number, den: number): number | null {
  return den === 0 ? null : num / den; // §18.3 分母0は null
}

export type Summary = {
  page_views: number;
  clicks: number;
  sessions: number;
  started_sessions: number;
  completed_sessions: number;
  accepted_sessions: number;
  errored_sessions: number;
  error_events: number;
  completion_rate: number | null;
  acceptance_rate: number | null;
  error_rate: number | null;
};

// 期間サマリ。イベント系は daily_event_counts、セッション系は daily_session_metrics から。
export async function querySummary(
  env: Env,
  appId: string,
  from: string,
  to: string
): Promise<Summary> {
  const ev = await env.DB.prepare(
    `SELECT event_name, SUM(count) AS n FROM daily_event_counts
     WHERE app_id = ? AND day >= ? AND day <= ?
     GROUP BY event_name`
  )
    .bind(appId, from, to)
    .all<{ event_name: string; n: number }>();
  const evMap = new Map(ev.results.map((r) => [r.event_name, r.n]));

  const s = await env.DB.prepare(
    `SELECT
        SUM(sessions) AS sessions,
        SUM(started_sessions) AS started,
        SUM(completed_sessions) AS completed,
        SUM(accepted_sessions) AS accepted,
        SUM(errored_sessions) AS errored
      FROM daily_session_metrics
      WHERE app_id = ? AND day >= ? AND day <= ?`
  )
    .bind(appId, from, to)
    .first<{ sessions: number; started: number; completed: number; accepted: number; errored: number }>();

  const sessions = s?.sessions ?? 0;
  const started = s?.started ?? 0;
  const completed = s?.completed ?? 0;
  const accepted = s?.accepted ?? 0;
  const errored = s?.errored ?? 0;

  return {
    page_views: evMap.get("page_view") ?? 0,
    clicks: evMap.get("click") ?? 0,
    sessions,
    started_sessions: started,
    completed_sessions: completed,
    accepted_sessions: accepted,
    errored_sessions: errored,
    error_events: (evMap.get("error_occurred") ?? 0) + (evMap.get("api_failed") ?? 0),
    completion_rate: ratio(completed, started),
    acceptance_rate: ratio(accepted, completed),
    error_rate: ratio(errored, sessions),
  };
}

// --- 時系列（ダッシュボードのグラフ用）---
// 24h: raw_events を5分バケットで集計（30日保存内なので取得可能）
// 30d: daily_event_counts を日バケットで集計（長期保存）

export type Timeseries = {
  range: "24h" | "30d";
  unit: "5min" | "day";
  buckets: string[];
  series: { page_views: number[]; clicks: number[]; errors: number[] };
};

type TsRow = { b: string; event_name: string; c: number };

function buildSeries(buckets: string[], rows: TsRow[]) {
  const idx = new Map(buckets.map((b, i) => [b, i]));
  const z = () => new Array<number>(buckets.length).fill(0);
  const series = { page_views: z(), clicks: z(), errors: z() };
  const add = (arr: number[], i: number, n: number) => {
    arr[i] = (arr[i] ?? 0) + n;
  };
  for (const r of rows) {
    const i = idx.get(r.b);
    if (i == null) continue;
    if (r.event_name === "page_view") add(series.page_views, i, r.c);
    else if (r.event_name === "click") add(series.clicks, i, r.c);
    else if (r.event_name === "error_occurred" || r.event_name === "api_failed") add(series.errors, i, r.c);
  }
  return series;
}

export async function queryTimeseries(
  env: Env,
  appId: string,
  range: "24h" | "30d",
  nowMs: number
): Promise<Timeseries> {
  if (range === "24h") {
    // 5分バケット × 288 本 = 24時間
    const FIVE = 5 * 60_000;
    const cur = Math.floor(nowMs / FIVE) * FIVE;
    const buckets: string[] = [];
    for (let i = 287; i >= 0; i--) buckets.push(new Date(cur - i * FIVE).toISOString().slice(0, 16));
    const startIso = new Date(cur - 287 * FIVE).toISOString().slice(0, 16) + ":00.000Z";
    // 分を5分単位に切り捨ててバケットキーを作る（'YYYY-MM-DDTHH:MM'）
    const rows = await env.DB.prepare(
      `SELECT substr(occurred_at,1,14) || printf('%02d', (CAST(substr(occurred_at,15,2) AS INTEGER) / 5) * 5) AS b,
              event_name, COUNT(*) AS c
       FROM raw_events WHERE app_id = ? AND occurred_at >= ? GROUP BY b, event_name`
    )
      .bind(appId, startIso)
      .all<TsRow>();
    return { range, unit: "5min", buckets, series: buildSeries(buckets, rows.results) };
  }

  const DAY = 86_400_000;
  const cur = Math.floor(nowMs / DAY) * DAY;
  const buckets: string[] = [];
  for (let i = 29; i >= 0; i--) buckets.push(new Date(cur - i * DAY).toISOString().slice(0, 10));
  const startDay = buckets[0];
  const rows = await env.DB.prepare(
    `SELECT day AS b, event_name, SUM(count) AS c
     FROM daily_event_counts WHERE app_id = ? AND day >= ? GROUP BY day, event_name`
  )
    .bind(appId, startDay)
    .all<TsRow>();
  return { range, unit: "day", buckets, series: buildSeries(buckets, rows.results) };
}
