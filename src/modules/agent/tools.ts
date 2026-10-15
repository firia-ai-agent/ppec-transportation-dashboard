/**
 * The §11.2 tool catalog (PRD l.930–991) as zod schemas — all 15 tools, each with its tier
 * (`auto` | `human`) and the effect the policy engine gates on.
 *
 * Two rules from the same section shape every schema here:
 *
 *  1. "schema-only tools with no recipient/permission args" (§11.2 injection defenses). No tool
 *     takes a phone number, an address, a contact, a permission or a scope. Recipients are
 *     "computed at send time" (§10.3) from an *audience role* plus a subject token, so the worst
 *     a hijacked model can do is name the wrong subject — which the family-scope post-validator
 *     then catches. `tools.test.ts` walks every schema's JSON Schema and fails on any such
 *     argument name, so the rule survives the next tool someone adds.
 *  2. No free text to a family. Wherever §11.2 writes `reason` or `draft`, this file takes a code
 *     or a template id instead. Prose arguments exist only on the staff-facing tools
 *     (`escalate_exception`, `summarize_thread_for_staff`, `propose_contact_or_profile_change`),
 *     are listed in `staffTextFields`, and are redacted by the policy engine before they are kept.
 *
 * Three argument names differ from the PRD's prose signature, and deliberately:
 *  - `cancel_attendance_or_leg(scope …)` → `day_part`: "scope" is the word this system uses for an
 *    authorization scope (AuthScope), and rule 1 bans scope arguments. The values are unchanged.
 *  - `send_followup(recipient_type, target_token …)` → `audience`, `subject_token`: rule 1 again.
 *  - `record_acknowledgment(ack_id, contact …)` → `ack_id` only: the pending acknowledgment row
 *    already binds its contact, so the agent names the ack, never the person (rule 1).
 */
import { z } from "zod";
import { TEMPLATE_VARS } from "@/modules/outbox/outbox";

/** §11.2 tier column. `human` tools may only ever produce a proposal (see policy.ts). */
export type ToolTier = "auto" | "human";

/**
 * What a call does, which is what the policy engine actually gates on:
 *  - `read`    no state change, no egress — allowed even while the run is paused;
 *  - `mutate`  writes state (always with an expected version);
 *  - `send`    puts a message in the outbox — the thing "sending while paused" forbids;
 *  - `propose` raises a change request / exception for a human; never mutates (§11.2 `human` tier).
 */
export type ToolEffect = "read" | "mutate" | "send" | "propose";

/**
 * Opaque identifier shape. Wide enough for a uuid and for a fixture key ("C1"), narrow enough
 * that a phone number, an address or a sentence cannot be passed where a token belongs — which
 * is what makes "no recipient args" enforceable rather than aspirational.
 */
const token = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const clockTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
/** Optimistic-concurrency version (§11.1: "fetched via tools before every write"). */
const version = z.number().int().nonnegative();
/** A staff-facing prose field. Bounded, and redacted by the policy engine before it is stored. */
const staffProse = z.string().min(1).max(600);

/* ─────────────────────────── send_followup template allow-list ─────────────────────────── */

/**
 * §11.2 send_followup: "template allow-list {confirmation, eta_delay, absence_to_therapist,
 * ack_reminder, capability_req}". Those five are message *families*; the ids the outbox renders
 * live in `TEMPLATE_VARS` (src/modules/outbox/outbox.ts), so the mapping is written out here and
 * `tools.test.ts` asserts every id on it is a real outbox template. Nothing in this module owns
 * a body or a var rule — the outbox stays the single source of both.
 */
export const FOLLOWUP_TEMPLATE_FAMILIES: Readonly<Record<string, readonly string[]>> = {
  confirmation: ["leg.canceled", "leg.changed"],
  eta_delay: ["pickup.eta", "dropoff.eta"],
  absence_to_therapist: ["therapist.absence_alert"],
  // No dedicated reminder body exists yet (B-05): the late alert and the fixed-copy notice carry
  // the reminder today, both of which are still allow-listed, var-checked copy.
  ack_reminder: ["therapist.late_alert", "generic.notice"],
  capability_req: ["generic.notice"],
};

/** The flat allow-list the schema enforces, derived so the two can never drift. */
export const FOLLOWUP_TEMPLATE_IDS: readonly string[] = Array.from(
  new Set(Object.values(FOLLOWUP_TEMPLATE_FAMILIES).flat()),
);

/**
 * Who a message is *for*, as a role. The egress layer turns this plus `subject_token` into actual
 * contact points at send time, after the authorization and consent checks
 * (outbox/policy.childAuthorized, messaging/consent) — the agent never sees a contact.
 */
export const AUDIENCES = ["GUARDIAN_OF_CHILD", "THERAPIST_OF_SESSION", "PROVIDER_DISPATCHER", "STAFF"] as const;

/** Vars a follow-up may carry. Scalars only; the outbox's own per-template allow-list decides the rest. */
const templateVars = z.record(z.string(), z.union([z.string().max(64), z.number(), z.boolean()]));

/* ─────────────────────────────────── the 15 tools ─────────────────────────────────── */

const CANCEL_REASON_CODES = ["ILLNESS", "FAMILY_DROPOFF", "FAMILY_REQUEST", "APPOINTMENT", "TRAVEL", "OTHER"] as const;
const AMBIGUITY_TYPES = ["WHICH_CHILD", "WHICH_LEG", "WHICH_DATE", "WHICH_DAY_PART", "UNKNOWN_INTENT"] as const;
/** Fixed-copy clarification bodies. A clarification is still an outbound message, so it is a template, not a draft. */
const CLARIFICATION_TEMPLATE_IDS = ["generic.notice"] as const;
const NEED_REQUIREMENTS = [
  "WHEELCHAIR_SECUREMENT", "LIFT_OR_RAMP", "CAR_SEAT_OR_BOOSTER", "HARNESS_OR_VEST", "ATTENDANT_ESCORT",
  "SEATING_SEPARATION", "MAX_RIDE_TIME", "EQUIPMENT_DIMENSIONS", "MEDICAL_DEVICE_POWER",
] as const;

export type ToolDef = {
  readonly name: string;
  readonly tier: ToolTier;
  readonly effect: ToolEffect;
  /** zod schema for the arguments. The gateway accepts nothing that fails it. */
  readonly schema: z.ZodObject;
  /** Argument names holding model prose. Staff-facing only, and redacted before storage. */
  readonly staffTextFields: readonly string[];
  /** PRD §11.2 row, for the audit trail and for whoever reads this next. */
  readonly prd: string;
};

const DEFS: readonly ToolDef[] = [
  {
    name: "resolve_sender",
    tier: "auto",
    effect: "read",
    schema: z.object({ message_id: token }),
    staffTextFields: [],
    prd: "§11.2: known contact point → candidates{child, legs, confidence}; unknown → unknown_sender task",
  },
  {
    name: "get_leg_state",
    tier: "auto",
    effect: "read",
    schema: z.object({ leg_id: token }),
    staffTextFields: [],
    prd: "§11.2: — → leg + version",
  },
  {
    name: "cancel_attendance_or_leg",
    tier: "auto",
    effect: "mutate",
    schema: z.object({
      child_token: token,
      date: isoDate,
      // §11.2 writes `scope FULL_DAY|AM|PM`; renamed per rule 1 (see file header), values unchanged.
      day_part: z.enum(["FULL_DAY", "AM", "PM"]),
      // §11.2 writes `reason`; a code, because a free-text reason is how a child's name reaches a log.
      reason_code: z.enum(CANCEL_REASON_CODES),
      /** "dropping at 9:30" (demo step 2). Null when the family named no self-arrival. */
      expected_self_arrival: clockTime.nullable(),
      expected_version: version,
    }),
    staffTextFields: [],
    prd: "§11.2: cancel_attendance_or_leg(child, date, scope FULL_DAY|AM|PM, reason, expected_self_arrival, expected_version)",
  },
  {
    name: "request_clarification",
    tier: "auto",
    effect: "send",
    schema: z.object({
      thread_id: token,
      ambiguity_type: z.enum(AMBIGUITY_TYPES),
      candidate_tokens: z.array(token).min(1).max(4),
      // §11.2 writes `draft`. A draft is prose going to a parent, which §11.2 also prohibits
      // without human approval, so the clarification goes out as fixed copy instead.
      draft_template_id: z.enum(CLARIFICATION_TEMPLATE_IDS),
    }),
    staffTextFields: [],
    prd: "§11.2: thread ACTIVE; ≤2/thread/hour → outbound + 15-min await; send fail → exception",
  },
  {
    name: "record_acknowledgment",
    tier: "auto",
    effect: "mutate",
    schema: z.object({
      ack_id: token,
      status: z.enum(["CONFIRMED", "DECLINED"]),
      source_message_id: token,
    }),
    staffTextFields: [],
    prd: "§11.2: matching PENDING ack → close, cancel timer; DECLINED → AMBER",
  },
  {
    name: "send_followup",
    tier: "auto",
    effect: "send",
    schema: z.object({
      // §11.2 writes `recipient_type, target_token`; renamed per rule 1 (see file header).
      audience: z.enum(AUDIENCES),
      subject_token: token,
      template_id: z.enum(FOLLOWUP_TEMPLATE_IDS as [string, ...string[]]),
      vars: templateVars,
    }),
    staffTextFields: [],
    prd: "§11.2: template allow-list {confirmation, eta_delay, absence_to_therapist, ack_reminder, capability_req}; egress re-check; notify gates",
  },
  {
    name: "notify_affected_therapist",
    tier: "auto",
    effect: "send",
    schema: z.object({
      therapy_session_token: token,
      child_token: token,
      impact: z.enum(["ABSENT", "LATE", "EARLY_PICKUP"]),
      eta: clockTime.nullable(),
    }),
    staffTextFields: [],
    prd: "§11.2: overlapping session on date → minimized SMS; status THERAPIST_NOTIFIED",
  },
  {
    name: "request_provider_capability",
    tier: "auto",
    effect: "send",
    schema: z.object({
      vehicle_token: token,
      provider_token: token,
      route_token: token,
      required: z.array(z.enum(NEED_REQUIREMENTS)).min(1),
    }),
    staffTextFields: [],
    prd: "§11.2: capability UNKNOWN at T−90 or on substitution → signed dispatcher link; state REQUESTED",
  },
  {
    name: "record_capability_report",
    tier: "auto",
    effect: "mutate",
    schema: z.object({
      vehicle_token: token,
      parsed: z.object({
        layout_code: token,
        wc_positions: z.number().int().nonnegative(),
        amb_positions: z.number().int().nonnegative(),
        lift_present: z.boolean(),
      }),
      source_message_id: token,
      // §11.2: "auto (REPORTED only)". Marking a capability VERIFIED is prohibited, and the
      // literal here means such a call cannot even be expressed.
      state: z.literal("REPORTED"),
      confidence: z.number().min(0).max(1),
    }),
    staffTextFields: [],
    prd: "§11.2: from provider contact point → observation; low confidence → staff review",
  },
  {
    name: "report_boarding",
    tier: "auto",
    effect: "mutate",
    schema: z.object({
      leg_id: token,
      source: z.enum(["GUARDIAN_REPLY", "STATIONARY_TAP"]),
      // §11.2: "BOARDED_REPORTED only" — BOARDED_VERIFIED is staff-only (machines.ts leg row).
      state: z.literal("BOARDED_REPORTED"),
      expected_version: version,
    }),
    staffTextFields: [],
    prd: "§11.2: guardian reply or stationary tap → BOARDED_REPORTED only",
  },
  {
    name: "propose_manifest_reallocation",
    tier: "human",
    effect: "propose",
    schema: z.object({
      infeasible_vehicle_token: token,
      leg_ids: z.array(token).min(1),
      options: z
        .array(z.object({ vehicle_token: token, leg_ids: z.array(token).min(1), added_minutes: z.number().int() }))
        .min(1),
      rationale_code: z.enum(["CAPACITY", "SECUREMENT", "LIFT", "RIDE_TIME", "SUBSTITUTION"]),
    }),
    staffTextFields: [],
    prd: "§11.2: INFEASIBLE/substitution → RED exception + Teams card; no mutation",
  },
  {
    name: "propose_contact_or_profile_change",
    tier: "human",
    effect: "propose",
    schema: z.object({
      family_token: token,
      category: z.enum(["PHONE", "CUSTODY", "EQUIPMENT", "RELATIONSHIP", "IDENTITY"]),
      /** What the family claims, in words, for a human to read. Never applied by the agent. */
      claim_summary: staffProse,
      source_message_id: token,
    }),
    staffTextFields: ["claim_summary"],
    prd: "§11.2: any phone/custody/equipment change → change request + exception",
  },
  {
    name: "escalate_exception",
    tier: "auto",
    effect: "mutate",
    schema: z.object({
      severity: z.enum(["RED", "AMBER", "INFO"]),
      category: z.enum([
        "NO_RECEIVER", "INFEASIBLE", "LOCATION_LOST", "SEND_FAILURE", "UNKNOWN_SENDER",
        "IDENTITY_CHANGE", "POLICY_BLOCK", "CAPABILITY_UNKNOWN", "ACK_OVERDUE",
      ]),
      leg_id: token.nullable(),
      summary: staffProse,
      next_step_code: z.enum(["STAFF_CALL", "STAFF_REVIEW", "DISPATCHER_PING", "APPROVAL_NEEDED", "NONE"]),
    }),
    staffTextFields: ["summary"],
    prd: "§11.2: always allowed",
  },
  {
    name: "close_task",
    tier: "auto",
    effect: "mutate",
    schema: z.object({ task_id: token, evidence_ref: token }),
    staffTextFields: [],
    prd: "§11.2: evidence satisfies completion predicate; else stays open",
  },
  {
    name: "summarize_thread_for_staff",
    tier: "auto",
    effect: "mutate",
    schema: z.object({ thread_id: token, summary: staffProse }),
    staffTextFields: ["summary"],
    prd: "§11.2: staff-only note",
  },
];

/** The catalog, by tool name. The gateway rejects any name that is not a key here. */
export const TOOL_REGISTRY: Readonly<Record<string, ToolDef>> = Object.fromEntries(
  DEFS.map((d) => [d.name, d]),
);

export const TOOL_NAMES: readonly string[] = DEFS.map((d) => d.name);

/** §11.2 lists 15 tools. Asserted in tools.test.ts so a dropped row is a failing test. */
export const TOOL_COUNT = 15;

export function toolDef(name: string): ToolDef | undefined {
  return TOOL_REGISTRY[name];
}

/** True when this template id is one the outbox knows how to render (defence in depth). */
export function isRenderableTemplate(templateId: string): boolean {
  return Object.hasOwn(TEMPLATE_VARS, templateId);
}

/**
 * The JSON Schema the provider is given — PRD §11.2 "JSON-schema tool calls only". Derived from
 * the zod schema, so the shape the vendor sees and the shape we validate against are one thing.
 */
export function toolJsonSchema(name: string): Record<string, unknown> {
  const def = toolDef(name);
  if (!def) throw new Error(`unknown tool ${name}`);
  return z.toJSONSchema(def.schema) as Record<string, unknown>;
}

/** Tool declarations for a provider call: name + JSON Schema, nothing else. */
export function toolDeclarations(names: readonly string[] = TOOL_NAMES) {
  return names.map((n) => ({ name: n, tier: toolDef(n)!.tier, parameters: toolJsonSchema(n) }));
}

/* ─────────────────────── the "no recipient/permission args" rule ─────────────────────── */

/**
 * Argument-name tokens no tool schema may contain, split by why (§11.2 injection defenses).
 * Matched against each `_`-separated piece of every property name at every depth, so
 * `guardian_phone`, `phones` and `toPhone` all fail. The test that walks the registry with this
 * list is the enforcement; this constant is just where the rule is written down.
 */
export const FORBIDDEN_ARG_TOKENS: Readonly<Record<string, readonly string[]>> = {
  // "choosing raw recipients" is prohibited; recipients are computed at send time (§10.3).
  recipient: ["recipient", "recipients", "to", "cc", "bcc", "dest", "destination", "contact", "contacts", "sender"],
  // An address or a number in an argument is PHI in a tool call, and a way to text a stranger.
  // "state" and "city" are deliberately absent: in this domain `state` is a machine state
  // (report_boarding, record_capability_report), and an address *value* that lands in any
  // argument is refused by the policy engine's leak scan (policy.ts step 5) regardless of name.
  address: ["phone", "phones", "number", "numbers", "msisdn", "e164", "tel", "telephone", "mobile", "cell",
    "sms", "email", "address", "street", "zip", "postal"],
  // "overriding approvals; changing policies" is prohibited, so no argument may express either.
  permission: ["permission", "permissions", "scope", "scopes", "authorization", "authorized", "consent",
    "approval", "approve", "approved", "override", "role", "roles", "grant", "grants", "acl", "policy", "policies"],
};

const FORBIDDEN_ARG_TOKEN_SET: ReadonlySet<string> = new Set(
  Object.values(FORBIDDEN_ARG_TOKENS).flat(),
);

/** Which forbidden class this argument name falls in, or null when the name is acceptable. */
export function forbiddenArgReason(name: string): string | null {
  const pieces = name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  const hit = pieces.find((p) => FORBIDDEN_ARG_TOKEN_SET.has(p));
  if (!hit) return null;
  const cls = Object.entries(FORBIDDEN_ARG_TOKENS).find(([, toks]) => toks.includes(hit))![0];
  return `${cls} argument "${hit}"`;
}

/** Every property name in a JSON Schema, at every depth (objects, arrays, unions, records). */
export function jsonSchemaPropertyNames(schema: unknown, acc: string[] = []): string[] {
  if (!schema || typeof schema !== "object") return acc;
  if (Array.isArray(schema)) {
    for (const s of schema) jsonSchemaPropertyNames(s, acc);
    return acc;
  }
  for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
    if (key === "properties" && value && typeof value === "object" && !Array.isArray(value)) {
      for (const [prop, sub] of Object.entries(value as Record<string, unknown>)) {
        acc.push(prop);
        jsonSchemaPropertyNames(sub, acc);
      }
      continue;
    }
    jsonSchemaPropertyNames(value, acc);
  }
  return acc;
}
