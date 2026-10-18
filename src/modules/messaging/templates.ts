/**
 * Outbound SMS bodies (COPY-GUIDE §1 voice, §5 "Outbound family SMS", §6 "[DEMO]" suffix).
 * Callers never pass free text: the outbox carries a template id plus allowlisted vars
 * (outbox TEMPLATE_VARS), and this is the only place those become words.
 *
 * Since Veri #12 (outbox.ts) the vars are not only name-checked but value-checked: a reason is a
 * fixed code, a time is HH:MM or an ISO timestamp, a date is YYYY-MM-DD, a stop is a short token.
 * Those are developer-facing shapes, and COPY-GUIDE §2 bans enum names and internal jargon from
 * family text, so this module owns the one translation from code to words — see FORMAT below.
 *
 * Two of those translations are what a family actually reads the message for:
 *  - the stop. `stopLabel` stays a short token in the vars (the outbox rule is unchanged), and it is
 *    resolved here through the fixed, code-owned table in copy.ts (`outboundSms.stops`) — public
 *    landmark names (MOCKS §1), never a home. A token with no entry becomes "your usual stop"; a raw
 *    token never reaches a family, which is the point of resolving it at render time rather than
 *    letting a place name into the vars.
 *  - the time. `eta` plus the optional `etaEnd` (the same clock-time rule, a second constrained value,
 *    not free text) render as a window — "Pickup 8:12–8:22 AM" — which is what COPY-GUIDE §3 asks for
 *    and what the copy lead needs; with only `eta`, the word "around" says it is a point estimate.
 *
 * Rules enforced here and checked by tests:
 *  - no child's name reaches a body. No outbound var carries one (outbox TEMPLATE_VARS), the bodies say
 *    "your child" / "a child", and a placeholder with no display rule below is refused rather than
 *    rendered raw — so there is no path for a seeded or staff-typed name into a family's SMS;
 *  - every template in TEMPLATE_VARS has a body, and every placeholder is an allowlisted var for it;
 *  - no ticket codes, enum names, stop tokens or internal jargon in user-facing text (COPY-GUIDE §2);
 *  - every body ends with the "[DEMO]" suffix, so a simulated message is never mistaken for a real one;
 *  - family-facing bodies carry the opt-out sentence (10DLC HELP/STOP reply requirement, PRD §17 D-04);
 *  - a var whose value breaks its TEMPLATE_VARS rule is refused, not rendered (defence in depth: the
 *    outbox already rejects it at enqueue and blocks it at send).
 */
import { disallowedVars, TEMPLATE_VARS } from "@/modules/outbox/outbox";
import { fill, outboundSms } from "@/ui/copy";

export class TemplateRenderError extends Error {}

/**
 * The words themselves live in src/ui/copy.ts (`outboundSms`), with the rest of the app's copy;
 * what this module adds is the rendering. The fixed parts are folded into every body once here,
 * so a body arrives at `renderTemplate` holding only the caller's own vars.
 */
const HELP_REPLY_TEMPLATE_ID = "consent.help";

const { demoTag, optOut, centerPhone } = outboundSms;
const FIXED = { demoTag, optOut, centerPhone };

/**
 * The same bodies without the channel's furniture — the opt-out sentence and the `[DEMO]` tag.
 *
 * For the two staff surfaces that show a family's words back to a person: the proposal card a
 * coordinator approves, and the thread bubbles. Firia, 2026-10-17 10:51 PM ET — "the STOP/HELP
 * footer is appended in the SEND PIPELINE, never shown in the bubble or the card", and "remove
 * the [DEMO] tag from bubbles". Both still go out on every real send, because the send renders
 * from `BODIES` below and this map is not reachable from it.
 */
const SCREEN_BODIES: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries({ ...outboundSms.bodies, [HELP_REPLY_TEMPLATE_ID]: outboundSms.helpReply }).map(
    ([id, body]) => [id, fill(body, { ...FIXED, optOut: "", demoTag: "" }).replace(/\s+/g, " ").trim()],
  ),
);

/** Fixed HELP answer. Same words every time, no ticket codes, no child name and no van detail. */
export const HELP_REPLY_TEMPLATE = HELP_REPLY_TEMPLATE_ID;
export const HELP_REPLY_BODY = fill(outboundSms.helpReply, FIXED);

const BODIES: Readonly<Record<string, string>> = {
  ...Object.fromEntries(Object.entries(outboundSms.bodies).map(([id, body]) => [id, fill(body, FIXED)])),
  [HELP_REPLY_TEMPLATE]: HELP_REPLY_BODY,
};

/**
 * The sentence a `reasonCode` becomes, per template (copy in `outboundSms.reasons`). The codes are
 * the outbox's LEG_CANCEL_REASON_CODES and CLOSURE_REASON_CODES, and WEATHER appears in both. A code
 * with no sentence is a refusal rather than a raw code in a family's SMS, and the tests check that
 * every code in each set has one.
 */
const REASON_COPY: Readonly<Record<string, Readonly<Record<string, string>>>> = outboundSms.reasons;

/**
 * The public place each stop token names (copy in `outboundSms.stops`). Fixed and code-owned: the
 * only names a message can carry are the ones written here, so resolving a token adds no path for
 * staff text to reach a family.
 */
const STOP_NAMES: Readonly<Record<string, string>> = outboundSms.stops;

/** What an unrecognised token becomes. Never the token itself (COPY-GUIDE §2). */
export const UNKNOWN_STOP = outboundSms.unknownStop;

/**
 * The stop tokens that have a place name, longest-lived first — the only ones a *proposal* may
 * name (`tools.propose_dropoff_change`).
 *
 * The outbox's own `stopToken` rule is a shape check, so a token with no entry in the table above
 * renders as "your usual stop": vague, safe, and exactly right for a message about a stop the plan
 * already holds. A proposal is the other case. A coordinator is being asked to approve a text that
 * tells a family where their child will be set down, and "your usual stop" is not an answer to
 * that question — so the tool takes one of these and nothing else, and the parent's text names a
 * real place. Derived from the table, so adding a stop to the copy adds it here.
 */
export const KNOWN_STOP_TOKENS: readonly string[] = Object.keys(STOP_NAMES);

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/**
 * HH:MM as a family reads it ("8:12 AM"). The hour and minute are taken from the *text* — the HH:MM
 * form, or the time part of an ISO timestamp — and never through `Date`, so the words do not change
 * with the server's TZ. An ISO timestamp therefore renders the wall clock it was written in, which
 * is the local time the planner meant.
 */
function timeOfDay(value: string): string | null {
  const m = /^(?:\d{4}-\d{2}-\d{2}T)?(\d{2}):(\d{2})/.exec(value);
  if (!m) return null;
  const h = Number(m[1]);
  return `${h % 12 === 0 ? 12 : h % 12}:${m[2]} ${h < 12 ? "AM" : "PM"}`;
}

/** Minutes past midnight, read from the same text as timeOfDay (and so just as TZ-safe). */
function minutesOfDay(value: string): number | null {
  const m = /^(?:\d{4}-\d{2}-\d{2}T)?(\d{2}):(\d{2})/.exec(value);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/**
 * A window as COPY-GUIDE §3 writes one: "8:12–8:22 AM" — the AM/PM is said once when both ends
 * share it, and twice when they do not ("11:50 AM–12:10 PM").
 */
function timeWindow(start: string, end: string): string | null {
  const [a, b] = [timeOfDay(start), timeOfDay(end)];
  if (!a || !b) return null;
  const sameHalf = a.slice(-2) === b.slice(-2);
  return fill(outboundSms.etaWindow, { start: sameHalf ? a.slice(0, -3) : a, end: b });
}

/**
 * How an `eta` reads. On the templates that permit `etaEnd` it is an estimate, so a window is
 * rendered when both ends are present and the single time is hedged ("around 8:15 AM") when only one
 * is; on the templates with no `etaEnd` var the time is a recorded fact ("at 8:12 AM"), not a guess.
 *
 * An end before the start is a refusal, not a reversed window in a family's SMS — the values each
 * passed their own rule, but together they say nothing true. An end equal to the start is a window of
 * no width, which is simply the one time.
 */
function etaPhrase(value: string, templateId: string, vars: Record<string, unknown>): string | null {
  const start = timeOfDay(value);
  if (!start) return null;
  if (!Object.hasOwn(TEMPLATE_VARS[templateId] ?? {}, "etaEnd")) return start;
  const end = vars.etaEnd;
  if (end === undefined || end === null || String(end) === "") return fill(outboundSms.etaApprox, { time: start });
  const [from, to] = [minutesOfDay(value), minutesOfDay(String(end))];
  if (from === null || to === null || to < from) return null;
  return to === from ? fill(outboundSms.etaApprox, { time: start }) : timeWindow(value, String(end));
}

/** YYYY-MM-DD as a family reads it ("October 14"). Text only, for the same TZ reason as timeOfDay. */
function calendarDay(value: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  const month = m ? MONTHS[Number(m[2]) - 1] : undefined;
  return m && month ? `${month} ${Number(m[3])}` : null;
}

/**
 * Per-var-name display rule: how an allowlisted value becomes words. Every placeholder a body
 * carries has an entry, and since no var carries a child's name any more there is nothing left
 * that renders as itself: a placeholder with no rule here is a refusal (renderTemplate), because
 * the alternative is a developer-facing value — a code, a token, a 24h clock — reaching a family.
 *
 * Returning null is the other refusal — the value passed its TEMPLATE_VARS rule but this module
 * cannot word it (a reason code with no sentence, a window that runs backwards).
 *
 * `etaEnd` has no entry of its own: it is not a placeholder in any body, it is read by the `eta`
 * rule to widen that one time into a window.
 */
const FORMAT: Readonly<Record<string, (value: string, templateId: string, vars: Record<string, unknown>) => string | null>> = {
  eta: etaPhrase,
  sessionStart: timeOfDay,
  legDate: calendarDay,
  date: calendarDay,
  reasonCode: (value, templateId) => REASON_COPY[templateId]?.[value] ?? null,
  stopLabel: (value) => STOP_NAMES[value] ?? UNKNOWN_STOP,
  // Minutes as digits, already bounded to 1–240 by the var rule. Nothing to word: "about 15
  // minutes late" is the body's sentence, and this is the number in it.
  delayMinutes: (value) => (/^\d{1,3}$/.test(value) ? value : null),
};

const PLACEHOLDER = /\{(\w+)\}/g;

/**
 * How a body is being rendered, as against *what* it says — which is the vars.
 *
 * Neither field is a var, and that is the whole point of their being here: the outbox's
 * allowlist (Veri #12, `TEMPLATE_VARS`) still refuses every name and every sentence anybody could
 * type, and these two are the server's own answers to "whose ride is this" and "is this going out
 * or being read back by the person approving it".
 */
export type RenderFor = {
  /**
   * The child's name as their own row holds it ("Noah O."), from which the body uses the given
   * name alone. Null or absent renders `outboundSms.yourChild` — the wording every body carried
   * before Firia's 10:51 PM ET ruling — so a row that could not be read is still a sendable text.
   */
  readonly child?: string | null;
  /**
   * `false` on the two staff surfaces: the proposal card and the thread bubbles, where the
   * opt-out sentence and the `[DEMO]` tag are the channel's furniture and not the message
   * (10:51 PM ET). Every send leaves it alone and carries both.
   */
  readonly footer?: boolean;
};

/**
 * "Noah O." → "Noah". The display name's first word, which is the given name on every row this
 * app writes (`synLegalName`, and the seeded `display_name`).
 */
function givenName(displayName: string | null | undefined): string | null {
  const first = (displayName ?? "").trim().split(/\s+/)[0];
  return first ? first : null;
}

/** Var names a body needs, for the TEMPLATE_VARS agreement test. */
export function templatePlaceholders(templateId: string): string[] {
  const body = BODIES[templateId];
  return body ? [...new Set([...body.matchAll(PLACEHOLDER)].map((m) => m[1]))] : [];
}

export function knownTemplates(): string[] {
  return Object.keys(BODIES);
}

/**
 * Render one body. An unknown template, a var the template does not permit, a value that breaks its
 * rule, a missing var and a code with no copy are all definite refusals, not retryable errors: the
 * provider turns them into ProviderRejected so the message ends FAILED instead of UNKNOWN.
 *
 * A rejected var is named but never echoed, same as outbox.disallowedVars: the reason it was
 * rejected is that it may carry a child's name.
 */
export function renderTemplate(
  templateId: string,
  vars: Record<string, unknown>,
  how: RenderFor = {},
): string {
  const body = (how.footer === false ? SCREEN_BODIES : BODIES)[templateId];
  if (!body) throw new TemplateRenderError(`no body for template ${templateId}`);
  if (!TEMPLATE_VARS[templateId]) throw new TemplateRenderError(`no vars allowlist for template ${templateId}`);
  const bad = disallowedVars(templateId, vars);
  if (bad.length) throw new TemplateRenderError(`vars not permitted for template ${templateId}: ${bad.join(",")}`);
  return body.replace(PLACEHOLDER, (_m, name: string) => {
    // The child's name is not a var and never will be (Veri #12): it is resolved here, from the
    // child's own row, the way `{stopLabel}` is resolved through a fixed table.
    if (name === "childName") return givenName(how.child) ?? outboundSms.yourChild;
    const v = vars[name];
    if (v === undefined || v === null || String(v) === "") throw new TemplateRenderError(`template ${templateId} needs var ${name}`);
    const rule = FORMAT[name];
    if (!rule) throw new TemplateRenderError(`template ${templateId} has no display rule for var ${name}`);
    const worded = rule(String(v), templateId, vars);
    if (worded === null) throw new TemplateRenderError(`template ${templateId} has no copy for var ${name}`);
    return worded;
  });
}
