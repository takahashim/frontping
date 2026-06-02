import { SELF, env } from "cloudflare:test";
import { describe, it, expect } from "vitest";

const ORIGIN = "https://app.example.com";

function postError(properties: Record<string, unknown>): Promise<Response> {
  return SELF.fetch("https://worker.test/errors", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: ORIGIN },
    body: JSON.stringify({
      app_id: "test_app",
      event_name: "error_occurred",
      session_id: "sess_err",
      occurred_at: new Date().toISOString(),
      page_path: "/recommend",
      properties,
    }),
  });
}

describe("POST /errors (§9.3)", () => {
  it("stores into both raw_events and error_events with a server fingerprint", async () => {
    const res = await postError({ message: "TypeError: boom", stack: "at x" });
    expect(res.status).toBe(202);

    const err = await env.DB.prepare(
      "SELECT message, fingerprint FROM error_events WHERE session_id = ?"
    )
      .bind("sess_err")
      .first<{ message: string; fingerprint: string }>();
    expect(err?.message).toBe("TypeError: boom");
    expect(err?.fingerprint).toBeTruthy();

    const raw = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM raw_events WHERE session_id = ? AND event_name = 'error_occurred'"
    )
      .bind("sess_err")
      .first<{ n: number }>();
    expect(raw?.n).toBe(1);
  });

  it("masks PII in message before storing (§14.1)", async () => {
    await postError({ message: "failed for user@example.com" });
    const row = await env.DB.prepare(
      "SELECT message FROM error_events WHERE session_id = ? ORDER BY id DESC LIMIT 1"
    )
      .bind("sess_err")
      .first<{ message: string }>();
    expect(row?.message).toContain("<email>");
    expect(row?.message).not.toContain("@example.com");
  });

  it("400 when message is missing", async () => {
    const res = await postError({ stack: "no message" });
    // /errors は単一イベント。必須属性 message を欠くと全体破棄 → accepted 0
    const json = (await res.json()) as { ok: boolean };
    expect(res.status).toBe(202);
    expect(json.ok).toBe(true);
    const row = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM error_events WHERE message = ''"
    ).first<{ n: number }>();
    expect(row?.n).toBe(0);
  });
});
