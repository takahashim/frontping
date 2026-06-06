import { SELF, env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import { exportMonth, monthRange, previousMonth, toCSV } from "../src/db/exporter";
import { sessionAuth } from "./helpers";

const ORIGIN = "https://app.example.com";

async function seed(): Promise<void> {
  // 2026-05 のデータを直接投入
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO daily_event_counts (day, app_id, event_name, count) VALUES ('2026-05-10','test_app','page_view',42)`
    ),
    env.DB.prepare(
      `INSERT INTO daily_session_metrics (day, app_id, widget_id, flow_version, sessions, completed_sessions) VALUES ('2026-05-10','test_app','main','v1',10,4)`
    ),
    env.DB.prepare(
      `INSERT INTO session_summaries (session_id, app_id, started_at, max_step, completed) VALUES ('s1','test_app','2026-05-10T08:00:00.000Z',3,1)`
    ),
    env.DB.prepare(
      `INSERT INTO error_events (occurred_at, app_id, message, fingerprint) VALUES ('2026-05-10T09:00:00.000Z','test_app','boom','fp1')`
    ),
    // 範囲外（6月）はエクスポートされないこと
    env.DB.prepare(
      `INSERT INTO daily_event_counts (day, app_id, event_name, count) VALUES ('2026-06-01','test_app','page_view',99)`
    ),
  ]);
}

async function readGz(key: string): Promise<string> {
  const obj = await env.EXPORTS!.get(key);
  if (!obj) return "";
  const ds = new DecompressionStream("gzip");
  const stream = obj.body!.pipeThrough(ds);
  return await new Response(stream).text();
}

describe("export helpers", () => {
  it("monthRange computes exclusive next-month bound", () => {
    const r = monthRange(2026, 12);
    expect(r.dayStart).toBe("2026-12-01");
    expect(r.dayNext).toBe("2027-01-01");
  });

  it("previousMonth handles year boundary", () => {
    const jan = Date.parse("2026-01-01T04:00:00Z");
    expect(previousMonth(jan)).toEqual({ year: 2025, month: 12 });
  });

  it("toCSV escapes commas and quotes", () => {
    const csv = toCSV(["a", "b"], [{ a: 'x,"y"', b: 1 }]);
    expect(csv).toBe('a,b\n"x,""y""",1\n');
  });
});

describe("exportMonth (§20)", () => {
  beforeEach(async () => {
    await seed();
  });

  it("writes CSV and gzipped JSONL to the spec paths", async () => {
    const { written } = await exportMonth(env, "test_app", 2026, 5);
    expect(written).toContain("analytics-exports/test_app/daily_event_counts/2026/05.csv");
    expect(written).toContain("analytics-exports/test_app/daily_session_metrics/2026/05.csv");
    expect(written).toContain("analytics-exports/test_app/session_summaries/2026/05.jsonl.gz");
    expect(written).toContain("analytics-exports/test_app/error_events/2026/05.jsonl.gz");

    const dec = await env.EXPORTS!.get("analytics-exports/test_app/daily_event_counts/2026/05.csv");
    const csv = await dec!.text();
    expect(csv).toContain("day,app_id,event_name");
    expect(csv).toContain("2026-05-10,test_app,page_view");
    expect(csv).toContain(",42"); // count
    expect(csv).not.toContain("99"); // 6月分は範囲外

    const ssText = await readGz("analytics-exports/test_app/session_summaries/2026/05.jsonl.gz");
    expect(JSON.parse(ssText.trim()).session_id).toBe("s1");

    const eeText = await readGz("analytics-exports/test_app/error_events/2026/05.jsonl.gz");
    expect(JSON.parse(eeText.trim()).message).toBe("boom");
  });

  it("is idempotent: re-export overwrites the same key (§20.5)", async () => {
    const key = "analytics-exports/test_app/daily_event_counts/2026/05.csv";
    await exportMonth(env, "test_app", 2026, 5);
    const first = await (await env.EXPORTS!.get(key))!.text();
    await exportMonth(env, "test_app", 2026, 5);
    const list = await env.EXPORTS!.list({ prefix: "analytics-exports/test_app/daily_event_counts/" });
    const second = await (await env.EXPORTS!.get(key))!.text();
    // 上書きされ内容は同一、オブジェクトは1つ（追記されない）
    expect(second).toBe(first);
    expect(list.objects.length).toBe(1);
  });
});

describe("POST /admin/export (§20.1)", () => {
  beforeEach(async () => {
    await seed();
  });

  it("requires auth", async () => {
    const res = await SELF.fetch("https://worker.test/admin/export?app_id=test_app&year=2026&month=5", {
      method: "POST",
      headers: { Origin: ORIGIN },
    });
    expect(res.status).toBe(401);
  });

  it("triggers export with a valid session", async () => {
    const res = await SELF.fetch("https://worker.test/admin/export?app_id=test_app&year=2026&month=5", {
      method: "POST",
      headers: await sessionAuth(),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; written: string[] };
    expect(json.ok).toBe(true);
    expect(json.written.length).toBeGreaterThan(0);
  });
});
