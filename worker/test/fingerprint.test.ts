import { describe, it, expect } from "vitest";
import { normalizeMessage, makeFingerprint } from "../src/lib/fingerprint";

describe("normalizeMessage (§13.2)", () => {
  it("collapses variable numbers and quoted values", () => {
    expect(normalizeMessage("reading 'item_42'")).toBe("reading <str>");
    expect(normalizeMessage("index 12 of 9999")).toBe("index <num> of <num>");
  });
});

describe("makeFingerprint (§13.2)", () => {
  const base = { app_id: "a", event_name: "error_occurred", page_path: "/p", source: "main.js" };

  it("is stable across variable message parts", async () => {
    const fp1 = await makeFingerprint({ ...base, message: "Cannot read 'foo' at 12" });
    const fp2 = await makeFingerprint({ ...base, message: "Cannot read 'bar' at 998" });
    expect(fp1).toBe(fp2);
  });

  it("differs for genuinely different errors", async () => {
    const fp1 = await makeFingerprint({ ...base, message: "Cannot read property" });
    const fp2 = await makeFingerprint({ ...base, message: "Network request failed" });
    expect(fp1).not.toBe(fp2);
  });
});
