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
</style>
</head>
<body>
<h1>frontping dashboard</h1>
<form id="f">
  <label>app_id<input id="app" placeholder="product_recommender" required /></label>
  <label>from<input id="from" type="date" /></label>
  <label>to<input id="to" type="date" /></label>
  <label>token<input id="token" type="password" placeholder="metrics token" required /></label>
  <button id="go" type="submit">Load</button>
</form>
<div id="msg" class="err"></div>
<div id="out" class="cards"></div>

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

    fetch("/metrics?" + q.toString(), { headers: { Authorization: "Bearer " + token } })
      .then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status + (r.status === 401 ? " (token 不正)" : ""));
        return r.json();
      })
      .then(function (j) { render(j.summary); })
      .catch(function (err) { $("out").innerHTML = ""; $("msg").textContent = String(err); })
      .finally(function () { $("go").disabled = false; });
  });
})();
</script>
</body>
</html>`;
