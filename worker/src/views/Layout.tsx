import type { Child } from "hono/jsx";
import dashboardCss from "./dashboard.css";

// 全画面共通の HTML シェル。head（title/style）と body だけを持つ最小の土台。
export const BaseHtml = (props: { title: string; css: string; children?: Child }) => (
  <html lang="ja">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <meta name="robots" content="noindex" />
      <title>{props.title}</title>
      <style dangerouslySetInnerHTML={{ __html: props.css }} />
    </head>
    <body>{props.children}</body>
  </html>
);

// ダッシュボード画面（一覧・詳細など）共通の chrome。ヘッダ＋logout を付ける。
// 画面を増やすときは <DashboardLayout> でラップして中身だけ書けばよい。
export const DashboardLayout = (props: { children?: Child }) => (
  <BaseHtml title="frontping dashboard" css={dashboardCss}>
    <header>
      <h1>📈 frontping dashboard</h1>
      <a href="/dashboard/logout" class="muted">
        logout
      </a>
    </header>
    {props.children}
  </BaseHtml>
);
