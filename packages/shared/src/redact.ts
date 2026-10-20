/**
 * Redaction applied to every event's `attrs` before it is stored: by the
 * importer and SDK before sending, and again by the server, so a sender that
 * forgets cannot leak a password into the database.
 */

export const REDACTED = '[redacted]';

// Matched against the key lowercased with `-` and `_` removed, so `api_key`,
// `apiKey` and `X-Api-Key` are all caught.
const SENSITIVE_KEY =
  /(password|passwd|passphrase|secret|token|authorization|cookie|apikey|privatekey|accesskey|creditcard|cardnumber|cvv|cvc|sessionid|^pwd$|^otp$|^pin$|^auth$)/;

const MAX_DEPTH = 6;
const MAX_ARRAY = 100;
const MAX_STRING = 2000;

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY.test(key.toLowerCase().replace(/[-_]/g, ''));
}

/**
 * A copy of `value` with secrets masked, and depth, arrays and strings (to
 * 2000 characters) bounded.
 */
export function redact(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') {
    return redactString(value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value);
  }
  if (value === null || typeof value !== 'object') {
    return typeof value === 'bigint' ? value.toString() : value;
  }
  if (depth >= MAX_DEPTH) return '[nested too deep]';
  if (Array.isArray(value)) {
    const out = value.slice(0, MAX_ARRAY).map((item) => redact(item, depth + 1));
    if (value.length > MAX_ARRAY) out.push(`[${value.length - MAX_ARRAY} more]`);
    return out;
  }
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined || typeof item === 'function') continue;
    out[key] = isSensitiveKey(key) ? REDACTED : redact(item, depth + 1);
  }
  return out;
}

/**
 * Masks secrets that turn up inside free text, without shortening it: bearer tokens, ingest keys,
 * and card numbers (13 to 19 digits starting 3 to 6, passing the Luhn check;
 * the leading digit keeps epoch-millisecond timestamps, which start with 1,
 * from being mistaken for cards).
 */
export function redactString(text: string): string {
  let out = text.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, `$1 ${REDACTED}`);
  out = out.replace(/\balk_[a-z0-9]+_[a-z0-9]+/gi, REDACTED);
  out = out.replace(/\b[3-6](?:[ -]?\d){12,18}\b/g, (match) =>
    luhn(match.replace(/\D/g, '')) ? REDACTED : match,
  );
  return out;
}

function luhn(digits: string): boolean {
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}
