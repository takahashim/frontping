// §18.1 読み取り専用ダッシュボード。
// 2画面構成: サービス一覧（#） → サービス詳細（#app=<id>）。
// 運用者セッション or OAuth 未設定時に、サーバが __FRONTPING_APPS__ へアプリ一覧を埋め込む。

// GitHub OAuth の設定が中途半端なときに出す案内ページ（値は出さず、未設定の名前だけ）。
export function oauthConfigErrorHtml(missing: string[]): string {
  const list = missing.map((m) => `<code>${m}</code>`).join(", ");
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" /><title>frontping</title>
<style>body{font:14px/1.7 system-ui,sans-serif;margin:0;padding:40px;max-width:640px}
code{background:#f3f4f6;padding:1px 5px;border-radius:4px}pre{background:#f3f4f6;padding:12px;border-radius:8px}
.muted{color:#888}</style></head><body>
<h1>⚠️ GitHub ログインの設定が未完了です</h1>
<p>ダッシュボードの認証に必要な secret が一部不足しています。設定を確認してください。</p>
<p>未設定: ${list}</p>
<pre>cd worker
pnpm exec wrangler secret put &lt;NAME&gt;</pre>
<p class="muted">4つ全て設定すると GitHub ログインが有効になります。<br>
すべて未設定にすると認証なし（トークン運用）に戻ります。</p>
</body></html>`;
}

// ログアウト後の着地ページ。/dashboard へ戻すと OAuth の SSO で即再ログインするため、
// 明示的な「ログアウトしました」を出してループを断つ。再ログインはリンクから能動的に。
export const LOGGED_OUT_HTML = `<!doctype html><html lang="ja"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" /><title>frontping</title>
<style>body{font:14px/1.7 system-ui,sans-serif;margin:0;padding:40px;max-width:640px}
a{color:#2563eb}.muted{color:#888}</style></head><body>
<h1>ログアウトしました</h1>
<p class="muted">このダッシュボードのセッションを破棄し、GitHub アプリの認可も取り消しました。</p>
<p><a href="/dashboard">再度ログイン</a></p>
<p class="muted">次回ログイン時は GitHub の認可（許可）画面が再表示されます。<br>
GitHub 自体のログインは解除されません（共有端末では GitHub 側もサインアウトしてください）。</p>
</body></html>`;

export const DASHBOARD_HTML = `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<title>frontping dashboard</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 14px/1.5 system-ui, sans-serif; margin: 0; padding: 24px; max-width: 920px; }
  header { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 16px; }
  h1 { font-size: 18px; margin: 0; }
  h2 { font-size: 15px; margin: 18px 0 10px; }
  h3 { font-size: 13px; margin: 22px 0 8px; color: #444; }
  a { color: #2563eb; text-decoration: none; }
  .services { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 12px; }
  .service { display: block; border: 1px solid #ddd; border-radius: 10px; padding: 16px; font-weight: 600; }
  .service:hover { border-color: #2563eb; }
  form { display: flex; flex-wrap: wrap; gap: 8px; align-items: end; margin-bottom: 16px; }
  label { display: flex; flex-direction: column; font-size: 12px; color: #666; gap: 2px; }
  input { font: inherit; padding: 6px 8px; border: 1px solid #bbb; border-radius: 6px; }
  button { font: inherit; padding: 7px 14px; border: 0; border-radius: 6px; background: #2563eb; color: #fff; cursor: pointer; }
  button:disabled { opacity: .5; cursor: default; }
  .cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 12px; }
  .card { border: 1px solid #ddd; border-radius: 10px; padding: 12px 14px; }
  .card .v { font-size: 24px; font-weight: 600; }
  .card .k { font-size: 12px; color: #666; }
  .err { color: #b91c1c; margin: 12px 0; white-space: pre-wrap; }
  .muted { color: #999; }
  .chart { border: 1px solid #ddd; border-radius: 10px; padding: 10px 12px; }
  .chart svg { display: block; }
  .legend { font-size: 12px; margin-top: 6px; display: flex; gap: 14px; flex-wrap: wrap; }
  .axis { display: flex; justify-content: space-between; font-size: 11px; margin-top: 2px; }
  .hidden { display: none; }
</style>
</head>
<body>
<header>
  <h1>☕ frontping dashboard</h1>
  <a href="/dashboard/logout" class="muted">logout</a>
</header>

<!-- 一覧ビュー -->
<section id="view-list">
  <h2>サービス一覧</h2>
  <div id="services" class="services"></div>
</section>

<!-- 詳細ビュー -->
<section id="view-detail" class="hidden">
  <p><a href="#" id="back">← サービス一覧へ</a></p>
  <h2 id="title"></h2>
  <form id="range">
    <label>from<input id="from" type="date" /></label>
    <label>to<input id="to" type="date" /></label>
    <button id="go" type="submit">更新</button>
  </form>
  <div id="msg" class="err"></div>
  <div id="out" class="cards"></div>
  <h3>過去24時間（5分粒度・時刻はローカルTZ）</h3>
  <div class="chart" id="c24"></div>
  <h3>過去30日（日別）</h3>
  <div class="chart" id="c30"></div>
</section>

<script>
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var APPS = __FRONTPING_APPS__; // サーバが埋め込む（運用者セッション時のみ非空）

  function pct(v) { return v == null ? "—" : (Math.round(v * 1000) / 10) + "%"; }
  function num(v) { return v == null ? "—" : Number(v).toLocaleString(); }
  function card(k, v) { return '<div class="card"><div class="v">' + v + '</div><div class="k">' + k + '</div></div>'; }
  // 認証は同一オリジンの Cookie（GitHub セッション）に任せる。ローカル開発は dev バイパス。

  // ---- チャート描画 ----
  var SVGNS = "http://www.w3.org/2000/svg";
  function svgEl(name, attrs) { var e = document.createElementNS(SVGNS, name); for (var k in attrs) e.setAttribute(k, attrs[k]); return e; }
  var SERIES = [
    { key: "page_views", label: "page views", color: "#2563eb" },
    { key: "clicks", label: "clicks", color: "#16a34a" },
    { key: "errors", label: "errors", color: "#dc2626" }
  ];
  function renderChart(elId, data) {
    var el = $(elId); el.innerHTML = "";
    var W = 620, H = 130, pad = 6, n = data.buckets.length, max = 1;
    SERIES.forEach(function (s) { (data.series[s.key] || []).forEach(function (v) { if (v > max) max = v; }); });
    var svg = svgEl("svg", { viewBox: "0 0 " + W + " " + H, width: "100%", height: H, preserveAspectRatio: "none" });
    SERIES.forEach(function (s) {
      var vals = data.series[s.key] || [];
      var pts = vals.map(function (v, i) {
        var x = n <= 1 ? pad : (i / (n - 1)) * (W - 2 * pad) + pad;
        var y = H - pad - (v / max) * (H - 2 * pad);
        return x.toFixed(1) + "," + y.toFixed(1);
      }).join(" ");
      svg.appendChild(svgEl("polyline", { points: pts, fill: "none", stroke: s.color, "stroke-width": "2" }));
    });
    el.appendChild(svg);
    var leg = document.createElement("div"); leg.className = "legend";
    leg.innerHTML = SERIES.map(function (s) { return '<span style="color:' + s.color + '">● ' + s.label + "</span>"; }).join("")
      + '<span class="muted">最大 ' + max + " / " + data.unit + "</span>";
    el.appendChild(leg);
    function fmtTick(b) {
      if (data.unit === "day") return b;
      var d = new Date(b + ":00Z");
      return isNaN(d.getTime()) ? b.slice(11) : d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    }
    var ax = document.createElement("div"); ax.className = "axis muted";
    var ticks = Math.min(6, n), parts = [];
    for (var t = 0; t < ticks; t++) {
      var bi = ticks <= 1 ? 0 : Math.round((t / (ticks - 1)) * (n - 1));
      parts.push("<span>" + fmtTick(data.buckets[bi] || "") + "</span>");
    }
    ax.innerHTML = parts.join("");
    el.appendChild(ax);
  }
  function loadChart(app, range, elId) {
    var q = new URLSearchParams({ app_id: app, range: range });
    fetch("/metrics/timeseries?" + q.toString())
      .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
      .then(function (d) { renderChart(elId, d); })
      .catch(function (e) { $(elId).textContent = String(e); });
  }
  function renderSummary(s) {
    $("out").innerHTML = [
      card("page views", num(s.page_views)), card("clicks", num(s.clicks)),
      card("sessions", num(s.sessions)), card("started", num(s.started_sessions)),
      card("completed", num(s.completed_sessions)), card("accepted", num(s.accepted_sessions)),
      card("errored sessions", num(s.errored_sessions)), card("error events", num(s.error_events)),
      card("completion rate", pct(s.completion_rate)), card("acceptance rate", pct(s.acceptance_rate)),
      card("error rate", pct(s.error_rate))
    ].join("");
  }

  // ---- 詳細ビュー ----
  var current = null;
  function loadDetail(app) {
    current = app;
    $("title").textContent = app;
    $("msg").textContent = "";
    $("out").innerHTML = '<span class="muted">loading…</span>';
    var q = new URLSearchParams({ app_id: app });
    if ($("from").value) q.set("from", $("from").value);
    if ($("to").value) q.set("to", $("to").value);
    fetch("/metrics?" + q.toString())
      .then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status + (r.status === 401 ? " (未認証: GitHub ログインが必要)" : ""));
        return r.json();
      })
      .then(function (j) { renderSummary(j.summary); loadChart(app, "24h", "c24"); loadChart(app, "30d", "c30"); })
      .catch(function (err) { $("out").innerHTML = ""; $("msg").textContent = String(err); });
  }

  // ---- 一覧ビュー ----
  function renderList() {
    if (APPS && APPS.length) {
      $("services").innerHTML = APPS.map(function (a) {
        return '<a class="service" href="#app=' + encodeURIComponent(a) + '">' + a + "</a>";
      }).join("");
    } else {
      $("services").innerHTML = '<p class="muted">表示できるサービスがありません。</p>';
    }
  }

  function show(view) {
    $("view-list").classList.toggle("hidden", view !== "list");
    $("view-detail").classList.toggle("hidden", view !== "detail");
  }

  function route() {
    var m = /(?:^|#)app=([^&]+)/.exec(location.hash);
    if (m) { show("detail"); loadDetail(decodeURIComponent(m[1])); }
    else { show("list"); renderList(); }
  }

  // 期間更新
  $("range").addEventListener("submit", function (e) {
    e.preventDefault();
    if (current) loadDetail(current);
  });
  $("back").addEventListener("click", function (e) { e.preventDefault(); location.hash = ""; });

  window.addEventListener("hashchange", route);
  route();
})();
</script>
</body>
</html>`;
