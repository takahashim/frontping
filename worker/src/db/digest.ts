import type { AppConfig, Env } from "../types";
import { postWebhook } from "../lib/notify";

// 日次ダイジェスト（運用者向け）。前日分を「notification.enabled のアプリ」について
// 1メッセージにアプリ別セクションで集約する。活動ゼロのアプリは省略。

function pct(n: number, d: number): string {
  return d === 0 ? "—" : `${Math.round((n / d) * 1000) / 10}%`;
}

async function appSection(env: Env, appId: string, day: string): Promise<string | null> {
  const ev = await env.DB.prepare(
    `SELECT event_name, SUM(count) AS n FROM daily_event_counts WHERE app_id = ? AND day = ? GROUP BY event_name`
  )
    .bind(appId, day)
    .all<{ event_name: string; n: number }>();
  const m = new Map(ev.results.map((r) => [r.event_name, r.n]));
  const pv = m.get("page_view") ?? 0;
  const clicks = m.get("click") ?? 0;
  const errors = (m.get("error_occurred") ?? 0) + (m.get("api_failed") ?? 0);

  const s = await env.DB.prepare(
    `SELECT SUM(sessions) AS sessions, SUM(started_sessions) AS started,
            SUM(completed_sessions) AS completed, SUM(errored_sessions) AS errored
     FROM daily_session_metrics WHERE app_id = ? AND day = ?`
  )
    .bind(appId, day)
    .first<{ sessions: number; started: number; completed: number; errored: number }>();
  const sessions = s?.sessions ?? 0;

  if (!(pv || clicks || errors || sessions)) return null; // 活動ゼロは省略

  const top = await env.DB.prepare(
    `SELECT COUNT(*) AS c, COUNT(DISTINCT ip_hash) AS sources, MAX(message) AS msg FROM error_events
     WHERE app_id = ? AND substr(occurred_at, 1, 10) = ? AND fingerprint IS NOT NULL
     GROUP BY fingerprint ORDER BY c DESC LIMIT 1`
  )
    .bind(appId, day)
    .first<{ c: number; sources: number; msg: string }>();

  const lines = [
    `■ ${appId}`,
    `  page_views ${pv} / clicks ${clicks} / errors ${errors} / sessions ${sessions}`,
    `  completion ${pct(s?.completed ?? 0, s?.started ?? 0)} / error_rate ${pct(s?.errored ?? 0, sessions)}`,
  ];
  if (top && top.c > 0) {
    // sources は ip_hash 記録時のみ（未記録なら 0 のため hits だけ表示）
    const detail = top.sources > 0 ? `hits ${top.c}, sources ${top.sources}` : `hits ${top.c}`;
    lines.push(`  top error: ${top.msg} (${detail})`);
  }
  return lines.join("\n");
}

// ダイジェスト本文を組み立てる（送信しない・テスト容易）。送るものが無ければ null。
export async function buildDigest(
  env: Env,
  configs: Record<string, AppConfig>,
  day: string
): Promise<string | null> {
  const sections: string[] = [];
  for (const [appId, cfg] of Object.entries(configs)) {
    if (!cfg.notification?.enabled) continue;
    const sec = await appSection(env, appId, day);
    if (sec) sections.push(sec);
  }
  if (sections.length === 0) return null;
  return `[frontping] daily digest ${day}\n\n${sections.join("\n\n")}`;
}

export async function sendDailyDigest(
  env: Env,
  configs: Record<string, AppConfig>,
  day: string
): Promise<void> {
  const text = await buildDigest(env, configs, day);
  if (text) await postWebhook(env, text);
}
