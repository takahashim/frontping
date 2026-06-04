// デプロイ用に wrangler.toml の placeholder を実値へ差し替えた
// wrangler.generated.toml を生成する。
//
// 注入するもの（いずれも git 管理外。本番固有の値をソースに焼かないため）:
//   - リソースID: D1_DATABASE_ID, KV_RL_ID（環境変数 > worker/.env.deploy）
//   - APP_CONFIG: worker/app-config.json があれば [vars] の APP_CONFIG を丸ごと差し替え
//     （allowed_origins 等のサイト固有設定をここに置く）
//
// ローカル開発(`wrangler dev --local`)は wrangler.toml をそのまま使う（汎用の APP_CONFIG）。
// 本スクリプトは 本番への deploy / remote 操作のときだけ使う。
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

const env = { ...process.env };
const envFile = join(root, ".env.deploy");
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, "utf8").split("\n")) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !line.trim().startsWith("#")) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

const REPLACEMENTS = {
  REPLACE_WITH_D1_ID: env.D1_DATABASE_ID,
  REPLACE_WITH_KV_ID: env.KV_RL_ID,
};

const missing = Object.entries(REPLACEMENTS)
  .filter(([, v]) => !v)
  .map(([k]) => k);
if (missing.length) {
  console.error(
    `[gen-config] 実IDが未設定です: ${missing.join(", ")}\n` +
      `  worker/.env.deploy に D1_DATABASE_ID / KV_RL_ID を設定するか、環境変数で渡してください。`
  );
  process.exit(1);
}

let toml = readFileSync(join(root, "wrangler.toml"), "utf8");
for (const [placeholder, value] of Object.entries(REPLACEMENTS)) {
  toml = toml.replaceAll(placeholder, value);
}

// サイト固有の APP_CONFIG を注入（worker/app-config.json があれば [vars] を差し替え）
const appConfigFile = join(root, "app-config.json");
if (existsSync(appConfigFile)) {
  const raw = readFileSync(appConfigFile, "utf8").trim();
  JSON.parse(raw); // 妥当性チェック（不正なら throw）
  const block = `APP_CONFIG = '''\n${raw}\n'''`;
  // 置換文字列の $ を特別扱いさせないため関数置換を使う
  toml = toml.replace(/APP_CONFIG\s*=\s*'''[\s\S]*?'''/, () => block);
  console.log("[gen-config] APP_CONFIG を app-config.json で上書きしました");
}

const out = join(root, "wrangler.generated.toml");
writeFileSync(out, toml);
console.log(`[gen-config] wrote wrangler.generated.toml`);
