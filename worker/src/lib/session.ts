// 署名付きセッション Cookie（HMAC-SHA256）。値は `<payload>.<sig>`。
// payload = base64url(JSON)、sig = base64url(HMAC(payload, SESSION_SECRET))。

export interface Session {
  login: string; // GitHub username
  exp: number; // 失効時刻（ms epoch）
}

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlToBytes(str: string): Uint8Array {
  const bin = atob(str.replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function hmac(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return b64url(new Uint8Array(sig));
}

export async function signSession(s: Session, secret: string): Promise<string> {
  const payload = b64url(new TextEncoder().encode(JSON.stringify(s)));
  const sig = await hmac(secret, payload);
  return `${payload}.${sig}`;
}

export async function verifySession(token: string, secret: string): Promise<Session | null> {
  const dot = token.lastIndexOf(".");
  if (dot < 0) return null;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = await hmac(secret, payload);
  if (!timingSafeEqual(sig, expected)) return null;
  try {
    const s = JSON.parse(new TextDecoder().decode(b64urlToBytes(payload))) as Session;
    if (typeof s.login !== "string" || typeof s.exp !== "number" || s.exp < Date.now()) return null;
    return s;
  } catch {
    return null;
  }
}
