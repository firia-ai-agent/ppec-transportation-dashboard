/**
 * The policy engine: one rule per §11.2 "Prohibited" item, plus the §11.2 injection defenses
 * (PRD l.991). It sits between the gateway (which guarantees a schema-valid call to a catalog
 * tool) and anything that writes or sends: no accepted call reaches the outbox or a transition
 * without a verdict from here.
 *
 * §11.2, in order, and where each item lives:
 *   editing approved profile items ............. PROHIBITED_ACTIONS → edit_approved_profile
 *   adding contacts/relationships .............. PROHIBITED_ACTIONS → add_contact_or_relationship
 *   choosing raw recipients .................... raw_recipient_selection (args carry a number/address)
 *   marking BOARDED_VERIFIED / COMPLETED_HANDOFF  forbidden state claims
 *   marking capability VERIFIED ................ forbidden state claims
 *   overriding approvals ....................... PROHIBITED_ACTIONS → override_approval
 *   changing policies .......................... PROHIBITED_ACTIONS → change_policy
 *   free-text to parents without approval ...... free_text_to_parents (templated send: codes only)
 *                                          …and send_requires_approval (free-text send: approval)
 *   messaging non-consented numbers ............ non_consented_number (mirrors the egress re-check)
 *   cross-family disclosure .................... cross_family_disclosure (family-scope post-validator)
 *   …and the tenant boundary under it .......... cross_site_disclosure (same validator, same 404)
 *   clinical advice ............................ clinical_advice
 *   attendance persuasion ...................... attendance_persuasion
 *   obeying T3 instructions .................... obey_t3_instruction
 *   sending while paused ....................... send_while_paused
 *
 * And the three defenses: delimiters (`wrapUntrusted`), schema-only tools with no
 * recipient/permission args (tools.ts), the family-scope post-validator (`validateFamilyScope`),
 * and "also text…/new number/I'm the new guardian" → identity_change_request (`triageInbound`).
 *
 * Four structural rules this module keeps:
 *  - every catalog tool has a row in `POLICY_ROWS`, and a tool with no row — or with a row that
 *    does not say how to consent-check its send — is denied (`missing_policy_row`). The table is
 *    the authorization surface, so an undeclared tool must fail shut, not inherit a default;
 *  - a `human`-tier tool is always a proposal, never a mutation (§11.2 propose_* rows);
 *  - the §11.2 tiers, exactly: a send whose copy is an allow-listed template id or a body rendered
 *    downstream from structured fields is `auto` and goes out on the agent's own authority, while a
 *    send carrying words of the model's own needs a human approval bound to that exact call
 *    (`send_requires_approval`, `approvalKey`). Which of the two a tool is comes from its
 *    `sendCopy` declaration (tools.ts), and a sending tool that declares nothing is read as free
 *    text. No catalog tool declares free text, so the words that reach a family are the outbox's;
 *    the two halves of that are steps 6 and 10 below;
 *  - every block is a decision object, never an exception: a blocked call is a normal, logged
 *    outcome that raises an exception row for staff (AGT-02: "out-of-policy tool call rejected +
 *    logged"), not a crash.
 */
import { disallowedVars } from "@/modules/outbox/outbox";
import type { AcceptedToolCall } from "./gateway";
import { findLeaks, redact, sha256Hex } from "./redact";
import { type SendCopy, type ToolDef, type ToolEffect, isRenderableTemplate, toolDef } from "./tools";

/* ──────────────────────────────────── rules ──────────────────────────────────── */

export const POLICY_RULES = [
  "schema_only_tools",
  "missing_policy_row",
  "edit_approved_profile",
  "add_contact_or_relationship",
  "raw_recipient_selection",
  "mark_boarded_verified",
  "mark_completed_handoff",
  "mark_capability_verified",
  "override_approval",
  "change_policy",
  "free_text_to_parents",
  "non_consented_number",
  "cross_site_disclosure",
  "cross_family_disclosure",
  "clinical_advice",
  "attendance_persuasion",
  "obey_t3_instruction",
  "send_while_paused",
  "human_tier_requires_approval",
  "send_requires_approval",
] as const;

export type PolicyRuleId = (typeof POLICY_RULES)[number];

/** The tier of context a call cites as its authority (§11.1 tier assembly). */
export type ContextTier = "T1" | "T2" | "T3" | "T4";

export type PolicyTask = {
  readonly type: "identity_change_request" | "unknown_sender" | "staff_review";
  readonly familyToken: string | null;
  readonly sourceMessageId: string | null;
  /** Hash of the evidence text. The task points at the message; it never copies its words. */
  readonly evidenceHash: string;
  readonly rule: PolicyRuleId | null;
};

export type PolicyDecision =
  | { readonly verdict: "ALLOW"; readonly tool: string; readonly effect: ToolEffect; readonly args: Record<string, unknown> }
  | {
      readonly verdict: "PROPOSAL";
      readonly rule: "human_tier_requires_approval" | "send_requires_approval";
      readonly tool: string;
      readonly args: Record<string, unknown>;
      /** A proposal mutates nothing and sends nothing. Asserted for every human-tier and every sending tool. */
      readonly mutates: false;
      readonly requiresApproval: true;
    }
  | {
      readonly verdict: "BLOCK";
      readonly rule: PolicyRuleId;
      readonly tool: string;
      readonly reason: string;
      readonly tasks: readonly PolicyTask[];
    };

/* ──────────────────────────────────── context ──────────────────────────────────── */

/**
 * What this run is allowed to touch. A run belongs to exactly one site and one family: `siteToken`
 * is the tenant the scope was built for, `tokens` is every family-scoped identifier the tier
 * assembly handed the model (its family, children, legs, threads, sessions, acks, tasks,
 * messages), and `shared` is the non-family objects *of that site* it may legitimately name
 * (vehicles, providers, routes). Anything else in a scoped argument is a cross-family or
 * cross-site reference, and neither is reachable: the model never names a site, so a scope is
 * built from the caller's session, never from a tool argument (tools.FORBIDDEN_ARG_TOKENS.tenant).
 */
export type FamilyScope = {
  readonly siteToken: string;
  readonly familyToken: string;
  readonly tokens: ReadonlySet<string>;
  readonly shared: ReadonlySet<string>;
};

export type PolicyContext = {
  readonly scope: FamilyScope;
  /** Subjects whose authorized contacts have live consent right now (outbox/policy mirror). */
  readonly sendableSubjects: ReadonlySet<string>;
  /** Tokens known to belong to *other* families in this site. Classification only — see `evaluate`. */
  readonly foreignTokens?: ReadonlySet<string>;
  /** Tokens known to belong to *another site/tenant*. Classification only — the deny is identical. */
  readonly foreignSiteTokens?: ReadonlySet<string>;
  /**
   * Approval keys (`approvalKey(tool, args)`) a human has signed off for this run. One key
   * approves one exact call: an approval for yesterday's follow-up authorizes nothing today.
   * Staff approval is a later B-08 slice, so in slice 1 this is empty everywhere but in tests.
   */
  readonly approvedCalls?: ReadonlySet<string>;
  /** T3 bodies in this run's context, as received (unwrapped). Evidence, never instructions. */
  readonly untrustedMessages?: readonly string[];
  /** True while the agent is paused for this site (ops kill switch). */
  readonly paused?: boolean;
  /** The context tier the model cited as authority for this call, when it reports one. */
  readonly citedTier?: ContextTier;
  readonly sourceMessageId?: string | null;
};

/**
 * A minimal scope, for tests and for a run that has resolved nothing yet. `siteToken` defaults to
 * the one fixture site (ADR-000 #5, "S1" throughout the fixtures); a deployment builds the scope
 * from the session's site, never from a default.
 */
export function familyScope(
  familyToken: string,
  tokens: readonly string[],
  shared: readonly string[] = [],
  siteToken = "S1",
): FamilyScope {
  return { siteToken, familyToken, tokens: new Set([familyToken, ...tokens]), shared: new Set(shared) };
}

/**
 * The fingerprint a human approval is bound to. Canonical (keys sorted at every depth), so the
 * same call fingerprints the same whatever order the vendor emitted its arguments in, and a
 * different call — one changed token, one changed template — fingerprints differently.
 *
 * Keyed on the arguments as the model sent them, which is what `evaluate` sees on the next turn.
 * (No sending tool has a prose field, so sanitization cannot move the key underneath an approval.)
 */
export function approvalKey(tool: string, args: Record<string, unknown>): string {
  return sha256Hex(`${tool} ${JSON.stringify(canonicalize(args))}`);
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, canonicalize(v)]),
    );
  }
  return value;
}

/* ─────────────────── prohibited actions the catalog deliberately lacks ─────────────────── */

/**
 * §11.2 prohibits things the tool catalog has no tool for — editing an approved profile item,
 * adding a contact, overriding an approval, changing a policy, marking a verified state. A
 * hijacked model still *asks* for them by name, and "unknown tool" is the wrong thing to log: the
 * exception row should say which prohibition was attempted. This maps a requested name onto its
 * rule, so AGT-02's log names the rule and not just the miss.
 */
const PROHIBITED_ACTIONS: readonly { readonly pattern: RegExp; readonly rule: PolicyRuleId }[] = [
  { pattern: /^(?:mark|set|verify)_?.*board(?:ed|ing)?_?verified/i, rule: "mark_boarded_verified" },
  { pattern: /^(?:mark|set|complete)_?.*handoff/i, rule: "mark_completed_handoff" },
  { pattern: /^(?:mark|set|verify)_?.*capabilit/i, rule: "mark_capability_verified" },
  { pattern: /^(?:add|create|link)_.*(?:contact|guardian|relationship|person|caregiver)/i, rule: "add_contact_or_relationship" },
  { pattern: /^(?:edit|update|set|change|patch|apply|approve)_.*(?:profile|need|equipment|custody|identity)/i, rule: "edit_approved_profile" },
  { pattern: /^(?:approve|override|unblock|force|bypass)/i, rule: "override_approval" },
  { pattern: /^(?:set|change|update|disable)_.*(?:polic|rule|threshold|config|guard|consent|suppression)/i, rule: "change_policy" },
  { pattern: /^(?:send|text|sms|message|reply|email)_/i, rule: "free_text_to_parents" },
];

/** Which prohibition a requested-but-unknown action name attempts, or null when it is just unknown. */
export function prohibitedActionRule(name: string): PolicyRuleId | null {
  return PROHIBITED_ACTIONS.find((p) => p.pattern.test(name))?.rule ?? null;
}

/* ─────────────────────────── forbidden state claims ─────────────────────────── */

/**
 * States the agent may never claim (§11.2; machines.ts marks them staff-only). Matched as whole
 * tokens anywhere in the arguments — including prose — because fail-closed: a summary that asks
 * staff to "mark BOARDED_VERIFIED" is a request for a prohibited mutation in a field that is not
 * checked for one, and the right outcome is an exception a human reads.
 */
const FORBIDDEN_STATE_CLAIMS: readonly { readonly pattern: RegExp; readonly rule: PolicyRuleId }[] = [
  { pattern: /\bBOARDED_VERIFIED\b/, rule: "mark_boarded_verified" },
  { pattern: /\bCOMPLETED_HANDOFF\b/, rule: "mark_completed_handoff" },
  { pattern: /\bCAPABILITY_VERIFIED\b/, rule: "mark_capability_verified" },
  // Bare "VERIFIED" as a value of its own: capability and need items both have a VERIFIED state
  // the agent may not set (§11.2 record_capability_report is "auto (REPORTED only)").
  { pattern: /^VERIFIED$/, rule: "mark_capability_verified" },
];

/* ──────────────────────────── prose prohibitions ──────────────────────────── */

/**
 * Clinical advice (§11.2). Deliberately broad: this service moves children, it does not advise on
 * their care, so nothing the agent writes needs any of these words. A false positive costs one
 * staff-reviewed exception; a false negative is a care instruction from a transport bot.
 */
const CLINICAL_PATTERNS: readonly RegExp[] = [
  /\b(?:dose|dosage|doses|mg|ml|medication|medications|medicine|meds|prescri\w*|administer\w*|diagnos\w*|treatment|treat her|treat him|symptom\w*|seizure\s+protocol|insulin|oxygen\s+(?:level|rate)|suction\w*|feeding\s+tube|nebuliz\w*)\b/i,
  /\b(?:you|they|he|she)\s+should\s+(?:see|call|consult)\s+(?:a|the|her|his|their)\s+(?:doctor|nurse|physician|pediatrician)\b/i,
  /\b(?:it'?s|its)\s+(?:safe|fine|okay|ok)\s+to\s+(?:skip|stop|delay)\b/i,
];

/**
 * Attendance persuasion (§11.2). The agent records what a family decided; it never argues with
 * it. Every pattern here is a nudge toward attending, which is the center's conversation to have.
 */
const PERSUASION_PATTERNS: readonly RegExp[] = [
  /\b(?:please|try to|make sure to|be sure to)\s+(?:still\s+)?(?:come|attend|bring|send)\b/i,
  /\b(?:encourag\w+|remind\w*)\s+(?:her|him|them|the family|you)\s+to\s+(?:come|attend)\b/i,
  /\b(?:don'?t|do not)\s+(?:miss|skip)\b/i,
  /\b(?:would|will)\s+really\s+help\b/i,
  /\b(?:reconsider|think again|change your mind)\b/i,
  /\battendance\s+(?:matters|is important|affects)\b/i,
  /\b(?:important|better)\s+(?:that|for)\s+\w+\s+to\s+(?:come|attend|be here)\b/i,
];

/* ─────────────────────── T3: delimiters and injection directives ─────────────────────── */

export const UNTRUSTED_OPEN = "<untrusted_user_message>";
export const UNTRUSTED_CLOSE = "</untrusted_user_message>";

/**
 * §11.1/§11.2 delimiters: a family message is evidence inside a labelled envelope. Any attempt in
 * the body to close or re-open that envelope is defanged first — otherwise the delimiter is the
 * injection. Nothing else about the body is altered: staff and the model must see what arrived.
 */
export function wrapUntrusted(body: string): string {
  const inert = body.replace(/<\/?\s*untrusted_user_message\s*>/gi, "[delimiter removed]");
  return `${UNTRUSTED_OPEN}${inert}${UNTRUSTED_CLOSE}`;
}

/** Directive classes an inbound body can carry. Detected, logged, never followed. */
export type InjectionDirective =
  | "instruction_override"
  | "recipient_redirect"
  | "identity_change"
  | "disclosure_request"
  | "approval_request";

const DIRECTIVE_PATTERNS: readonly { readonly directive: InjectionDirective; readonly pattern: RegExp }[] = [
  { directive: "instruction_override", pattern: /\b(?:ignore|disregard|forget)\b[^.?!]{0,30}\b(?:previous|prior|above|earlier|all)\b[^.?!]{0,20}\b(?:instruction|instructions|rules|prompt|policy|policies)\b/i },
  // Word order is the first thing an attacker varies: "forget the rules above" says the same
  // thing as "ignore all previous instructions" and has to be read the same way.
  { directive: "instruction_override", pattern: /\b(?:ignore|disregard|forget|override)\b[^.?!]{0,30}\b(?:instruction|instructions|rules|prompt|policy|policies|guideline|guidelines)\b/i },
  { directive: "instruction_override", pattern: /\b(?:you are now|from now on you|new system prompt|act as|system:|override your)\b/i },
  { directive: "instruction_override", pattern: /<\/?\s*(?:system|assistant|untrusted_user_message)\s*>/i },
  { directive: "recipient_redirect", pattern: /\balso\s+(?:text|message|txt|sms|notify|send)\b/i },
  { directive: "recipient_redirect", pattern: /\b(?:text|message|send|forward)\b[^.?!]{0,20}\b(?:to|at)\b[^.?!]{0,10}(?:\+?\d[\d\s().-]{6,})/i },
  { directive: "identity_change", pattern: /\b(?:new|different|another|updated)\s+(?:number|phone|cell|mobile)\b/i },
  { directive: "identity_change", pattern: /\b(?:my|our)\s+(?:number|phone)\s+(?:has\s+)?(?:changed|is\s+now)\b/i },
  { directive: "identity_change", pattern: /\bi'?m\s+the\s+new\s+(?:guardian|parent|contact|caregiver)\b/i },
  { directive: "identity_change", pattern: /\b(?:i\s+am|this\s+is)\s+(?:the\s+)?(?:new\s+)?(?:guardian|legal\s+guardian)\b/i },
  { directive: "identity_change", pattern: /\b(?:use|switch\s+to|save)\s+this\s+(?:number|phone|contact)\b/i,
  },
  { directive: "disclosure_request", pattern: /\b(?:when|what time)\b[^.?!]{0,40}\b(?:the\s+)?(?:other|another|\w+'s)\s+(?:kid|kids|child|children|family|van)\b/i },
  { directive: "disclosure_request", pattern: /\b(?:who else|which (?:other )?(?:kids|children|families))\b/i },
  { directive: "disclosure_request", pattern: /\b(?:list|tell me|send me|give me|share|reply with|what(?:'s| is))\b[^.?!]{0,30}\b(?:roster|manifest|addresses|phone numbers|everyone)\b/i },
  { directive: "approval_request", pattern: /\b(?:approve|authorize|override|skip)\b[^.?!]{0,30}\b(?:it|this|the\s+\w+|approval|check|verification)\b/i },
  { directive: "approval_request", pattern: /\b(?:mark|set)\b[^.?!]{0,20}\b(?:verified|boarded|complete|completed|handed off)\b/i },
];

/** Every directive class present in a body. Empty for an ordinary message. */
export function detectInjection(body: string): InjectionDirective[] {
  return Array.from(
    new Set(DIRECTIVE_PATTERNS.filter((d) => d.pattern.test(body)).map((d) => d.directive)),
  );
}

/**
 * §11.2: `"also text…/new number/I'm the new guardian" → identity_change_request task`.
 *
 * The whole handling of an inbound family message before it becomes T3 context: wrap it in the
 * delimiters, note which directive classes it carries, and raise the identity_change_request task
 * when it claims a new number, a new contact or a new guardian. The task carries the message id
 * and a hash — a human reads the message itself, in the thread, where it already is.
 */
export function triageInbound(
  body: string,
  meta: { familyToken?: string | null; messageId?: string | null } = {},
): { wrapped: string; directives: InjectionDirective[]; tasks: PolicyTask[] } {
  const directives = detectInjection(body);
  const tasks: PolicyTask[] = [];
  if (directives.includes("identity_change") || directives.includes("recipient_redirect")) {
    tasks.push({
      type: "identity_change_request",
      familyToken: meta.familyToken ?? null,
      sourceMessageId: meta.messageId ?? null,
      evidenceHash: sha256Hex(body),
      rule: null,
    });
  }
  return { wrapped: wrapUntrusted(body), directives, tasks };
}

/**
 * The identity-change tasks the T3 messages of *this* run's context raise, for a decision that is
 * about to block because of them (`evaluate` step 8). Exactly `triageInbound`'s task, derived
 * again from the same bodies rather than passed in, so a caller cannot block on a directive and
 * forget to ask about the claim behind it.
 *
 * Deduplicated by evidence hash: the same message quoted twice in one context is one claim, and
 * one task.
 */
function identityClaimTasks(ctx: PolicyContext): PolicyTask[] {
  const out: PolicyTask[] = [];
  const seen = new Set<string>();
  for (const body of ctx.untrustedMessages ?? []) {
    const { tasks } = triageInbound(body, {
      familyToken: ctx.scope.familyToken,
      messageId: ctx.sourceMessageId ?? null,
    });
    for (const task of tasks) {
      if (seen.has(task.evidenceHash)) continue;
      seen.add(task.evidenceHash);
      out.push(task);
    }
  }
  return out;
}

/* ──────────────────────────────── the policy rows ──────────────────────────────── */

/**
 * One row per catalog tool: what the policy engine has to know about a tool that its schema
 * cannot say. Written out per tool rather than inferred from names, so the sixteenth tool is a
 * deliberate decision about scope and consent — and so a tool that arrives *without* that
 * decision is refused rather than quietly checked against nothing (`missing_policy_row`).
 */
export type PolicyRow = {
  readonly tool: string;
  /**
   * The arguments that name a scoped object. The post-validator checks exactly these against the
   * run's site/family scope. `[]` is a declaration ("this tool names nothing scoped"), not a gap.
   */
  readonly scopedArgs: readonly string[];
  /**
   * For a `send` tool, the argument naming the subject whose consent decides whether anything may
   * go out; `null` for every tool that does not send. The outbox re-checks consent per contact at
   * send time (outbox/policy); this is the earlier, cheaper refusal, so a suppressed family never
   * even gets a queued message (demo step 10). A sending tool whose row leaves this null cannot be
   * consent-checked, and is therefore refused.
   */
  readonly sendSubject: string | null;
  /**
   * For a sending tool whose §11.2 audience is one of its arguments: the argument naming the
   * audience, and the one value of it that reaches the center's **own staff** and nobody outside
   * the building. A call for that audience is not an egress event at all — the executor writes the
   * `ops.task` row a coordinator reads and queues nothing (run/exec/followup.ts `AUDIENCE_RULES`)
   * — so a family's consent to be *messaged* is not what decides whether staff may be told
   * something about them (founder ruling, DECISION-LEDGER #65, 2026-10-16). The family scope above
   * still is: a staff notice may only name this run's own family.
   *
   * Left out of every other row, and leaving it out means "consent-check every send on this row".
   * The exemption is a per-tool declaration matched on an exact value, so a sending tool added
   * without this decision keeps the strict check (`staffAudienceSend`).
   */
  readonly staffAudience?: { readonly arg: string; readonly value: string };
  /** Why the row looks like this. Read by whoever adds the next tool. */
  readonly note: string;
};

const ROWS: readonly PolicyRow[] = [
  { tool: "resolve_sender", scopedArgs: ["message_id"], sendSubject: null, note: "reads one message of this family's thread" },
  { tool: "get_leg_state", scopedArgs: ["leg_id"], sendSubject: null, note: "a leg belongs to one child" },
  { tool: "cancel_attendance_or_leg", scopedArgs: ["child_token"], sendSubject: null, note: "the date and day part are not objects" },
  { tool: "request_clarification", scopedArgs: ["thread_id", "candidate_tokens"], sendSubject: "thread_id", note: "an outbound into a thread: the thread is the consent subject" },
  { tool: "record_acknowledgment", scopedArgs: ["ack_id", "source_message_id"], sendSubject: null, note: "the ack row already binds its contact" },
  {
    tool: "send_followup",
    scopedArgs: ["subject_token"],
    sendSubject: "subject_token",
    // The one audience that is not a message: STAFF is a row on the center's own board.
    staffAudience: { arg: "audience", value: "STAFF" },
    note: "audience is a role; the subject is what consent is checked on, except for STAFF — which sends nothing",
  },
  { tool: "notify_affected_therapist", scopedArgs: ["therapy_session_token", "child_token"], sendSubject: "therapy_session_token", note: "the session is the therapist's side of the consent check" },
  // Vehicles, providers and routes are center-wide rather than family-scoped — but they are still
  // *this site's*: `scope.shared` holds one site's fleet, so they are checked like anything else.
  // That is what closes the tenant boundary for an id the runtime cannot classify: an unknown
  // vehicle is refused for not being in scope, without anyone having to know whose it is.
  { tool: "request_provider_capability", scopedArgs: ["vehicle_token", "provider_token", "route_token"], sendSubject: "provider_token", note: "site-wide objects, still site-scoped; the dispatcher is the consent subject" },
  { tool: "record_capability_report", scopedArgs: ["vehicle_token", "source_message_id"], sendSubject: null, note: "an observation about a site vehicle; `parsed` holds codes, not ids" },
  { tool: "report_boarding", scopedArgs: ["leg_id"], sendSubject: null, note: "BOARDED_REPORTED on one leg" },
  { tool: "propose_manifest_reallocation", scopedArgs: ["infeasible_vehicle_token", "leg_ids", "options"], sendSubject: null, note: "proposes only; `options` nests the vehicles and legs it would move" },
  { tool: "propose_contact_or_profile_change", scopedArgs: ["family_token", "source_message_id"], sendSubject: null, note: "proposes against this family only" },
  { tool: "escalate_exception", scopedArgs: ["leg_id"], sendSubject: null, note: "always allowed (§11.2), still scope-checked" },
  { tool: "close_task", scopedArgs: ["task_id", "evidence_ref"], sendSubject: null, note: "the evidence must be this run's own" },
  { tool: "summarize_thread_for_staff", scopedArgs: ["thread_id"], sendSubject: null, note: "staff-only note on this family's thread" },
];

/** The policy table, by tool name. `evaluate` denies any catalog tool that is not a key here. */
export const POLICY_ROWS: Readonly<Record<string, PolicyRow>> = Object.fromEntries(
  ROWS.map((r) => [r.tool, r]),
);

/** The row governing a tool, or null — which is a denial, never a default (see `evaluate`). */
export function policyRow(tool: string): PolicyRow | null {
  return POLICY_ROWS[tool] ?? null;
}

/* ──────────────────────────────────── evaluation ──────────────────────────────────── */

type Leaf = { path: string; value: string };

/** Every string leaf in the arguments, with its dotted path. */
function stringLeaves(value: unknown, path = "", acc: Leaf[] = []): Leaf[] {
  if (typeof value === "string") {
    acc.push({ path, value });
    return acc;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => stringLeaves(v, `${path}[${i}]`, acc));
    return acc;
  }
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) stringLeaves(v, path ? `${path}.${k}` : k, acc);
  }
  return acc;
}

/* ───────────── the §11.2 tiers: templated copy, and the free-text approval gate ───────────── */

/** Argument names that would carry prose to a family. None exist in the catalog; the rule outlives it. */
const FREE_TEXT_ARG = /^(?:body|text|message|message_body|free_text|draft|content|sms_body)$/i;

/**
 * The longest a single argument value of a templated send may be. Every value in one is a code, an
 * id, a date or a clock time, and the outbox's own var rules are tighter still
 * (`outbox.TEMPLATE_VARS`); this is the outer bound, matching the schema's `z.string().max(64)` on
 * a template var so that a direct caller of `evaluate` gets the same refusal the gateway would.
 */
const SEND_VALUE_MAX = 64;

/** A value the model built by filling in a placeholder itself, instead of naming a template. */
const INTERPOLATION = /\{\{|\}\}|\$\{|<%|%>|`|\\n|%s\b/;

/**
 * A value shaped like a phrase rather than a code: three or more words, a sentence ending, or a
 * comma-separated clause. Codes, ids, dates and clock times contain no whitespace and no sentence
 * punctuation, so this says "the model wrote this" without needing to know what it wrote.
 */
const PHRASE = /\S\s+\S+\s+\S|[.!?](?:\s|$)|,\s/;

/**
 * Why this value is prose rather than a code, or null when it is a code. The answer never contains
 * the value: a rejected value is the one thing a §11.2 log may not hold (`redact`), so the reason
 * names the argument and the shape, and a human reads the message itself.
 *
 * Exported for its own suite (PR #35 review, F7). It is the narrowest and most load-bearing piece
 * of the free-text gate — the one test that says where "a code" ends and "the model wrote this"
 * begins — and reaching it only through `evaluate` tested three examples of it. What it does *not*
 * catch is in that suite too: this is a shape check, not a language model, and it is the third of
 * three gates rather than the only one (see `freeTextInTemplatedSend`).
 */
export function freeTextShape(value: string): string | null {
  if (value.length > SEND_VALUE_MAX) return `is longer than ${SEND_VALUE_MAX} characters`;
  if (INTERPOLATION.test(value)) return "carries an interpolation placeholder";
  if (PHRASE.test(value)) return "reads as a phrase rather than a code";
  return null;
}

/**
 * Why this call to a `template`/`fixed` send tool counts as free text to its recipient, or null
 * when every part of it is a code. §11.2 makes these tools `auto`, and the whole reason that is
 * safe is that the model chooses *which* allow-listed message goes out and never a word of it: an
 * argument the schema does not declare, an argument named like a message body, a prose field on a
 * tool that should have none, a value shaped like a sentence, an id the outbox cannot render, or a
 * var the template does not permit each break that, and so each ends the auto tier.
 *
 * The verdict is a block rather than an approval request on purpose: the tool this arrived on is
 * templated, so there is no version of this call a human could sign — the right outcome is a
 * refusal and an exception row, not a staff queue full of prose someone has to re-type.
 */
function freeTextInTemplatedSend(
  def: ToolDef,
  copy: Exclude<SendCopy, { kind: "free_text" }>,
  args: Record<string, unknown>,
): string | null {
  // Argument and var *names* come from the vendor's response like everything else, so the ones
  // quoted back into a reason go through `redact()` — a log may hold the name of a rejected field,
  // not a number someone hid in it.
  const declared = new Set(Object.keys(def.schema.shape));
  const extra = Object.keys(args).filter((k) => !declared.has(k));
  if (extra.length > 0) return `argument(s) ${redact(extra.join(","))} are not declared by ${def.name}`;

  const prose = Object.keys(args).find((k) => FREE_TEXT_ARG.test(k));
  if (prose) return `argument ${prose} is free text to a family`;
  if (def.staffTextFields.length > 0) return `${def.name} sends and declares a prose argument`;

  for (const leaf of stringLeaves(args)) {
    const shape = freeTextShape(leaf.value);
    if (shape) return `argument ${leaf.path || "(root)"} ${shape}`;
  }

  if (copy.kind === "template") {
    const templateId = args[copy.idArg];
    if (typeof templateId !== "string" || !isRenderableTemplate(templateId)) {
      return `${copy.idArg} does not name an outbox template`;
    }
    if (copy.varsArg === null) return null;
    const vars = args[copy.varsArg];
    if (typeof vars !== "object" || vars === null || Array.isArray(vars)) {
      return `${copy.varsArg} is not a var object`;
    }
    const bad = disallowedVars(templateId, vars as Record<string, unknown>);
    if (bad.length > 0) return `vars not permitted for ${templateId}: ${redact(bad.join(","))}`;
  }
  return null;
}

/**
 * The scoped argument values of a call, flattened (a field may be a token or a list of them).
 *
 * With no policy row there is no declaration of what is scoped, so *every* string argument is
 * treated as scoped: fail shut. `evaluate` refuses a rowless tool before it gets here, and this
 * is what keeps a direct caller of the post-validator from being the hole.
 */
function scopedValues(tool: string, args: Record<string, unknown>): Leaf[] {
  const row = policyRow(tool);
  if (!row) return stringLeaves(args);
  return row.scopedArgs.flatMap((f) => stringLeaves(args[f], f));
}

/** One out-of-scope reference. The classification is for the audit; the denial does not vary. */
export type ScopeViolation = {
  readonly path: string;
  readonly token: string;
  /** Known to belong to another family in this site. */
  readonly foreign: boolean;
  /** Known to belong to another site/tenant. */
  readonly crossSite: boolean;
};

/**
 * The §11.2 family-scope post-validator, which is also the tenant boundary: it returns the
 * offending references, or an empty list when every scoped argument names something this run may
 * touch. A token the runtime knows belongs to another family or another site is reported as such;
 * an unknown token is still out of scope and still refused, so an id the agent invented and an id
 * that exists in another tenant are refused identically (see `evaluate` step 7).
 *
 * Two passes, because disclosure has two shapes. A *structured* one — a scoped argument naming
 * another family's child, or another site's vehicle — is caught by checking those arguments
 * against the scope. A *prose* one — a staff note that answers "when are the other kids picked
 * up" — is caught by looking for any known foreign token anywhere in the arguments, prose
 * fields included.
 */
export function validateFamilyScope(
  call: { tool: string; args: Record<string, unknown> },
  ctx: Pick<PolicyContext, "scope" | "foreignTokens" | "foreignSiteTokens">,
): ScopeViolation[] {
  const classify = (token: string) => ({
    foreign: ctx.foreignTokens?.has(token) ?? false,
    crossSite: ctx.foreignSiteTokens?.has(token) ?? false,
  });
  const out: ScopeViolation[] = scopedValues(call.tool, call.args)
    .filter((l) => !ctx.scope.tokens.has(l.value) && !ctx.scope.shared.has(l.value))
    .map((l) => ({ path: l.path, token: l.value, ...classify(l.value) }));
  for (const foreignToken of [...(ctx.foreignTokens ?? []), ...(ctx.foreignSiteTokens ?? [])]) {
    const named = new RegExp(`\\b${foreignToken.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
    for (const leaf of stringLeaves(call.args)) {
      if (!named.test(leaf.value)) continue;
      if (out.some((o) => o.path === leaf.path && o.token === foreignToken)) continue;
      out.push({ path: leaf.path, token: foreignToken, ...classify(foreignToken) });
    }
  }
  return out;
}

/**
 * True when this call's declared audience is the center's own staff, and so puts no message in
 * front of anybody outside the building (`PolicyRow.staffAudience`, DECISION-LEDGER #65).
 *
 * An exact match on an exact value, because everything this does *not* match is a send to a
 * guardian, a therapist or a dispatcher and has to keep the consent check: a row that declares no
 * staff audience, a missing argument, a value that is not a string, and every other audience —
 * including a near-miss the model invented, like "staff" or "STAFF " — all answer false.
 */
function staffAudienceSend(row: PolicyRow, args: Record<string, unknown>): boolean {
  return row.staffAudience !== undefined && args[row.staffAudience.arg] === row.staffAudience.value;
}

/** Tools that stay available while an injection is in the thread: they inform humans, nothing else. */
const DEFENSIVE_TOOLS: ReadonlySet<string> = new Set([
  "resolve_sender",
  "get_leg_state",
  "escalate_exception",
  "summarize_thread_for_staff",
  "propose_manifest_reallocation",
  "propose_contact_or_profile_change",
]);

const block = (
  rule: PolicyRuleId,
  tool: string,
  reason: string,
  tasks: readonly PolicyTask[] = [],
): PolicyDecision => ({ verdict: "BLOCK", rule, tool, reason, tasks });

/**
 * Evaluate one accepted tool call against §11.2. The gateway has already guaranteed the call is
 * schema-valid and in the catalog; everything here is about whether it is *permitted*.
 */
export function evaluate(
  call: Pick<AcceptedToolCall, "tool" | "args"> & { tier?: AcceptedToolCall["tier"] },
  ctx: PolicyContext,
): PolicyDecision {
  const def = toolDef(call.tool);
  const args = call.args ?? {};
  const evidenceHash = sha256Hex(JSON.stringify(args));
  const staffReview = (rule: PolicyRuleId): PolicyTask[] => [
    {
      type: "staff_review",
      familyToken: ctx.scope.familyToken,
      sourceMessageId: ctx.sourceMessageId ?? null,
      evidenceHash,
      rule,
    },
  ];

  // 1. Not in the catalog. Name the prohibition it attempts when the name says which one.
  if (!def) {
    const rule = prohibitedActionRule(call.tool) ?? "schema_only_tools";
    return block(rule, call.tool, `"${call.tool}" is not a §11.2 tool`, staffReview(rule));
  }
  const effect = def.effect;

  // 1b. Every catalog tool needs a policy row, and a sending tool needs a consent subject on it.
  //     A tool the table does not declare has been authorized by nobody: the gateway would hand
  //     its arguments to an engine with no idea what is scoped and nothing to consent-check, so
  //     the only safe verdict is a block and an exception row for staff. Unreachable with the
  //     catalog as it stands — which is the point: it is what makes adding tool sixteen safe.
  const row = policyRow(call.tool);
  if (!row) {
    return block("missing_policy_row", call.tool, `${call.tool} has no policy row`, staffReview("missing_policy_row"));
  }
  if (effect === "send" && row.sendSubject === null) {
    return block(
      "missing_policy_row",
      call.tool,
      `${call.tool} sends, but its policy row names no consent subject`,
      staffReview("missing_policy_row"),
    );
  }

  // 2. Paused. "sending while paused" is prohibited outright; a mutation while paused is the same
  //    autonomy by another route. escalate_exception stays available — §11.2 marks it "always
  //    allowed", and a paused agent still has to be able to tell staff why it stopped.
  if (ctx.paused && effect !== "read" && call.tool !== "escalate_exception") {
    return block("send_while_paused", call.tool, `agent is paused; ${effect} refused`, staffReview("send_while_paused"));
  }

  // 3. States the agent may never claim, anywhere in the arguments.
  for (const leaf of stringLeaves(args)) {
    const hit = FORBIDDEN_STATE_CLAIMS.find((f) => f.pattern.test(leaf.value));
    if (hit) {
      return block(hit.rule, call.tool, `argument ${leaf.path || "(root)"} claims a staff-only state`, staffReview(hit.rule));
    }
  }

  // 4. Prose prohibitions, before any redaction: clinical advice and attendance persuasion are
  //    about what the text *says*, and redaction would not change a word of either.
  for (const leaf of stringLeaves(args)) {
    if (CLINICAL_PATTERNS.some((re) => re.test(leaf.value))) {
      return block("clinical_advice", call.tool, `argument ${leaf.path || "(root)"} gives clinical advice`, staffReview("clinical_advice"));
    }
    if (PERSUASION_PATTERNS.some((re) => re.test(leaf.value))) {
      return block("attendance_persuasion", call.tool, `argument ${leaf.path || "(root)"} argues with an attendance decision`, staffReview("attendance_persuasion"));
    }
  }

  // 5. Raw recipients and PII. A number or an address in a tool call is the model choosing a
  //    recipient (§11.2) or leaking one; in a structured argument it is refused outright. In a
  //    staff-facing prose field it is redacted instead (`sanitizeStaffText`, below) — the words still have to reach a
  //    human, and `redact()` is exactly the contract for text that is kept.
  for (const leaf of stringLeaves(args)) {
    const field = leaf.path.split(/[.[]/)[0];
    if (def.staffTextFields.includes(field)) continue;
    const leaks = findLeaks(leaf.value);
    if (leaks.length > 0) {
      return block(
        "raw_recipient_selection",
        call.tool,
        `argument ${leaf.path || "(root)"} carries untokenized ${leaks.map((l) => l.kind).join("/")}`,
        staffReview("raw_recipient_selection"),
      );
    }
  }

  // 6. §11.2 tiers, first half: a templated send carries no free text at all. Outbound copy is an
  //    allow-listed template id plus vars the outbox permits, and the outbox owns both lists
  //    (outbox.TEMPLATE_VARS) — this re-checks them before enqueue so a policy block, not a render
  //    error, is what a bad call produces. The rest of `freeTextInTemplatedSend` is the same
  //    question asked of the other shapes free text arrives in: an undeclared argument, a
  //    body-shaped argument name, a value that reads as a sentence.
  //
  //    A send tool that declares no copy source is read as free text and falls through to step 10.
  const sendCopy: SendCopy | null = effect === "send" ? (def.sendCopy ?? { kind: "free_text" }) : null;
  if (sendCopy && sendCopy.kind !== "free_text") {
    const freeText = freeTextInTemplatedSend(def, sendCopy, args);
    if (freeText) return block("free_text_to_parents", call.tool, freeText, staffReview("free_text_to_parents"));
  }

  // 7. Family-scope post-validator (§11.2 injection defenses), which is also the tenant boundary.
  //
  //    The *reason* is deliberately the same sentence for all three cases — another site's object,
  //    another family's object, and an id that exists nowhere. A 404, not a 403: a run that could
  //    tell "no such leg" from "a leg you may not see" is an existence oracle for every other
  //    tenant in the database. Which of the three it was lives in the rule, for the audit.
  const outOfScope = validateFamilyScope({ tool: call.tool, args }, ctx);
  if (outOfScope.length > 0) {
    const rule: PolicyRuleId = outOfScope.some((v) => v.crossSite)
      ? "cross_site_disclosure"
      : "cross_family_disclosure";
    return block(
      rule,
      call.tool,
      `argument ${outOfScope[0].path} references an object outside this run's scope`,
      staffReview(rule),
    );
  }

  // 8. T3 is evidence, not instructions (§11.1). Two ways a call fails that: it cites T3 as its
  //    authority for a write, or the thread carries an injection directive and the call is not one
  //    of the tools that only informs a human. Either way the run may still escalate and propose.
  if (ctx.citedTier === "T3" && effect !== "read") {
    return block("obey_t3_instruction", call.tool, "a T3 message is not authority for a write or a send", staffReview("obey_t3_instruction"));
  }
  const directives = (ctx.untrustedMessages ?? []).flatMap(detectInjection);
  if (directives.length > 0 && !DEFENSIVE_TOOLS.has(call.tool)) {
    return block(
      "obey_t3_instruction",
      call.tool,
      `thread carries directive(s) ${Array.from(new Set(directives)).join(",")}; only escalation and proposals remain available`,
      // Two tasks, because a thread claiming a new number raises two questions: what to do about
      // the step that was refused (staff_review), and whether the claim itself is real
      // (identity_change_request, §11.2). The second is the same task `triageInbound` raises on
      // the message, carried on the decision so that whatever persists the block persists it too
      // (run/tasks.ts) — a decision whose tasks are dropped is a claim nobody is asked about.
      [...staffReview("obey_t3_instruction"), ...identityClaimTasks(ctx)],
    );
  }

  // 9. Consent, by subject. Mirrors the egress re-check so nothing is queued for a family that
  //    has opted out (PRD §18.2 step 10: "blocked at egress").
  //
  //    Except where the call sends to nobody outside the building. A STAFF-audience follow-up is
  //    the center telling itself something: the executor writes a GREEN `ops.task` row on the
  //    coordinators' board and queues no message at all (run/exec/followup.ts `staffNotice`), so
  //    there is no number for a family's consent to protect. The founder's ruling of 2026-10-16
  //    (DECISION-LEDGER #65) is that staff may be given a task about an opted-out family, and
  //    refusing it only meant a coordinator never heard about the family whose consent state is
  //    exactly the reason to look. What still gates it is step 7: a staff notice may name this
  //    run's own family and nothing else.
  //
  //    The exemption is a declaration on the row, matched on one exact audience value, so it
  //    cannot widen by accident: every send that does reach a guardian, a therapist or a
  //    dispatcher — templated or free text, whichever guardian the executor later resolves — comes
  //    through here, and a sending tool whose row declares no staff audience is checked as before.
  if (effect === "send" && row.sendSubject && !staffAudienceSend(row, args)) {
    const subject = args[row.sendSubject];
    if (typeof subject !== "string" || !ctx.sendableSubjects.has(subject)) {
      return block("non_consented_number", call.tool, `no live consent for subject in ${row.sendSubject}`, staffReview("non_consented_number"));
    }
  }

  const sanitized = sanitizeStaffText(call.tool, args);

  // 10. §11.2 tiers, second half: the approval gate, and only where §11.2 puts it.
  //
  //     What §11.2 prohibits is "free-text to parents **without human approval**", and it marks
  //     every sending tool in the catalog `auto`. So a templated or fixed-copy send that has got
  //     this far — in scope, consented, not paused, no directive in the thread, every value a code
  //     — goes out on the agent's own authority. That is the autonomy the whole feature is for
  //     (AT-01's confirmation, AT-14's therapist alert), and the thing that makes it safe is that
  //     the model chose *which* allow-listed message goes out and not one word of it: the copy is
  //     the outbox's, the recipients are computed at send time from an audience role (§10.3), and
  //     the egress layer re-checks consent per contact before anything leaves.
  //
  //     A send that would carry the model's own words to its recipient is the one case §11.2 holds
  //     behind a human, and the approval is bound to this *exact* call: `approvalKey` is canonical
  //     over the arguments, so an approval for yesterday's follow-up, for another template or for
  //     another subject releases nothing. Without one the verdict is a proposal — it mutates
  //     nothing, queues nothing, and carries the key a human signs (run/store.ts `args_hash`).
  //
  //     No catalog tool declares free-text copy, so with the catalog as it stands this branch is
  //     unreachable and there is no call the model can make that puts prose in front of a family.
  //     It is kept, and tested against a tool that does declare it (free-text-approval.test.ts),
  //     because the way to add such a tool is to declare it — and declaring it lands here.
  if (sendCopy?.kind === "free_text" && !(ctx.approvedCalls?.has(approvalKey(call.tool, args)) ?? false)) {
    return {
      verdict: "PROPOSAL",
      rule: "send_requires_approval",
      tool: call.tool,
      args: sanitized,
      mutates: false,
      requiresApproval: true,
    };
  }

  // 11. Human tier → proposal, never a mutation (§11.2 propose_* rows: "no mutation").
  if (def.tier === "human") {
    return {
      verdict: "PROPOSAL",
      rule: "human_tier_requires_approval",
      tool: call.tool,
      args: sanitized,
      mutates: false,
      requiresApproval: true,
    };
  }

  return { verdict: "ALLOW", tool: call.tool, effect, args: sanitized };
}

/**
 * `redact()` over every staff-facing prose argument. What is stored is what a human needs to act
 * plus nothing a log may not hold: an exception summary keeps its sentence and loses the number
 * someone tried to smuggle into it.
 */
export function sanitizeStaffText(tool: string, args: Record<string, unknown>): Record<string, unknown> {
  const def = toolDef(tool);
  if (!def || def.staffTextFields.length === 0) return args;
  const out: Record<string, unknown> = { ...args };
  for (const f of def.staffTextFields) {
    if (typeof out[f] === "string") out[f] = redact(out[f] as string);
  }
  return out;
}

/** True when this decision results in an outbound message. Used by the attack suite's send sink. */
export function decisionSends(decision: PolicyDecision): boolean {
  return decision.verdict === "ALLOW" && decision.effect === "send";
}
