// §13.2 サーバ側 fingerprint 生成 + message 正規化

const QUOTED = /'[^']*'|"[^"]*"/g;
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const HEX = /\b[0-9a-f]{8,}\b/gi;
const NUM = /\d+/g;
const WS = /\s+/g;

// 可変部分を潰し、同一原因のエラーが同じ fingerprint になるようにする
export function normalizeMessage(message: string): string {
  return message
    .replace(QUOTED, "<str>")
    .replace(UUID, "<id>")
    .replace(HEX, "<id>")
    .replace(NUM, "<num>")
    .replace(WS, " ")
    .trim();
}

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// app_id + event_name + page_path + normalized_message + source（§13.2）
export async function makeFingerprint(parts: {
  app_id: string;
  event_name: string;
  page_path: string;
  message: string;
  source?: string | null;
}): Promise<string> {
  const key = [
    parts.app_id,
    parts.event_name,
    parts.page_path,
    normalizeMessage(parts.message),
    parts.source ?? "",
  ].join("\n");
  return sha256Hex(key);
}
