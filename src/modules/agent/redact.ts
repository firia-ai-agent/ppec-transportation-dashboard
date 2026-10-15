/**
 * The gateway's two content guards (PRD §11.2 l.993): `redact()` and
 * `validatePromptTokensOnly()`, plus the hashes that are the only thing either one is allowed
 * to log. TEST-SEC-01 (PRD §18.3 l.1334) is the acceptance test: "token-only prompts".
 *
 * `validatePromptTokensOnly` fails closed — it throws, and the prompt never reaches a provider —
 * on three classes the PRD names: E.164 numbers, street-address patterns and untokenized names.
 * Fails *closed* means a pattern that might be a phone number is treated as one; a false
 * rejection costs one degraded-mode keyword reply (PRD l.1200), a false pass is a PHI egress.
 *
 * The name list is the synthetic fixture roster (src/modules/demo/fixtures/standard.ts). There is
 * no other list of people in this system: in P1 every person is a fixture, so a prompt carrying
 * any human name carries a name the tokenizer should have replaced. When real data arrives the
 * list is swapped for the identity vault's name index behind this same function.
 */
import { createHash } from "node:crypto";
import { CHILDREN, EXTERNAL_PEOPLE, FAMILIES } from "@/modules/demo/fixtures/standard";

export type LeakKind = "PHONE" | "ADDRESS" | "NAME";

/** sha256 hex. The only representation of prompt or response text that may be logged or stored. */
export function sha256Hex(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * E.164 and the formats a human writes one in. The bare-digit forms are deliberately narrow
 * (11 digits starting with the NANP country code) so a uuid or an epoch-millisecond stamp in a
 * prompt is not read as a phone number, while `+<digits>` — actual E.164 — always is.
 */
const PHONE_PATTERNS: readonly RegExp[] = [
  /\+\d[\d\s().-]{7,20}\d/g,
  // No leading \b: the character before "(" is usually a space, and space→"(" is not a word
  // boundary, so a \b here would silently never match "(561) 555-0101".
  /(?<!\d)\(\d{3}\)\s*\d{3}[.\-\s]?\d{4}(?!\d)/g,
  /\b\d{3}[.\-\s]\d{3}[.\-\s]\d{4}\b/g,
  /\b1\d{10}\b/g,
  // Seven-digit local form ("555-0101"). Guarded on both sides so an ISO date or a longer digit
  // run cannot match, and placed last so the fuller forms claim their text first.
  /(?<![\d-])\d{3}[-.]\d{4}(?![\d-])/g,
];

/**
 * Street addresses. The center is "2216 Jog Rd, Greenacres FL 33415" (ADR-000 #5) and every
 * fixture stop is a public landmark, so the shapes that matter are "<number> <words> <suffix>",
 * a unit designator, a PO box, and a "<STATE> <ZIP>" tail.
 */
const ADDRESS_PATTERNS: readonly RegExp[] = [
  /\b\d{1,6}\s+(?:[A-Za-z0-9.'-]+\s+){0,3}(?:St|Street|Rd|Road|Ave|Avenue|Blvd|Boulevard|Dr|Drive|Ln|Lane|Ct|Court|Cir|Circle|Way|Pl|Place|Ter|Terrace|Pkwy|Parkway|Hwy|Highway|Trl|Trail|Sq|Square)\b\.?/gi,
  /\b(?:Apt|Apartment|Unit|Suite|Ste)\.?\s*#?\s*[A-Za-z0-9-]+\b/gi,
  /\bP\.?\s?O\.?\s+Box\s+\d+\b/gi,
  /\b[A-Z]{2}\s+\d{5}(?:-\d{4})?\b/g,
];

/**
 * Every human first name in the synthetic roster, longest first so "Marisol" is matched before a
 * hypothetical "Mari". Guardians, children and external people (therapists, dispatchers) all
 * count: a therapist's name in a prompt is as much of a leak as a child's.
 */
export const FIXTURE_NAMES: readonly string[] = Array.from(
  new Set([
    ...FAMILIES.map((f) => f.guardian.firstName),
    ...CHILDREN.map((c) => c.firstName),
    ...EXTERNAL_PEOPLE.map((p) => p.firstName),
  ]),
).sort((a, b) => b.length - a.length);

const NAME_PATTERN = new RegExp(
  // "Mia", "Mia R." and "Mia R" all name the same child; the trailing initial is part of the leak.
  `\\b(?:${FIXTURE_NAMES.map(escapeRegExp).join("|")})\\b(?:\\s+[A-Za-z]\\.?(?=\\s|$|[^A-Za-z]))?`,
  // Case-insensitive, because fail-closed: a family writes "mia" and an injected prompt writes
  // "MIA", and both are the same leak. The roster is all given names with no English homographs,
  // so the \b…\b anchors keep this from firing on ordinary words.
  "gi",
);

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * A uuid is a token, not a number, and this system passes them around by the dozen: every id in
 * `ops.*` is one, so every tool argument, every prompt line and every staff note is full of them.
 *
 * They have to be excluded from the scan explicitly, because a hex id can *look* like a local
 * phone number by accident: in `…-b741-7402edfbcabb` the seven-digit pattern finds "741-7402"
 * with a letter on each side, and about one uuid in 170 contains such a run. Fail-closed is right
 * for an unrecognized digit run and wrong here — it would refuse a legitimate prompt, or block a
 * tool call naming a real leg, at random, which is the one failure mode a security guard must not
 * have. `scripts/seed-lint.mjs` masks uuids before its own phone scan for exactly this reason.
 *
 * The masking is positional, not a filter: `redact()` keeps every uuid it finds *verbatim* and
 * redacts only the text between them, so nothing about a staff note's ids changes.
 */
const UUID_IN_TEXT = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

/** The text either side of every uuid, in order. The uuids themselves are not returned. */
function outsideUuids(text: string): string[] {
  const chunks: string[] = [];
  let last = 0;
  for (const m of text.matchAll(UUID_IN_TEXT)) {
    chunks.push(text.slice(last, m.index));
    last = m.index + m[0].length;
  }
  chunks.push(text.slice(last));
  return chunks;
}

/** `f` applied to the text between the uuids; each uuid is passed through unchanged. */
function mapOutsideUuids(text: string, f: (chunk: string) => string): string {
  const parts: string[] = [];
  let last = 0;
  for (const m of text.matchAll(UUID_IN_TEXT)) {
    parts.push(f(text.slice(last, m.index)), m[0]);
    last = m.index + m[0].length;
  }
  parts.push(f(text.slice(last)));
  return parts.join("");
}

const PLACEHOLDER: Readonly<Record<LeakKind, string>> = {
  PHONE: "[REDACTED:PHONE]",
  ADDRESS: "[REDACTED:ADDRESS]",
  NAME: "[REDACTED:NAME]",
};

const DETECTORS: readonly { kind: LeakKind; patterns: readonly RegExp[] }[] = [
  // Phones first: an address pattern would otherwise eat the digits of "+1-561-555-0101".
  { kind: "PHONE", patterns: PHONE_PATTERNS },
  { kind: "ADDRESS", patterns: ADDRESS_PATTERNS },
  { kind: "NAME", patterns: [NAME_PATTERN] },
];

/** One class of leak found in a piece of text. Carries a count, never the matched text. */
export type Finding = { kind: LeakKind; count: number };

/** What `text` leaks, by class, with no sample of the offending value. Uuids are tokens, not leaks. */
export function findLeaks(text: string): Finding[] {
  const counts = new Map<LeakKind, number>();
  for (const chunk of outsideUuids(text)) {
    let scanned = chunk;
    for (const { kind, patterns } of DETECTORS) {
      let count = 0;
      for (const re of patterns) {
        // Replace as we go so a later class cannot re-count text an earlier one already claimed.
        scanned = scanned.replace(new RegExp(re.source, re.flags), () => {
          count += 1;
          return PLACEHOLDER[kind];
        });
      }
      if (count > 0) counts.set(kind, (counts.get(kind) ?? 0) + count);
    }
  }
  // In detector order, so the classes read the same way whatever order they were found in.
  return DETECTORS.filter((d) => counts.has(d.kind)).map((d) => ({ kind: d.kind, count: counts.get(d.kind)! }));
}

/**
 * `redact()` from the gateway contract: the text with every detected phone, address and name
 * replaced by a class placeholder. Used for anything that must be *kept* (a staff note, an
 * exception summary) — never to make a prompt safe. A prompt is made safe by tokenization
 * upstream; redaction here would silently hide the fact that the tokenizer was skipped, which is
 * why `complete()` validates instead of redacting.
 */
export function redact(text: string): string {
  return mapOutsideUuids(text, (chunk) => {
    let out = chunk;
    for (const { kind, patterns } of DETECTORS) {
      for (const re of patterns) {
        out = out.replace(new RegExp(re.source, re.flags), PLACEHOLDER[kind]);
      }
    }
    return out;
  });
}

/**
 * Thrown by `validatePromptTokensOnly`. The message names the classes and counts and the prompt
 * hash — never the prompt, never the matched value. This error is what gets logged (TEST-SEC-01:
 * "logs hash only"), so anything in it is, by definition, allowed to be in a log.
 */
export class PromptLeakError extends Error {
  constructor(
    readonly promptHash: string,
    readonly findings: readonly Finding[],
  ) {
    super(
      `prompt refused: untokenized ${findings.map((f) => `${f.kind}×${f.count}`).join(", ")} ` +
        `(prompt sha256 ${promptHash})`,
    );
    this.name = "PromptLeakError";
  }
}

/**
 * The gateway contract's `validatePromptTokensOnly()`. Returns the prompt hash when the prompt
 * carries tokens only; throws `PromptLeakError` otherwise. No provider call, no retry, no
 * redact-and-send — a leaking prompt is a bug upstream and the run degrades instead.
 */
export function validatePromptTokensOnly(prompt: string): string {
  const hash = sha256Hex(prompt);
  const findings = findLeaks(prompt);
  if (findings.length > 0) throw new PromptLeakError(hash, findings);
  return hash;
}
