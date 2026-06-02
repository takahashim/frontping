/// <reference types="@cloudflare/vitest-pool-workers" />
import type { Env } from "../src/types";

declare module "cloudflare:test" {
  // miniflare bindings をテスト env に反映
  interface ProvidedEnv extends Env {
    TEST_MIGRATIONS: D1Migration[];
  }
}
