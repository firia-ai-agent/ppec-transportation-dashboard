/**
 * IdentityGateway primitives for phone numbers and message bodies (ARCHITECTURE §2, DATA-MODEL §1).
 * These are the only place ops code is allowed to touch a phone number: everything downstream carries the
 * blind index (`phone_hmac`) or a token. The pepper is passed in by the caller (env name only in docs).
 */
import { createHmac } from "node:crypto";

/** HMAC-SHA256(E.164, pepper), hex. Blind index for inbound resolution (identity.guardian_contact.phone_hmac). */
export function phoneHmac(e164: string, pepper: string): string {
  if (!pepper || pepper.length < 16) throw new Error("phone pepper is missing or too short (expected >= 16 chars)");
  return createHmac("sha256", pepper).update(e164).digest("hex");
}

/** US/E.164 only (P1 is one Florida site). Returns null for anything we cannot normalize, so callers fail closed. */
export function normalizeE164(raw: string): string | null {
  const digits = raw.replace(/\D/g, "");
  const ten = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits.length === 10 ? digits : null;
  return ten && /^[2-9]\d{9}$/.test(ten) ? `+1${ten}` : null;
}

const PHONE_IN_TEXT = /(\+?\d[\d\s().-]{8,}\d)/g;
const EMAIL_IN_TEXT = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/**
 * `ops.message.body_tokenized`: the text with contact details replaced by markers. The agent and every ops
 * reader see this version, never the raw body, so a number texted by a family cannot become authority
 * (RES-02) or leak into a prompt (TEST-SEC-01). Plaintext retention is `body_enc` and is not written in P1.
 */
export function tokenizeBody(raw: string): string {
  return raw.replace(EMAIL_IN_TEXT, "[email]").replace(PHONE_IN_TEXT, (m) => (m.replace(/\D/g, "").length >= 10 ? "[phone]" : m));
}
