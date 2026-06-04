// metrics/admin 用の per-app トークンを発行する。
// 使い方: node scripts/issue-token.mjs <app_id> [label]
//
// 生成したトークン（平文）は STDERR に1度だけ表示（保存はこのときだけ）。
// STDOUT には DB へ入れる INSERT 文を出すので、wrangler d1 execute に渡す:
//   node scripts/issue-token.mjs product_recommender | \
//     pnpm exec wrangler d1 execute frontping --remote --config wrangler.generated.toml --command "$(cat)"
// ローカルなら --local を使う。
import { randomBytes, createHash } from "node:crypto";

const appId = process.argv[2];
const label = process.argv[3] ?? "";
if (!appId || !/^[a-z0-9_]{1,64}$/.test(appId)) {
  console.error("usage: node scripts/issue-token.mjs <app_id:[a-z0-9_]> [label]");
  process.exit(1);
}

// 人が見て app が分かるよう自己記述プレフィックスを付ける（認証は全文ハッシュで照合）
const token = `${appId}.${randomBytes(24).toString("hex")}`;
const hash = createHash("sha256").update(token).digest("hex");
const labelSql = label ? `'${label.replace(/'/g, "''")}'` : "NULL";

console.error("──────────────────────────────────────────────");
console.error(`app_id: ${appId}`);
console.error(`token : ${token}`);
console.error("↑ このトークンは今だけ表示されます。安全に控えてください。");
console.error("──────────────────────────────────────────────");

process.stdout.write(
  `INSERT INTO metrics_tokens (token_hash, app_id, label) VALUES ('${hash}', '${appId}', ${labelSql});\n`
);
