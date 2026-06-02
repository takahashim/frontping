import { createAnalytics } from "/sdk.js";

// --- frontping 設定 ---
// endpoint はクエリで上書き可能: ?endpoint=http://localhost:8788
const ENDPOINT = new URLSearchParams(location.search).get("endpoint") || "http://localhost:8787";

// createAnalytics は型付き。analytics は Analytics 型に推論される（jsconfig.json で /sdk.js を解決）
const analytics = createAnalytics({
  endpoint: ENDPOINT,
  appId: "wizard_demo",
  widgetId: "coffee",
  flowVersion: "2026-06-02",
});

/** id 必須の要素取得（null を排除して型を HTMLElement に） */
function $(/** @type {string} */ id) {
  const el = document.getElementById(id);
  if (!el) throw new Error("missing #" + id);
  return el;
}

// 送信のたびにフッターのカウンタを更新し、即時 flush でデモを見やすくする
let sent = 0;
const fp = $("fp");
function bumpSent(/** @type {string} */ label) {
  sent += 1;
  fp.textContent = `${sent}件送信 (${label})`;
  analytics.flush();
}

/**
 * @typedef {{ id: string, label: string }} Choice
 * @typedef {{ prompt: string, choices: Choice[] }} Step
 */

// --- 診断フロー定義 ---
/** @type {Step[]} */
const STEPS = [
  {
    prompt: "ご予算の感覚は？",
    choices: [
      { id: "budget_low", label: "手軽に（〜3,000円）" },
      { id: "budget_mid", label: "そこそこ（〜1万円）" },
      { id: "budget_high", label: "こだわりたい（1万円〜）" },
    ],
  },
  {
    prompt: "好みの味わいは？",
    choices: [
      { id: "taste_light", label: "すっきり・軽め" },
      { id: "taste_balanced", label: "バランス重視" },
      { id: "taste_strong", label: "しっかり濃いめ" },
    ],
  },
  {
    prompt: "どのくらいの頻度で淹れますか？",
    choices: [
      { id: "freq_daily", label: "ほぼ毎日" },
      { id: "freq_sometimes", label: "ときどき" },
    ],
  },
];

/** @type {Record<string, { name: string, desc: string }>} */
const RESULTS = {
  plan_pourover: { name: "ハンドドリップ（ペーパー）", desc: "クリアで軽やかな味わい。香りを楽しみたい人に。" },
  plan_drip: { name: "ドリップ式コーヒーメーカー", desc: "ボタンひとつで安定した一杯。毎日の相棒に。" },
  plan_french: { name: "フレンチプレス", desc: "コクと油分をしっかり抽出。濃いめ好きに。" },
  plan_espresso: { name: "エスプレッソマシン", desc: "本格的な一杯を自宅で。こだわり派の決定版。" },
};

/** @param {string[]} answers @returns {string} */
function decide(answers) {
  const taste = answers[1];
  const budget = answers[0];
  if (taste === "taste_strong") return budget === "budget_high" ? "plan_espresso" : "plan_french";
  if (taste === "taste_light") return "plan_pourover";
  return "plan_drip";
}

// --- チャットUI ---
const thread = $("thread");
const choicesEl = $("choices");

function scroll() {
  thread.scrollTop = thread.scrollHeight;
}
function addBot(/** @type {string} */ text) {
  const d = document.createElement("div");
  d.className = "msg bot";
  d.textContent = text;
  thread.appendChild(d);
  scroll();
}
function addMe(/** @type {string} */ text) {
  const d = document.createElement("div");
  d.className = "msg me";
  d.textContent = text;
  thread.appendChild(d);
  scroll();
}

/**
 * @typedef {{ label: string, onClick: () => void, primary?: boolean, ghost?: boolean }} ChoiceButton
 * @param {ChoiceButton[]} items
 */
function setChoices(items) {
  choicesEl.innerHTML = "";
  for (const it of items) {
    const b = document.createElement("button");
    b.textContent = it.label;
    if (it.primary) b.className = "primary";
    if (it.ghost) b.className = "ghost";
    b.addEventListener("click", it.onClick);
    choicesEl.appendChild(b);
  }
}

// --- 進行管理 ---
/** @type {string[]} */
let answers = [];
let startedAt = 0;

function start() {
  answers = [];
  startedAt = Date.now();
  thread.innerHTML = "";
  addBot("こんにちは！ ☕ いくつか質問して、あなたにぴったりのコーヒーの淹れ方を提案します。");
  analytics.flowStarted();
  bumpSent("flow_started");
  showStep(0);
}

function showStep(/** @type {number} */ i) {
  const step = STEPS[i];
  const stepNo = i + 1;
  addBot(step.prompt);
  analytics.stepViewed({ step: stepNo });
  bumpSent(`step_viewed ${stepNo}`);
  setChoices(
    step.choices.map((c) => ({
      label: c.label,
      onClick: () => {
        addMe(c.label);
        answers[i] = c.id;
        analytics.choiceSelected({ step: stepNo, choiceId: c.id });
        bumpSent(`choice ${c.id}`);
        if (i + 1 < STEPS.length) showStep(i + 1);
        else showResult();
      },
    }))
  );
}

function showResult() {
  const resultId = decide(answers);
  const r = RESULTS[resultId];
  const elapsedMs = Date.now() - startedAt;

  const card = document.createElement("div");
  card.className = "result";
  card.innerHTML = `<h3>おすすめ: ${r.name}</h3><div>${r.desc}</div>`;
  thread.appendChild(card);
  scroll();

  analytics.recommendationShown({ resultId, stepCount: STEPS.length, elapsedMs });
  bumpSent(`recommendation_shown ${resultId}`);

  setChoices([
    {
      label: "これにする 👍",
      primary: true,
      onClick: () => {
        addMe("これにする 👍");
        analytics.recommendationAccepted({ resultId });
        bumpSent("recommendation_accepted");
        addBot("ありがとうございます！ よいコーヒーライフを ☕");
        setChoices([{ label: "もう一度診断する", ghost: true, onClick: restart }]);
      },
    },
    {
      label: "うーん、ちがうかも 👎",
      onClick: () => {
        addMe("うーん、ちがうかも 👎");
        analytics.recommendationRejected({ resultId });
        bumpSent("recommendation_rejected");
        addBot("了解です。条件を変えてもう一度試してみましょう。");
        setChoices([{ label: "もう一度診断する", ghost: true, onClick: restart }]);
      },
    },
  ]);
}

function restart() {
  analytics.flowRestarted();
  bumpSent("flow_restarted");
  start();
}

// --- エラー通知デモ（§13）---
$("errbtn").addEventListener("click", () => {
  try {
    throw new Error("Demo error from wizard app");
  } catch (e) {
    const err = /** @type {Error} */ (e);
    analytics.trackError(err.message, { stack: err.stack, source: "examples/wizard/app.js" });
    fp.textContent = "エラーを frontping に送信しました（/errors）";
  }
});

// 未捕捉エラーも frontping へ
window.addEventListener("error", (ev) => {
  analytics.trackError(ev.message, { stack: ev.error?.stack, source: ev.filename });
});

// --- 起動時イベント（§6）---
analytics.trackPageView();
analytics.widgetOpened();
bumpSent("page_view + widget_opened");
start();
