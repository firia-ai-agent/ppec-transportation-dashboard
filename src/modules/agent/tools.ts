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
 *     Every sending tool says where its outbound copy comes from (`sendCopy`), and the four in the
 *     catalog are all `template` or `fixed` — so no call the model can make puts its own words in
 *     front of a family. That declaration is what decides the §11.2 tier the policy engine applies
 *     (policy.ts step 6/10): templated copy sends on the agent's own authority, free text does not.
 *     The sending schemas are `strictObject` for the same reason: an argument the model invented is
 *     refused at the gateway rather than quietly stripped off a message that then goes out.
 *
 * Three argument names differ from the PRD's prose signature, and deliberately:
 *  - `cancel_attendance_or_leg(scope …)` → `day_part`: "scope" is the word this system uses for an
 *    authorization scope (AuthScope), and rule 1 bans scope arguments. The values are unchanged.
 *  - `send_followup(recipient_type, target_token …)` → `audience`, `subject_token`: rule 1 again.
 *  - `record_acknowledgment(ack_id, contact …)` → `ack_id` only: the pending acknowledgment row
 *    already binds its contact, so the agent names the ack, never the person (rule 1).
 */
import { NEED_CATEGORY } from "@/config/equipment";
import { z } from "zod";
import { ALERT_TEXT_MAX, ALERT_TEXT_MIN, isAlertText } from "./alert-text";
import { KNOWN_STOP_TOKENS } from "@/modules/messaging/templates";
import { REPLY_TEXT_MAX, replyTextIssue } from "@/modules/messaging/reply-text";
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

/**
 * `propose_dropoff_change.alert_text` — the one line a coordinator reads on the waiting proposal,
 * in the model's own words (Firia, 2026-10-18 11:15 AM ET).
 *
 * The rules are `alert-text.ts`'s and are stated there: bounded, one sentence, no code and no
 * machinery, people as the tokens every prompt is written in. It is a `staffTextFields` entry, so
 * the policy engine redacts it before it is stored like every other staff-facing prose argument —
 * and a redacted `[name]` fails `isAlertText`, which is what puts a leak on the named fallback
 * line instead of on a card.
 *
 * It is the ONLY prose argument on a `propose_*` tool bar `claim_summary`, and it is safe to be
 * one for the same reason that one is: this tool sends nothing (`sendCopy: null`), so no word of
 * it can reach a family. What a family would be told is still `DROPOFF_CHANGE_TEMPLATE` rendered
 * by the outbox from structured fields, approved by a person.
 */
const alertTextArg = z
  .string()
  .min(ALERT_TEXT_MIN)
  .max(ALERT_TEXT_MAX)
  .refine(isAlertText, "alert_text must be one plain sentence for a coordinator: no codes, no ids");

/**
 * Why a family is asking for a different drop-off. Codes, not prose, for the same reason
 * `cancel_attendance_or_leg` takes a `reason_code`: a free-text reason is how a child's name
 * reaches an audit log. The coordinator reads the family's own words in the thread beside the
 * proposal; this is the one-word version that goes in the row.
 */
export const DROPOFF_CHANGE_REASON_CODES = [
  "PARENT_REQUEST", "ALTERNATE_RECEIVER", "APPOINTMENT", "SCHEDULE_CONFLICT", "OTHER",
] as const;

/* ─────────────────────────── send_followup template allow-list ─────────────────────────── */

/**
 * §11.2 send_followup: "template allow-list {confirmation, eta_delay, absence_to_therapist,
 * ack_reminder, capability_req}". Those five are message *families*; the ids the outbox renders
 * live in `TEMPLATE_VARS` (src/modules/outbox/outbox.ts), so the mapping is written out here and
 * `tools.test.ts` asserts every id on it is a real outbox template. Nothing in this module owns
 * a body or a var rule — the outbox stays the single source of both.
 */
export const FOLLOWUP_TEMPLATE_FAMILIES: Readonly<Record<string, readonly string[]>> = {
  /*
   * ONE confirmation, not three. `leg.changed` and `dropoff.changed` came off this list on
   * Firia's 11:00 PM ET ruling (Veri S1-1): they are the two bodies that tell a family their
   * child's ride is different, and the whole of goal 4 is that a person decides that. While
   * they were here the model could send the exact text the "For you" card asks a coordinator
   * to approve — with the proposal still pending, or with no proposal at all. Veri's probe ran
   * it: resolve_sender → get_leg_state → send_followup(dropoff.changed) succeeded, 0 approval
   * rows, the message queued and drained SENT.
   *
   * Both are still real templates and are still sent — by `src/modules/approvals/decide.ts`,
   * after a director or a coordinator has pressed Approve (APPROVAL_ROLES). They are simply not
   * the agent's to send. `leg.canceled` stays: a cancellation the family itself asked for,
   * which `cancel_attendance_or_leg` has its own §11.2 tier for.
   */
  confirmation: ["leg.canceled"],
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
/**
 * The need categories a tool argument may name. The five the product reads and writes come from
 * the one shared list (src/config/equipment.ts) rather than being spelled again here: two
 * vocabularies for one category is how a tool call and the board stop agreeing (Veri's gate,
 * 2026-10-17 7:27 PM ET).
 */
const NEED_REQUIREMENTS = [
  NEED_CATEGORY.wheelchair, "LIFT_OR_RAMP", NEED_CATEGORY.carSeat, NEED_CATEGORY.harness,
  NEED_CATEGORY.nurse, "SEATING_SEPARATION", "MAX_RIDE_TIME", "EQUIPMENT_DIMENSIONS",
  "MEDICAL_DEVICE_POWER", NEED_CATEGORY.oxygen,
] as const;

/**
 * Where a sending tool's outbound copy comes from — the fact §11.2's tier column turns on, written
 * per tool because no schema can state it:
 *
 *  - `template`  the model picks an id from this tool's own allow-list and supplies vars the outbox
 *                permits for it; the words are the outbox's (`messaging/copy.ts`). `idArg` is the
 *                argument holding the id, `varsArg` the one holding the vars, or null when the
 *                allow-listed templates take none.
 *  - `fixed`     the model supplies no copy at all: the body is rendered downstream from structured
 *                fields (a minimized therapist SMS, a signed dispatcher link).
 *  - `free_text` the call carries words of the model's own to its recipient. §11.2 permits that
 *                only with a human approval bound to the exact call, so the policy engine holds
 *                such a send behind `ctx.approvedCalls`. **No tool in this catalog declares it** —
 *                adding one is the deliberate act of putting a tool behind the approval gate.
 *
 * A sending tool that declares nothing is read as `free_text`: the strictest tier, so a tool added
 * without this decision is approval-gated rather than autonomous (policy.ts step 10).
 */
export type SendCopy =
  | { readonly kind: "template"; readonly idArg: string; readonly varsArg: string | null }
  | { readonly kind: "fixed" }
  | { readonly kind: "free_text" };

export type ToolDef = {
  readonly name: string;
  readonly tier: ToolTier;
  readonly effect: ToolEffect;
  /** zod schema for the arguments. The gateway accepts nothing that fails it. */
  readonly schema: z.ZodObject;
  /** Argument names holding model prose. Staff-facing only, and redacted before storage. */
  readonly staffTextFields: readonly string[];
  /** Where this tool's outbound copy comes from; `null` on every tool that does not send. */
  readonly sendCopy: SendCopy | null;
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
    sendCopy: null,
    prd: "§11.2: known contact point → candidates{child, legs, confidence}; unknown → unknown_sender task",
  },
  {
    name: "get_leg_state",
    tier: "auto",
    effect: "read",
    schema: z.object({ leg_id: token }),
    staffTextFields: [],
    sendCopy: null,
    prd: "§11.2: — → leg + version",
  },
  /**
   * WHAT A FAMILY ACTUALLY SAID, for the one question the bubble has to be able to answer.
   *
   * Firia and Vera, 2026-10-18 11:13 AM ET: a coordinator looking at the drop-off alert types
   * "what did they ask?" into the bubble, and the answer has to be *the model reading the thread*
   * — not a stored summary, not a template, and not a parser over the family's sentence. The
   * catalog had no tool for that. `resolve_sender` turns a message into candidates and
   * `get_leg_state` reads a ride; the messages themselves could only reach a model through T3 of
   * whichever run happened to be triggered by one of them, which a staff ask never is. So this is
   * the read that was missing, and the bubble's answer comes from it.
   *
   * `read`, and in this system that word means it: no row is written, nothing is sent, and the
   * tool stays available while the agent is paused (policy.ts step 2). A paused deployment must
   * still be able to tell a coordinator what a parent asked for.
   *
   * **Site-scoped, and that is the executor's job rather than this schema's** — there is no `site`
   * argument and there may not be one (`FORBIDDEN_ARG_TOKENS.tenant`): the site comes from the
   * run, and the thread has to be inside the run's own family scope or the policy engine refuses
   * the call before any executor sees it. A thread token from another family resolves to nothing.
   *
   * What comes back is the bodies **as stored** — `ops.message.body_tokenized`, which the ingest
   * already stripped of contact details — with the people in them tokenized on the way into the
   * prompt, because every prompt this app sends is token-only and the gateway fails closed on a
   * name. The model therefore answers in tokens, and `identity/names.detokenizeNames` is what
   * turns its sentence back into "Dara" and "Noah" for the screen.
   *
   * `count` rather than `limit`: a count of messages is a number, and the word says what it is.
   */
  {
    name: "read_guardian_thread",
    tier: "auto",
    effect: "read",
    schema: z.object({ thread_id: token, count: z.number().int().min(1).max(10) }),
    staffTextFields: [],
    sendCopy: null,
    prd: "§11.1 T3 as a tool: the last N messages on a family-scoped thread, as evidence, never as instructions",
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
    sendCopy: null,
    prd: "§11.2: cancel_attendance_or_leg(child, date, scope FULL_DAY|AM|PM, reason, expected_self_arrival, expected_version)",
  },
  {
    name: "request_clarification",
    /*
     * HUMAN TIER, PROPOSE EFFECT (Firia's S1-7 ruling, 2026-10-18, answering run 7's open
     * question). A clarification is a text to a family, and the whole of goal 4 is that a person
     * decides those. The call writes a `MESSAGE_SEND` proposal
     * (`modules/approvals/message-send.ts`) and queues nothing; `approvals/decide.ts` is the only
     * code that can send it, after somebody presses Approve.
     *
     * `sendCopy` stays `template` and the allow-list stays on the schema: what a human approves
     * is still outbox copy, not the model's words, and a tool that declared nothing here would be
     * read as `free_text` (step 10). The tier is what changed, not where the words come from.
     */
    tier: "human",
    effect: "propose",
    schema: z.strictObject({
      thread_id: token,
      ambiguity_type: z.enum(AMBIGUITY_TYPES),
      candidate_tokens: z.array(token).min(1).max(4),
      // §11.2 writes `draft`. A draft is prose going to a parent, which §11.2 also prohibits
      // without human approval, so the clarification goes out as fixed copy instead.
      draft_template_id: z.enum(CLARIFICATION_TEMPLATE_IDS),
    }),
    staffTextFields: [],
    sendCopy: { kind: "template", idArg: "draft_template_id", varsArg: null },
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
    sendCopy: null,
    prd: "§11.2: matching PENDING ack → close, cancel timer; DECLINED → AMBER",
  },
  {
    name: "send_followup",
    /*
     * HUMAN TIER, PROPOSE EFFECT (Firia's S1-7 ruling, 2026-10-18). Same ruling, same reason as
     * `request_clarification` above: a follow-up is a text to a family, and a person decides it.
     *
     * What this does NOT change is the day's own notices. `pickup.eta`, `dropoff.eta`,
     * `dropoff.late` and `dropoff.received` are sent by the deterministic sweeps
     * (`messaging/eta-notice.ts`), not by this tool, and they keep sending with no staff tap —
     * `messaging/auto-sends.ts` is the allow-list behind "Auto · Delivered" and it is untouched.
     * The GPS late notice in particular MUST keep auto-sending (Firia, S1-7).
     */
    tier: "human",
    effect: "propose",
    schema: z.strictObject({
      // §11.2 writes `recipient_type, target_token`; renamed per rule 1 (see file header).
      audience: z.enum(AUDIENCES),
      subject_token: token,
      template_id: z.enum(FOLLOWUP_TEMPLATE_IDS as [string, ...string[]]),
      vars: templateVars,
    }),
    staffTextFields: [],
    sendCopy: { kind: "template", idArg: "template_id", varsArg: "vars" },
    prd: "§11.2: template allow-list {confirmation, eta_delay, absence_to_therapist, ack_reminder, capability_req}; egress re-check; notify gates",
  },
  {
    name: "notify_affected_therapist",
    tier: "auto",
    effect: "send",
    schema: z.strictObject({
      therapy_session_token: token,
      child_token: token,
      impact: z.enum(["ABSENT", "LATE", "EARLY_PICKUP"]),
      eta: clockTime.nullable(),
    }),
    staffTextFields: [],
    sendCopy: { kind: "fixed" },
    prd: "§11.2: overlapping session on date → minimized SMS; status THERAPIST_NOTIFIED",
  },
  {
    name: "request_provider_capability",
    tier: "auto",
    effect: "send",
    schema: z.strictObject({
      vehicle_token: token,
      provider_token: token,
      route_token: token,
      required: z.array(z.enum(NEED_REQUIREMENTS)).min(1),
    }),
    staffTextFields: [],
    sendCopy: { kind: "fixed" },
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
    sendCopy: null,
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
    sendCopy: null,
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
    sendCopy: null,
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
    sendCopy: null,
    prd: "§11.2: any phone/custody/equipment change → change request + exception",
  },
  /**
   * The drop-off a family asked for (PRD §18.2 steps 9–10, §11.2 human tier; AT-01, AT-09).
   *
   * The commonest thing a parent texts a transport desk — "can he be dropped at grandma's at 5?"
   * — had no tool at all. The catalog could cancel a ride, move a manifest and raise a change
   * request about a phone number, so a model reading that text could only cancel the ride or
   * escalate it: the two worst available answers to a question with an obvious right one.
   *
   * `human` tier, and that is the whole shape of it: a drop-off is where a child is handed to an
   * adult, so no model moves one. The call produces an approval request and an exception for a
   * coordinator to decide from, and `policy.ts` returns PROPOSAL for every `human`-tier call, so
   * there is no code path on which this mutates anything however the model phrases it.
   *
   * ## Structured output is the only way a requested time gets in
   *
   * The founder's rule of 2026-10-17 removed the other way — a keyword/regex reader over the
   * family's own sentence — so `requested_dropoff_time` is a field of a schema-validated tool
   * call or it does not exist. With the model down there is no proposal at all; there is the
   * "needs a person" staff alert instead (`agent/staff-alert.ts`), and
   * `agent/no-keyword-fallback.test.ts` scans the parent-reply path for a time regex and fails
   * if one ever reappears.
   *
   * ## Why there is no address argument
   *
   * The family typed one. It does not come in here, and could not: `address` is a forbidden
   * argument token (`FORBIDDEN_ARG_TOKENS.address`), and a street in a tool call is PHI in an
   * audit log and a way to set a child down somewhere nobody vetted. So the *place* half of this
   * tool is a **stop token off the center's own list** (`KNOWN_STOP_TOKENS`, derived from the
   * code-owned table in copy.ts): the model may propose a stop the center already uses, and
   * "grandma's house" is not one of them — that is a conversation for a coordinator, which is
   * exactly what the exception this raises is for. The *time* half is a 24-hour clock value, the
   * same constrained shape every other time in the catalog takes.
   *
   * One of the two must be present, and `superRefine` is what says so rather than a comment: a
   * call that proposes neither a new time nor a new place is proposing nothing, and the gateway
   * refuses it as invalid arguments instead of writing an empty approval request for a person to
   * puzzle over.
   */
  {
    name: "propose_dropoff_change",
    tier: "human",
    effect: "propose",
    schema: z
      .object({
        leg_id: token,
        /** The new drop-off time, 24-hour. Null when only the place is being proposed. */
        requested_dropoff_time: clockTime.nullable(),
        /** One of the center's own stops. Null when only the time is being proposed. */
        requested_stop_token: z.enum(KNOWN_STOP_TOKENS as [string, ...string[]]).nullable(),
        rationale_code: z.enum(DROPOFF_CHANGE_REASON_CODES),
        /**
         * WHAT THE ALERT SAYS, in the model's own words — the one line a coordinator reads beside
         * the thread. Required, because a proposal whose alert this app had to word for itself is
         * exactly the thing the 11:15 ruling took off the board (`alert-text.ts`).
         */
        alert_text: alertTextArg,
        /**
         * THE REPLY TO THE PARENT, IN THE MODEL'S OWN WORDS (Firia, 2026-10-18 11:04 AM ET).
         *
         * The only prose argument in this catalog that is meant for a *family*, and the only one
         * there will be: the proposal it rides on is `human` tier, so these words reach nobody
         * until a director or a coordinator has approved that exact call. §11.2 bans free text to
         * parents **without human approval**, and this is the path that has one — rule 2 in this
         * file's header is unchanged for every `sendCopy` tool, all four of which still declare
         * `template` or `fixed`.
         *
         * It is here rather than on the card because of what the founder's complaint was: the
         * fixed template answered a question Dara did not ask. A model that has understood the
         * text well enough to propose five o'clock can say so in a sentence, and a model that
         * cannot has not understood it — in which case there is no proposal at all and the staff
         * alert is what a coordinator gets (`agent/staff-alert.ts`).
         *
         * Bounded and shape-checked by `messaging/reply-text.ts`, so a reply carrying a phone
         * number, an address, a URL, a uuid, an internal code or the machine's own `PPEC:` prefix
         * is refused at the gateway as invalid arguments and never becomes a row. It is NOT in
         * `staffTextFields`: `redact()` would replace the two names the ruling requires with
         * `[REDACTED:NAME]`, and this text is a message to a family about their own child rather
         * than a note kept in a log (see reply-text.ts).
         */
        reply: z
          .string()
          .min(1)
          .max(REPLY_TEXT_MAX)
          .superRefine((value, ctx) => {
            const issue = replyTextIssue(value);
            // The reason, never the value: a refused reply is refused because of what may be in it.
            if (issue) ctx.addIssue({ code: "custom", message: `reply ${issue}` });
          }),
        source_message_id: token,
        expected_version: version,
      })
      .superRefine((args, ctx) => {
        if (args.requested_dropoff_time === null && args.requested_stop_token === null) {
          ctx.addIssue({
            code: "custom",
            message: "propose_dropoff_change needs a new time, a new stop, or both",
          });
        }
      }),
    staffTextFields: ["alert_text"],
    sendCopy: null,
    prd: "§11.2 human tier: a drop-off a family asked for → approval request + exception; no mutation",
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
    sendCopy: null,
    prd: "§11.2: always allowed",
  },
  {
    name: "close_task",
    tier: "auto",
    effect: "mutate",
    schema: z.object({ task_id: token, evidence_ref: token }),
    staffTextFields: [],
    sendCopy: null,
    prd: "§11.2: evidence satisfies completion predicate; else stays open",
  },
  {
    name: "summarize_thread_for_staff",
    tier: "auto",
    effect: "mutate",
    schema: z.object({ thread_id: token, summary: staffProse }),
    staffTextFields: ["summary"],
    sendCopy: null,
    prd: "§11.2: staff-only note",
  },
];

/** The catalog, by tool name. The gateway rejects any name that is not a key here. */
export const TOOL_REGISTRY: Readonly<Record<string, ToolDef>> = Object.fromEntries(
  DEFS.map((d) => [d.name, d]),
);

export const TOOL_NAMES: readonly string[] = DEFS.map((d) => d.name);

/**
 * §11.2 lists 15 tools; this catalog holds 17. The two beyond the PRD are
 * `propose_dropoff_change` — the commonest thing a parent texts a transport desk, which had no
 * tool at all — and `read_guardian_thread`, the read the bubble's answer comes from. Asserted in
 * tools.test.ts, so a dropped row is a failing test and an added one is a deliberate edit here.
 */
export const TOOL_COUNT = 17;

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
 * Argument-name tokens no tool schema may contain, split by why (§11.2 injection defenses, plus
 * the tenant rule the same reasoning implies).
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
  // Not §11.2 text, but the same idea one level up: the *tenant* a run belongs to is decided by
  // the session that started it and handed to the policy engine as `FamilyScope.siteToken`. If a
  // tool took a site, an injected message could ask for another one, and the family-scope
  // post-validator would be checking arguments against a scope the attacker chose.
  tenant: ["site", "sites", "tenant", "tenants", "org", "orgs", "organization", "organizations"],
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
