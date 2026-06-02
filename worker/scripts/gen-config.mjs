// デプロイ用に wrangler.toml の placeholder を実リソースIDへ差し替えた
// wrangler.generated.toml を生成する。
//
// ID の出どころ（優先: 環境変数 > worker/.env.deploy）:
//   D1_DATABASE_ID, KV_RL_ID
//
// ローカル開発(`wrangler dev --local`)は placeholder のままで動くため、本スクリプトは
// 本番への deploy / remote 操作のときだけ使う。
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
const out = join(root, "wrangler.generated.toml");
writeFileSync(out, toml);
console.log(`[gen-config] wrote wrangler.generated.toml`);
