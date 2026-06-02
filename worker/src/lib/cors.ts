import type { AppConfig } from "../types";

// §15 Origin 検証 + CORS ヘッダ

export interface OriginCheck {
  ok: boolean;
  origin: string | null;
}

export function checkOrigin(cfg: AppConfig, requestOrigin: string | null): OriginCheck {
  if (!requestOrigin) {
    // §15.3 Origin 欠如時。既定は拒否、require_origin=false で緩和
    return { ok: cfg.require_origin === false, origin: null };
  }
  return { ok: cfg.allowed_origins.includes(requestOrigin), origin: requestOrigin };
}

// §15.1 許可 Origin を echo（* は使わない）
export function corsHeaders(origin: string | null): Record<string, string> {
  const h: Record<string, string> = { Vary: "Origin" };
  if (origin) h["Access-Control-Allow-Origin"] = origin;
  return h;
}

export function preflightHeaders(origin: string | null): Record<string, string> {
  return {
    ...corsHeaders(origin),
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Access-Control-Allow-Headers": "content-type, authorization",
    "Access-Control-Max-Age": "86400",
  };
}
