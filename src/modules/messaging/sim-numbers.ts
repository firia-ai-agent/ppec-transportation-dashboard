/**
 * Fiction phone numbers for the messaging simulation (MOCKS-AND-DEMO §3, COPY-GUIDE §3).
 * 555-01xx only; scripts/seed-lint.mjs rejects anything else anywhere in src/.
 */
import { normalizeE164, phoneHmac } from "@/modules/identity/phone";

/** The center's Transport & Attendance number in the sim (COPY-GUIDE §5 dispatcher link). */
export const SIM_CENTER_NUMBER = "+15615550100";

/** F1…F8 persona phones. F4 is one number for two children (MOCKS §3). */
export const SIM_PERSONA_NUMBERS = [
  "+15615550101", "+15615550102", "+15615550103", "+15615550104",
  "+15615550105", "+15615550106", "+15615550107", "+15615550108",
] as const;

export type SimPersonaNumber = (typeof SIM_PERSONA_NUMBERS)[number];

export function isSimPersonaNumber(e164: string): e164 is SimPersonaNumber {
  return (SIM_PERSONA_NUMBERS as readonly string[]).includes(e164);
}

/** "F1" … "F8" for display (the family label the UI shows next to the number). */
export function simPersonaLabel(e164: string): string | null {
  const i = (SIM_PERSONA_NUMBERS as readonly string[]).indexOf(e164);
  return i < 0 ? null : `F${i + 1}`;
}

/** Parse a number from a URL segment or a webhook field into a known sim number. */
export function parseSimNumber(raw: string): string | null {
  const e164 = normalizeE164(decodeURIComponent(raw));
  return e164 && (isSimPersonaNumber(e164) || e164 === SIM_CENTER_NUMBER) ? e164 : null;
}

/**
 * Reverse lookup blind index → persona number. The outbound side only ever holds a `contact_token`, so this
 * is how a send finds the persona phone (and its fault switches) without reading a plaintext number.
 */
export function simNumberByHmac(pepper: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const n of [SIM_CENTER_NUMBER, ...SIM_PERSONA_NUMBERS]) m.set(phoneHmac(n, pepper), n);
  return m;
}
