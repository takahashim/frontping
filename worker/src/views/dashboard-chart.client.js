var SVGNS = "http://www.w3.org/2000/svg";
var SERIES = [
  { key: "page_views", label: "page views", color: "#2563eb" },
  { key: "clicks", label: "clicks", color: "#16a34a" },
  { key: "errors", label: "errors", color: "#dc2626" },
];

function svgEl(name, attrs) {
  var e = document.createElementNS(SVGNS, name);
  for (var k in attrs) e.setAttribute(k, attrs[k]);
  return e;
}

function fmtTick(bucket, unit) {
  if (unit === "day") return bucket;
  var d = new Date(bucket + ":00Z");
  return isNaN(d.getTime())
    ? bucket.slice(11)
    : d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function renderChart(elId, data) {
  var el = document.getElementById(elId);
  el.innerHTML = "";

  var W = 620;
  var H = 130;
  var pad = 6;
  var n = data.buckets.length;
  var max = 1;

  SERIES.forEach(function (s) {
    (data.series[s.key] || []).forEach(function (v) {
      if (v > max) max = v;
    });
  });

  var svg = svgEl("svg", {
    viewBox: "0 0 " + W + " " + H,
    width: "100%",
    height: H,
    preserveAspectRatio: "none",
  });

  SERIES.forEach(function (s) {
    var vals = data.series[s.key] || [];
    var pts = vals
      .map(function (v, i) {
        var x = n <= 1 ? pad : (i / (n - 1)) * (W - 2 * pad) + pad;
        var y = H - pad - (v / max) * (H - 2 * pad);
        return x.toFixed(1) + "," + y.toFixed(1);
      })
      .join(" ");
    svg.appendChild(svgEl("polyline", { points: pts, fill: "none", stroke: s.color, "stroke-width": "2" }));
  });

  el.appendChild(svg);

  var legend = document.createElement("div");
  legend.className = "legend";
  legend.innerHTML =
    SERIES.map(function (s) {
      return '<span style="color:' + s.color + '">● ' + s.label + "</span>";
    }).join("") +
    '<span class="muted">最大 ' +
    max +
    " / " +
    data.unit +
    "</span>";
  el.appendChild(legend);

  var axis = document.createElement("div");
  axis.className = "axis muted";
  var ticks = Math.min(6, n);
  var parts = [];
  for (var t = 0; t < ticks; t++) {
    var bi = ticks <= 1 ? 0 : Math.round((t / (ticks - 1)) * (n - 1));
    parts.push("<span>" + fmtTick(data.buckets[bi] || "", data.unit) + "</span>");
  }
  axis.innerHTML = parts.join("");
  el.appendChild(axis);
}

function renderDashboardCharts(ts) {
  renderChart("c24", ts.c24);
  renderChart("c30", ts.c30);
}
