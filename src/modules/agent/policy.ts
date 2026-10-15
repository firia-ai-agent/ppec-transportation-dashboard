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
 *   free-text to parents without approval ...... free_text_to_parents (template + var allow-list)
 *   messaging non-consented numbers ............ non_consented_number (mirrors the egress re-check)
 *   cross-family disclosure .................... cross_family_disclosure (family-scope post-validator)
 *   clinical advice ............................ clinical_advice
 *   attendance persuasion ...................... attendance_persuasion
 *   obeying T3 instructions .................... obey_t3_instruction
 *   sending while paused ....................... send_while_paused
 *
 * And the three defenses: delimiters (`wrapUntrusted`), schema-only tools with no
 * recipient/permission args (tools.ts), the family-scope post-validator (`validateFamilyScope`),
 * and "also text…/new number/I'm the new guardian" → identity_change_request (`triageInbound`).
 *
 * Two structural rules this module keeps:
 *  - a `human`-tier tool is always a proposal, never a mutation (§11.2 propose_* rows);
 *  - every block is a decision object, never an exception: a blocked call is a normal, logged
 *    outcome that raises an exception row for staff (AGT-02: "out-of-policy tool call rejected +
 *    logged"), not a crash.
 */
import { disallowedVars } from "@/modules/outbox/outbox";
import type { AcceptedToolCall } from "./gateway";
import { findLeaks, redact, sha256Hex } from "./redact";
import { type ToolEffect, isRenderableTemplate, toolDef } from "./tools";

/* ──────────────────────────────────── rules ──────────────────────────────────── */

export const POLICY_RULES = [
  "schema_only_tools",
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
  "cross_family_disclosure",
  "clinical_advice",
  "attendance_persuasion",
  "obey_t3_instruction",
  "send_while_paused",
  "human_tier_requires_approval",
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
      readonly rule: "human_tier_requires_approval";
      readonly tool: string;
      readonly args: Record<string, unknown>;
      /** A proposal mutates nothing. Asserted in policy.test.ts for both human-tier tools. */
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
 * What this run is allowed to touch. `tokens` is every family-scoped identifier the tier
 * assembly handed the model (its family, children, legs, threads, sessions, acks, tasks,
 * messages); `shared` is the non-family objects it may legitimately name (vehicles, providers,
 * routes). Anything else in a scoped argument is a cross-family reference.
 */
export type FamilyScope = {
  readonly familyToken: string;
  readonly tokens: ReadonlySet<string>;
  readonly shared: ReadonlySet<string>;
};

export type PolicyContext = {
  readonly scope: FamilyScope;
  /** Subjects whose authorized contacts have live consent right now (outbox/policy mirror). */
  readonly sendableSubjects: ReadonlySet<string>;
  /** Tokens known to belong to *other* families. Used by the post-validator for a precise verdict. */
  readonly foreignTokens?: ReadonlySet<string>;
  /** T3 bodies in this run's context, as received (unwrapped). Evidence, never instructions. */
  readonly untrustedMessages?: readonly string[];
  /** True while the agent is paused for this site (ops kill switch). */
  readonly paused?: boolean;
  /** The context tier the model cited as authority for this call, when it reports one. */
  readonly citedTier?: ContextTier;
  readonly sourceMessageId?: string | null;
};

/** A minimal scope, for tests and for a run that has resolved nothing yet. */
export function familyScope(familyToken: string, tokens: readonly string[], shared: readonly string[] = []): FamilyScope {
  return { familyToken, tokens: new Set([familyToken, ...tokens]), shared: new Set(shared) };
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
  { directive: "disclosure_request", pattern: /\b(?:list|tell me|send me|what(?:'s| is))\b[^.?!]{0,30}\b(?:roster|manifest|addresses|phone numbers|everyone)\b/i },
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

/* ──────────────────── which arguments are family-scoped / send subjects ──────────────────── */

/**
 * Per tool, the arguments that name a family-scoped object. The post-validator checks exactly
 * these against the run's scope. Listed per tool rather than inferred from the name, so adding a
 * tool is a deliberate decision about scope — `policy.test.ts` fails if a catalog tool is missing
 * an entry, including an explicit empty one.
 */
export const SCOPED_ARG_FIELDS: Readonly<Record<string, readonly string[]>> = {
  resolve_sender: ["message_id"],
  get_leg_state: ["leg_id"],
  cancel_attendance_or_leg: ["child_token"],
  request_clarification: ["thread_id", "candidate_tokens"],
  record_acknowledgment: ["ack_id", "source_message_id"],
  send_followup: ["subject_token"],
  notify_affected_therapist: ["therapy_session_token", "child_token"],
  // Vehicles, providers and routes are center-wide, not family-scoped: nothing to check.
  request_provider_capability: [],
  record_capability_report: ["source_message_id"],
  report_boarding: ["leg_id"],
  propose_manifest_reallocation: ["leg_ids"],
  propose_contact_or_profile_change: ["family_token", "source_message_id"],
  escalate_exception: ["leg_id"],
  close_task: ["task_id", "evidence_ref"],
  summarize_thread_for_staff: ["thread_id"],
};

/**
 * For each sending tool, the argument naming the subject whose consent decides whether anything
 * may go out. The outbox re-checks consent per contact at send time (outbox/policy); this is the
 * earlier, cheaper refusal so a suppressed family never even gets a queued message (demo step 10).
 */
const SEND_SUBJECT_FIELD: Readonly<Record<string, string>> = {
  send_followup: "subject_token",
  notify_affected_therapist: "therapy_session_token",
  request_clarification: "thread_id",
  request_provider_capability: "provider_token",
};

/** Argument names that would carry prose to a family. None exist in the catalog; the rule outlives it. */
const FREE_TEXT_ARG = /^(?:body|text|message|message_body|free_text|draft|content|sms_body)$/i;

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

/** The scoped argument values of a call, flattened (a field may be a token or a list of them). */
function scopedValues(tool: string, args: Record<string, unknown>): Leaf[] {
  const fields = SCOPED_ARG_FIELDS[tool] ?? [];
  return fields.flatMap((f) => stringLeaves(args[f], f));
}

/**
 * The §11.2 family-scope post-validator. Returns the offending references, or an empty list when
 * every scoped argument names something this run may touch. A token the runtime knows belongs to
 * another family is reported as such; an unknown token is still out of scope and still refused.
 *
 * Two passes, because cross-family disclosure has two shapes. A *structured* one — a scoped
 * argument naming another family's child — is caught by checking those arguments against the
 * scope. A *prose* one — a staff note that answers "when are the other kids picked up" — is
 * caught by looking for any known foreign token anywhere in the arguments, prose fields included.
 */
export function validateFamilyScope(
  call: { tool: string; args: Record<string, unknown> },
  ctx: Pick<PolicyContext, "scope" | "foreignTokens">,
): { path: string; token: string; foreign: boolean }[] {
  const out = scopedValues(call.tool, call.args)
    .filter((l) => !ctx.scope.tokens.has(l.value) && !ctx.scope.shared.has(l.value))
    .map((l) => ({ path: l.path, token: l.value, foreign: ctx.foreignTokens?.has(l.value) ?? false }));
  for (const foreignToken of ctx.foreignTokens ?? []) {
    const named = new RegExp(`\\b${foreignToken.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
    for (const leaf of stringLeaves(call.args)) {
      if (!named.test(leaf.value)) continue;
      if (out.some((o) => o.path === leaf.path && o.token === foreignToken)) continue;
      out.push({ path: leaf.path, token: foreignToken, foreign: true });
    }
  }
  return out;
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
  //    staff-facing prose field it is redacted instead (step 9) — the words still have to reach a
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

  // 6. Free text to parents. Outbound copy is a template id plus allow-listed vars, and the
  //    outbox owns both lists (outbox.TEMPLATE_VARS) — this re-checks them before enqueue so a
  //    policy block, not a render error, is what a bad call produces.
  if (effect === "send") {
    const prose = Object.keys(args).find((k) => FREE_TEXT_ARG.test(k) && !/template/i.test(k));
    if (prose) {
      return block("free_text_to_parents", call.tool, `argument ${prose} is free text to a family`, staffReview("free_text_to_parents"));
    }
    const templateId = typeof args.template_id === "string" ? args.template_id : typeof args.draft_template_id === "string" ? args.draft_template_id : null;
    if (templateId) {
      if (!isRenderableTemplate(templateId)) {
        return block("free_text_to_parents", call.tool, `template ${templateId} is not an outbox template`, staffReview("free_text_to_parents"));
      }
      const bad = disallowedVars(templateId, (args.vars ?? {}) as Record<string, unknown>);
      if (bad.length > 0) {
        return block("free_text_to_parents", call.tool, `vars not permitted for ${templateId}: ${bad.join(",")}`, staffReview("free_text_to_parents"));
      }
    }
  }

  // 7. Family-scope post-validator (§11.2 injection defenses).
  const outOfScope = validateFamilyScope({ tool: call.tool, args }, ctx);
  if (outOfScope.length > 0) {
    const first = outOfScope[0];
    return block(
      "cross_family_disclosure",
      call.tool,
      `argument ${first.path} references ${first.foreign ? "another family's" : "an out-of-scope"} object`,
      staffReview("cross_family_disclosure"),
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
      staffReview("obey_t3_instruction"),
    );
  }

  // 9. Consent, by subject. Mirrors the egress re-check so nothing is queued for a family that
  //    has opted out (PRD §18.2 step 10: "blocked at egress").
  const subjectField = SEND_SUBJECT_FIELD[call.tool];
  if (effect === "send" && subjectField) {
    const subject = args[subjectField];
    if (typeof subject !== "string" || !ctx.sendableSubjects.has(subject)) {
      return block("non_consented_number", call.tool, `no live consent for subject in ${subjectField}`, staffReview("non_consented_number"));
    }
  }

  // 10. Human tier → proposal, never a mutation (§11.2 propose_* rows: "no mutation").
  const sanitized = sanitizeStaffText(call.tool, args);
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
