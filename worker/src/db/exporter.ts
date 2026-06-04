import type { Env } from "../types";

// §20 R2 月次 export。
// §20.5 同一パスを上書き（PUT 置換）する冪等操作。追記しない。

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

export interface MonthRange {
  year: number;
  month: number; // 1-12
  dayStart: string; // 'YYYY-MM-01'
  dayNext: string; // 翌月 'YYYY-MM-01'（排他上限）
  isoStart: string;
  isoNext: string;
}

export function monthRange(year: number, month: number): MonthRange {
  const ny = month === 12 ? year + 1 : year;
  const nm = month === 12 ? 1 : month + 1;
  const dayStart = `${year}-${pad2(month)}-01`;
  const dayNext = `${ny}-${pad2(nm)}-01`;
  return {
    year,
    month,
    dayStart,
    dayNext,
    isoStart: `${dayStart}T00:00:00.000Z`,
    isoNext: `${dayNext}T00:00:00.000Z`,
  };
}

// Cron 実行時刻（月初）の「前月」を返す（§19.4 月次ジョブ）
export function previousMonth(nowMs: number): { year: number; month: number } {
  const d = new Date(nowMs);
  let y = d.getUTCFullYear();
  let m = d.getUTCMonth(); // 0-11 = 当月-1 を表すので、そのまま「前月の1-index」になる
  if (m === 0) {
    y -= 1;
    m = 12;
  }
  return { year: y, month: m };
}

// ---- フォーマッタ ----

function csvCell(v: unknown): string {
  if (v == null) return "";
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCSV(columns: string[], rows: Record<string, unknown>[]): string {
  const head = columns.join(",");
  const body = rows.map((r) => columns.map((c) => csvCell(r[c])).join(",")).join("\n");
  return rows.length ? `${head}\n${body}\n` : `${head}\n`;
}

function toJSONL(rows: Record<string, unknown>[]): string {
  return rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : "");
}

async function gzip(input: string): Promise<Uint8Array> {
  const cs = new CompressionStream("gzip");
  const stream = new Response(input).body!.pipeThrough(cs);
  const buf = await new Response(stream).arrayBuffer();
  return new Uint8Array(buf);
}

// ---- export 本体 ----

async function putCSV(
  env: Env,
  key: string,
  columns: string[],
  rows: Record<string, unknown>[]
): Promise<void> {
  if (rows.length === 0) return; // 空はスキップ（冪等: 既存を無闇に消さない）
  await env.EXPORTS!.put(key, toCSV(columns, rows), {
    httpMetadata: { contentType: "text/csv" },
  });
}

async function putJSONLGz(env: Env, key: string, rows: Record<string, unknown>[]): Promise<void> {
  if (rows.length === 0) return;
  const gz = await gzip(toJSONL(rows));
  await env.EXPORTS!.put(key, gz, {
    httpMetadata: { contentType: "application/gzip" },
  });
}

const DEC = (rows: { results: Record<string, unknown>[] }) => rows.results;

// 1 app・1か月分を export する（§20.2 優先度順）
export async function exportMonth(
  env: Env,
  appId: string,
  year: number,
  month: number,
  opts: { includeRaw?: boolean } = {}
): Promise<{ written: string[] }> {
  if (!env.EXPORTS) return { written: [] };
  const r = monthRange(year, month);
  const base = `analytics-exports/${appId}`;
  const ym = `${r.year}/${pad2(r.month)}`;
  const written: string[] = [];

  // daily_event_counts (CSV)
  const dec = DEC(
    await env.DB.prepare(
      `SELECT day, app_id, event_name, page_path, widget_id, flow_version, step, target_id, choice_id, result_id, count
       FROM daily_event_counts WHERE app_id = ? AND day >= ? AND day < ? ORDER BY day`
    )
      .bind(appId, r.dayStart, r.dayNext)
      .all<Record<string, unknown>>()
  );
  const decKey = `${base}/daily_event_counts/${ym}.csv`;
  await putCSV(env, decKey, ["day", "app_id", "event_name", "page_path", "widget_id", "flow_version", "step", "target_id", "choice_id", "result_id", "count"], dec);
  if (dec.length) written.push(decKey);

  // daily_session_metrics (CSV)
  const dsm = DEC(
    await env.DB.prepare(
      `SELECT * FROM daily_session_metrics WHERE app_id = ? AND day >= ? AND day < ? ORDER BY day`
    )
      .bind(appId, r.dayStart, r.dayNext)
      .all<Record<string, unknown>>()
  );
  const dsmKey = `${base}/daily_session_metrics/${ym}.csv`;
  await putCSV(env, dsmKey, ["day", "app_id", "widget_id", "flow_version", "sessions", "opened_sessions", "started_sessions", "completed_sessions", "accepted_sessions", "rejected_sessions", "restarted_sessions", "errored_sessions", "total_duration_ms", "total_max_step"], dsm);
  if (dsm.length) written.push(dsmKey);

  // session_summaries (JSONL.gz)
  const ss = DEC(
    await env.DB.prepare(
      `SELECT * FROM session_summaries WHERE app_id = ? AND started_at >= ? AND started_at < ? ORDER BY started_at`
    )
      .bind(appId, r.isoStart, r.isoNext)
      .all<Record<string, unknown>>()
  );
  const ssKey = `${base}/session_summaries/${ym}.jsonl.gz`;
  await putJSONLGz(env, ssKey, ss);
  if (ss.length) written.push(ssKey);

  // error_events (JSONL.gz)
  const ee = DEC(
    await env.DB.prepare(
      `SELECT * FROM error_events WHERE app_id = ? AND occurred_at >= ? AND occurred_at < ? ORDER BY occurred_at`
    )
      .bind(appId, r.isoStart, r.isoNext)
      .all<Record<string, unknown>>()
  );
  const eeKey = `${base}/error_events/${ym}.jsonl.gz`;
  await putJSONLGz(env, eeKey, ee);
  if (ee.length) written.push(eeKey);

  // raw_events (JSONL.gz, 日別) — §20.2 必要な場合のみ
  if (opts.includeRaw) {
    const raw = DEC(
      await env.DB.prepare(
        `SELECT * FROM raw_events WHERE app_id = ? AND occurred_at >= ? AND occurred_at < ? ORDER BY occurred_at`
      )
        .bind(appId, r.isoStart, r.isoNext)
        .all<Record<string, unknown>>()
    );
    const byDay = new Map<string, Record<string, unknown>[]>();
    for (const row of raw) {
      const d = String(row.occurred_at).slice(8, 10);
      (byDay.get(d) ?? byDay.set(d, []).get(d)!).push(row);
    }
    for (const [d, rows] of byDay) {
      const key = `${base}/raw_events/${ym}/${d}.jsonl.gz`;
      await putJSONLGz(env, key, rows);
      written.push(key);
    }
  }

  return { written };
}

// 全 app の前月分を export する（月次 Cron から呼ぶ）
export async function exportPreviousMonth(
  env: Env,
  appIds: string[],
  nowMs: number
): Promise<void> {
  const { year, month } = previousMonth(nowMs);
  for (const appId of appIds) {
    await exportMonth(env, appId, year, month);
  }
}
