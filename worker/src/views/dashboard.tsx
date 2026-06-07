import type { Summary, Timeseries } from "../db/metrics";
import dashboardChartJs from "./dashboard-chart.client.js";
import { DashboardLayout } from "./Layout";

// 詳細ビューに渡すデータ。サーバ側で集計して埋め込む（§18.1）。
export type DashboardDetail = {
  app: string;
  from: string;
  to: string;
  summary: Summary;
  ts24: Timeseries;
  ts30: Timeseries;
};

const num = (v: number | null) => (v == null ? "—" : Number(v).toLocaleString());
const pct = (v: number | null) => (v == null ? "—" : Math.round(v * 1000) / 10 + "%");

const Card = (props: { k: string; v: string }) => (
  <div class="card">
    <div class="v">{props.v}</div>
    <div class="k">{props.k}</div>
  </div>
);

const SummaryCards = (props: { s: Summary }) => {
  const s = props.s;
  return (
    <div class="cards">
      <Card k="page views" v={num(s.page_views)} />
      <Card k="clicks" v={num(s.clicks)} />
      <Card k="sessions" v={num(s.sessions)} />
      <Card k="started" v={num(s.started_sessions)} />
      <Card k="completed" v={num(s.completed_sessions)} />
      <Card k="accepted" v={num(s.accepted_sessions)} />
      <Card k="errored sessions" v={num(s.errored_sessions)} />
      <Card k="error events" v={num(s.error_events)} />
      <Card k="completion rate" v={pct(s.completion_rate)} />
      <Card k="acceptance rate" v={pct(s.acceptance_rate)} />
      <Card k="error rate" v={pct(s.error_rate)} />
    </div>
  );
};

function chartScript(ts24: Timeseries, ts30: Timeseries): string {
  // </script> 終端や HTML パース混入を避けるため < をエスケープしてから埋め込む
  const data = JSON.stringify({ c24: ts24, c30: ts30 }).replace(/</g, "\\u003c");
  return `(function(){var TS=${data};${dashboardChartJs}\nrenderDashboardCharts(TS);})();`;
}

const ServiceList = (props: { apps: string[] }) => (
  <section>
    <h2>サービス一覧</h2>
    {props.apps.length ? (
      <div class="services">
        {props.apps.map((a) => (
          <a class="service" href={`/dashboard?app=${encodeURIComponent(a)}`}>
            {a}
          </a>
        ))}
      </div>
    ) : (
      <p class="muted">表示できるサービスがありません。</p>
    )}
  </section>
);

const Detail = (props: { d: DashboardDetail }) => {
  const d = props.d;
  return (
    <section>
      <p>
        <a href="/dashboard">← サービス一覧へ</a>
      </p>
      <h2>{d.app}</h2>
      <form method="get" action="/dashboard">
        <input type="hidden" name="app" value={d.app} />
        <label>
          from
          <input name="from" type="date" value={d.from} />
        </label>
        <label>
          to
          <input name="to" type="date" value={d.to} />
        </label>
        <button type="submit">更新</button>
      </form>
      <SummaryCards s={d.summary} />
      <h3>過去24時間（5分粒度・時刻はローカルTZ）</h3>
      <div class="chart" id="c24"></div>
      <h3>過去30日（日別）</h3>
      <div class="chart" id="c30"></div>
      <script dangerouslySetInnerHTML={{ __html: chartScript(d.ts24, d.ts30) }} />
    </section>
  );
};

const DashboardPage = (props: { apps: string[]; detail: DashboardDetail | null }) => (
  <DashboardLayout>{props.detail ? <Detail d={props.detail} /> : <ServiceList apps={props.apps} />}</DashboardLayout>
);

export const renderDashboardPage = (apps: string[], detail: DashboardDetail | null): string =>
  "<!doctype html>" + String(<DashboardPage apps={apps} detail={detail} />);
