/**
 * The keyword fallback — PRD §18.1 l.1200 degraded modes: "LLM down → keyword parser
 * (ABSENT/SICK/YES/READY/STOP) + inbox triage banner".
 *
 * This is what answers a family when the vendor cannot: the primary model 429s, the backup 429s
 * too, the request times out, OpenRouter returns a 500. The run must still end somewhere a human
 * can see, because an inbound "staying home sick" that silently produced nothing is worse than a
 * rate limit — it looks like the agent handled it.
 *
 * What it deliberately does **not** do is guess. It emits exactly one tool call,
 * `escalate_exception`, which §11.2 marks "always allowed" and which mutates no transport state
 * and sends nothing to a family. The keyword decides the *severity and category* of the triage
 * item, not an action: cancelling a leg needs a child, a date, a day part and a version this
 * parser has no business inferring from five characters of SMS, and confirming an acknowledgment
 * on a keyword match is how a mis-parse becomes a child nobody collects. So the degraded path
 * degrades to a human, which is exactly the "inbox triage banner" the PRD asks for.
 *
 * It is a `LlmProvider` like any other, so the gateway's whole contract still applies to its
 * output — schema validation, the audit row, the policy engine afterwards. A fallback that
 * bypassed the gateway would be a second, unaudited way for the agent to act.
 *
 * It reads the prompt, which is the one piece of family text in the seam, and puts **none of it**
 * in its output: the `summary` it produces names the matched keyword code and nothing else, so
 * the audit log and the staff note stay as free of family prose as they are on the live path.
 */
import type { AgentConfig } from "../config";
import { UNTRUSTED_OPEN, UNTRUSTED_CLOSE } from "../policy";
import type { LlmProvider, ProviderCall, ProviderResponseBody } from "./provider";

/** The five keywords, and what each one is as a triage item. */
export const KEYWORD_RULES = [
  {
    code: "STOP",
    /** `STOP` is a consent opt-out that messaging/consent.ts owns; the agent must not "handle" it. */
    pattern: /\bstop\b/i,
    severity: "RED",
    category: "POLICY_BLOCK",
    nextStep: "STAFF_REVIEW",
  },
  {
    code: "ABSENT",
    pattern: /\b(?:absent|absence|not coming|wont be|won't be|no van|skip)\b/i,
    severity: "AMBER",
    category: "ACK_OVERDUE",
    nextStep: "STAFF_CALL",
  },
  {
    code: "SICK",
    pattern: /\b(?:sick|ill|unwell|fever|staying home)\b/i,
    severity: "AMBER",
    category: "ACK_OVERDUE",
    nextStep: "STAFF_CALL",
  },
  {
    code: "READY",
    pattern: /\b(?:ready|here|waiting|outside)\b/i,
    severity: "INFO",
    category: "ACK_OVERDUE",
    nextStep: "STAFF_REVIEW",
    /** "not ready" is not a READY. See NEGATORS. */
    negatable: true,
  },
  {
    code: "YES",
    pattern: /\b(?:yes|yep|yeah|confirmed|ok|okay|y)\b/i,
    severity: "INFO",
    category: "ACK_OVERDUE",
    nextStep: "STAFF_REVIEW",
    negatable: true,
  },
] as const;

/**
 * Words that flip the two *informational* rules. "not ready", "he isn't here", "no longer waiting"
 * all match READY on the bare keyword, and reading them as INFO would under-triage a child who is
 * not where the van expects them.
 *
 * Only READY and YES are `negatable`. STOP, ABSENT and SICK are not, deliberately: "don't stop
 * texting me" is still a message about an opt-out and still belongs in front of a human, and the
 * failure direction there is the safe one. A negated informational match falls through to the
 * no-match item, which is AMBER and asks for a staff read — more attention, never less.
 */
const NEGATORS = /\b(?:not|isn'?t|aren'?t|wasn'?t|won'?t|wont|cant|can'?t|dont|don'?t|no longer|never|nope|no)\b/i;

/** Is this rule's match preceded closely by a negation? Looks back one short clause, not the page. */
function negated(text: string, pattern: RegExp): boolean {
  const hit = pattern.exec(text);
  if (!hit) return false;
  const lookback = text.slice(Math.max(0, hit.index - 24), hit.index);
  // A clause boundary ends the negation's reach: "not today. ready now" is a READY.
  const clause = lookback.split(/[.!?;,]/).pop() ?? lookback;
  return NEGATORS.test(clause);
}

export type KeywordCode = (typeof KEYWORD_RULES)[number]["code"];

/**
 * What a run fell back to, for the caller's logs. `keyword` is null when nothing matched, which
 * is still an escalation — just one that tells staff the text needs reading.
 */
export type KeywordMatch = {
  readonly keyword: KeywordCode | null;
  readonly severity: string;
  readonly category: string;
  readonly nextStep: string;
};

/** No keyword matched: staff get the item anyway, marked as needing a human read. */
const NO_MATCH: KeywordMatch = {
  keyword: null,
  severity: "AMBER",
  category: "UNKNOWN_SENDER",
  nextStep: "STAFF_REVIEW",
};

/**
 * The family text in a §11.1 prompt is exactly the T3 untrusted blocks. Matching only inside them
 * keeps the parser off the scaffolding: `state=SCHEDULED`, a `role=` line or a tool name must not
 * be able to trip a keyword, and a prompt with no T3 block has no family text to parse.
 */
export function untrustedBodies(prompt: string): string[] {
  const bodies: string[] = [];
  let from = 0;
  for (;;) {
    const open = prompt.indexOf(UNTRUSTED_OPEN, from);
    if (open === -1) break;
    const start = open + UNTRUSTED_OPEN.length;
    const close = prompt.indexOf(UNTRUSTED_CLOSE, start);
    if (close === -1) break;
    bodies.push(prompt.slice(start, close));
    from = close + UNTRUSTED_CLOSE.length;
  }
  return bodies;
}

/**
 * Classify a prompt. Rule order is the order of KEYWORD_RULES and it is the priority order:
 * `STOP` first because an opt-out outranks whatever else the message says, then the two that mean
 * a child is not travelling, then the two that are informational. A text reading "he's sick, stop
 * texting me" is a STOP, not a SICK.
 */
export function classifyKeywords(prompt: string): KeywordMatch {
  const text = untrustedBodies(prompt).join("\n");
  if (text.trim() === "") return NO_MATCH;
  const hit = KEYWORD_RULES.find(
    (rule) => rule.pattern.test(text) && !("negatable" in rule && rule.negatable && negated(text, rule.pattern)),
  );
  return hit
    ? { keyword: hit.code, severity: hit.severity, category: hit.category, nextStep: hit.nextStep }
    : NO_MATCH;
}

/**
 * The one tool call the fallback makes. `summary` is a fixed sentence plus the keyword code — no
 * slice of the family's message, no token from the prompt beyond what the gateway already audits.
 */
export function keywordResponse(prompt: string): ProviderResponseBody {
  const match = classifyKeywords(prompt);
  return {
    tool_calls: [
      {
        name: "escalate_exception",
        arguments: {
          severity: match.severity,
          category: match.category,
          leg_id: null,
          summary: `degraded mode: no model available; inbound classified by keyword parser as ${
            match.keyword ?? "NO_MATCH"
          } and needs staff triage`,
          next_step_code: match.nextStep,
        },
      },
    ],
    finish_reason: "keyword_fallback",
  };
}

export type KeywordProvider = LlmProvider & {
  readonly kind: "keyword";
  /** One entry per call, newest last: the classification only, never the text it classified. */
  readonly matches: readonly KeywordMatch[];
};

/**
 * The fallback as a standalone provider, for the degraded-mode suites and for a deployment that
 * wants the keyword path with no vendor configured at all. `remoteProvider` uses the functions
 * above directly rather than this object, so its fallback needs no second provider instance.
 *
 * The config is a required argument and there is no default behind it: `vendor` and `endpoint` are
 * on `LlmProvider` because the gateway checks both — `vendor` against `config.provider` so an
 * attestation cannot lie, `endpoint` against `config.endpointAllowList` — and a literal here would
 * be a second source of truth for exactly the two values those checks compare against. One vendor
 * rename later and this provider would be the file that still names the old one.
 */
export function keywordProvider(
  config: Pick<AgentConfig, "provider" | "endpointAllowList">,
): KeywordProvider {
  const matches: KeywordMatch[] = [];
  return {
    kind: "keyword",
    vendor: config.provider,
    endpoint: config.endpointAllowList[0],
    matches,
    async invoke(call: ProviderCall): Promise<ProviderResponseBody> {
      matches.push(classifyKeywords(call.prompt));
      return keywordResponse(call.prompt);
    },
  };
}
