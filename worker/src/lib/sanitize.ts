// §14.1 message / stack の PII マスク（保存時にも実施）

const EMAIL = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
const BEARER = /\b(?:bearer\s+)?[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+\b/g; // JWT風
const LONG_DIGITS = /\b\d{7,}\b/g; // 電話・カード等

export function maskPII(input: string | null | undefined): string {
  if (!input) return "";
  return input
    .replace(EMAIL, "<email>")
    .replace(BEARER, "<token>")
    .replace(LONG_DIGITS, "<num>");
}
