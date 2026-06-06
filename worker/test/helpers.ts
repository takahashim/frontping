import { signSession } from "../src/lib/session";
import { TEST_SESSION_SECRET } from "./constants";

// テスト用に運用者ログイン相当のセッション Cookie ヘッダを作る（metrics/admin 認可用）。
export async function sessionAuth(login = "takahashim"): Promise<Record<string, string>> {
  const cookie = await signSession({ login, exp: Date.now() + 60_000 }, TEST_SESSION_SECRET);
  return { Cookie: `fp_session=${cookie}` };
}
