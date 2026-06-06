// §18.1 最小の読み取り専用ダッシュボード。
// Worker 自身が同一オリジンで配信し、GET /metrics を叩いて主要指標を表示する。
// token はページで入力し sessionStorage に保持（コードには埋め込まない）。

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
  h1 { font-size: 18px; margin: 0 0 16px; }
  form { display: flex; flex-wrap: wrap; gap: 8px; align-items: end; margin-bottom: 20px; }
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
  h2 { font-size: 14px; margin: 24px 0 8px; color: #444; }
  .chart { border: 1px solid #ddd; border-radius: 10px; padding: 10px 12px; }
  .chart svg { display: block; }
  .legend { font-size: 12px; margin-top: 6px; display: flex; gap: 14px; flex-wrap: wrap; }
  .axis { display: flex; justify-content: space-between; font-size: 11px; margin-top: 2px; }
</style>
</head>
<body>
<h1>frontping dashboard</h1>
<form id="f">
  <label>app_id<input id="app" placeholder="product_recommender" required /></label>
  <label>from<input id="from" type="date" /></label>
  <label>to<input id="to" type="date" /></label>
  <label>token<input id="token" type="password" placeholder="GitHub ログイン中は空でOK" /></label>
  <button id="go" type="submit">Load</button>
  <a href="/dashboard/logout" class="muted" style="align-self:center">logout</a>
</form>
<div id="msg" class="err"></div>
<div id="out" class="cards"></div>
<h2>過去24時間（時間別）</h2>
<div class="chart" id="c24"></div>
<h2>過去30日（日別）</h2>
<div class="chart" id="c30"></div>

<script>
(function () {
  var $ = function (id) { return document.getElementById(id); };
  // 復元（token は sessionStorage、タブを閉じれば消える）
  $("app").value = sessionStorage.getItem("fp_app") || "";
  $("token").value = sessionStorage.getItem("fp_token") || "";

  function pct(v) { return v == null ? "—" : (Math.round(v * 1000) / 10) + "%"; }
  function num(v) { return v == null ? "—" : Number(v).toLocaleString(); }

  function card(k, v) {
    return '<div class="card"><div class="v">' + v + '</div><div class="k">' + k + '</div></div>';
  }

  var SVGNS = "http://www.w3.org/2000/svg";
  function svgEl(name, attrs) {
    var e = document.createElementNS(SVGNS, name);
    for (var k in attrs) e.setAttribute(k, attrs[k]);
    return e;
  }

  var SERIES = [
    { key: "page_views", label: "page views", color: "#2563eb" },
    { key: "clicks", label: "clicks", color: "#16a34a" },
    { key: "errors", label: "errors", color: "#dc2626" }
  ];

  function renderChart(elId, data) {
    var el = $(elId);
    el.innerHTML = "";
    var W = 620, H = 130, pad = 6;
    var n = data.buckets.length;
    var max = 1;
    SERIES.forEach(function (s) {
      (data.series[s.key] || []).forEach(function (v) { if (v > max) max = v; });
    });
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

    var leg = document.createElement("div");
    leg.className = "legend";
    var html = SERIES.map(function (s) {
      return '<span style="color:' + s.color + '">● ' + s.label + "</span>";
    }).join("");
    html += '<span class="muted">最大 ' + max + " / " + data.unit + "</span>";
    leg.innerHTML = html;
    el.appendChild(leg);

    // バケットは UTC。時刻ラベルは閲覧ブラウザのローカルTZに変換して表示する。
    function fmtTick(b) {
      if (data.unit === "day") return b; // 'YYYY-MM-DD'（日付はそのまま）
      var d = new Date(b + ":00Z"); // 'YYYY-MM-DDTHH:MM' を UTC として解釈
      return isNaN(d.getTime())
        ? b.slice(11)
        : d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    }

    var ax = document.createElement("div");
    ax.className = "axis muted";
    var ticks = Math.min(6, n);
    var parts = [];
    for (var t = 0; t < ticks; t++) {
      var bi = ticks <= 1 ? 0 : Math.round((t / (ticks - 1)) * (n - 1));
      parts.push("<span>" + fmtTick(data.buckets[bi] || "") + "</span>");
    }
    ax.innerHTML = parts.join("");
    el.appendChild(ax);
  }

  // token があれば Bearer、無ければ Cookie（GitHub セッション）に任せる
  function authHeaders(token) { return token ? { Authorization: "Bearer " + token } : {}; }

  function loadChart(app, token, range, elId) {
    var q = new URLSearchParams({ app_id: app, range: range });
    fetch("/metrics/timeseries?" + q.toString(), { headers: authHeaders(token) })
      .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
      .then(function (d) { renderChart(elId, d); })
      .catch(function (e) { $(elId).textContent = String(e); });
  }

  function render(s) {
    $("out").innerHTML = [
      card("page views", num(s.page_views)),
      card("clicks", num(s.clicks)),
      card("sessions", num(s.sessions)),
      card("started", num(s.started_sessions)),
      card("completed", num(s.completed_sessions)),
      card("accepted", num(s.accepted_sessions)),
      card("errored sessions", num(s.errored_sessions)),
      card("error events", num(s.error_events)),
      card("completion rate", pct(s.completion_rate)),
      card("acceptance rate", pct(s.acceptance_rate)),
      card("error rate", pct(s.error_rate))
    ].join("");
  }

  $("f").addEventListener("submit", function (e) {
    e.preventDefault();
    var app = $("app").value.trim();
    var token = $("token").value.trim();
    sessionStorage.setItem("fp_app", app);
    sessionStorage.setItem("fp_token", token);
    $("msg").textContent = "";
    $("out").innerHTML = '<span class="muted">loading…</span>';
    $("go").disabled = true;

    var q = new URLSearchParams({ app_id: app });
    if ($("from").value) q.set("from", $("from").value);
    if ($("to").value) q.set("to", $("to").value);

    fetch("/metrics?" + q.toString(), { headers: authHeaders(token) })
      .then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status + (r.status === 401 ? " (未認証: GitHub ログインか token が必要)" : ""));
        return r.json();
      })
      .then(function (j) {
        render(j.summary);
        loadChart(app, token, "24h", "c24");
        loadChart(app, token, "30d", "c30");
      })
      .catch(function (err) { $("out").innerHTML = ""; $("msg").textContent = String(err); })
      .finally(function () { $("go").disabled = false; });
  });
})();
</script>
</body>
</html>`;
