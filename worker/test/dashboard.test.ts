import { SELF } from "cloudflare:test";
import { describe, it, expect } from "vitest";

describe("GET /dashboard (§18.1)", () => {
  it("serves read-only HTML that calls /metrics", async () => {
    const res = await SELF.fetch("https://worker.test/dashboard");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/html");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const html = await res.text();
    expect(html).toContain("frontping dashboard");
    expect(html).toContain("/metrics?");
    expect(html).toContain("Authorization");
  });
});
