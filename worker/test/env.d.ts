/// <reference types="@cloudflare/vitest-pool-workers/types" />
import type { Env as AppEnv } from "../src/types";
import type { D1Migration } from "cloudflare:test";

// 0.16 では cloudflare:test の `env` は `Cloudflare.Env` 型。アプリの Env と
// テスト用 binding をここに反映する。
declare global {
  namespace Cloudflare {
    interface Env extends AppEnv {
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}
