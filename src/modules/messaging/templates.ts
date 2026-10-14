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
 * Rules enforced here and checked by tests:
 *  - every template in TEMPLATE_VARS has a body, and every placeholder is an allowlisted var for it;
 *  - no ticket codes, enum names or internal jargon in user-facing text (COPY-GUIDE §2);
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
const { demoTag, optOut, centerPhone } = outboundSms;
const FIXED = { demoTag, optOut, centerPhone };

/** Fixed HELP answer. Same words every time, no ticket codes, no child or ride detail. */
export const HELP_REPLY_TEMPLATE = "consent.help";
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

/** YYYY-MM-DD as a family reads it ("October 14"). Text only, for the same TZ reason as timeOfDay. */
function calendarDay(value: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  const month = m ? MONTHS[Number(m[2]) - 1] : undefined;
  return m && month ? `${month} ${Number(m[3])}` : null;
}

/**
 * Per-var-name display rule: how an allowlisted value becomes words. A name with no entry renders
 * as itself (childFirstName, stopLabel). Returning null is a refusal — the value passed its
 * TEMPLATE_VARS rule but this module cannot word it, and a raw code must never reach a family.
 */
const FORMAT: Readonly<Record<string, (value: string, templateId: string) => string | null>> = {
  eta: timeOfDay,
  sessionStart: timeOfDay,
  legDate: calendarDay,
  date: calendarDay,
  reasonCode: (value, templateId) => REASON_COPY[templateId]?.[value] ?? null,
};

const PLACEHOLDER = /\{(\w+)\}/g;

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
export function renderTemplate(templateId: string, vars: Record<string, unknown>): string {
  const body = BODIES[templateId];
  if (!body) throw new TemplateRenderError(`no body for template ${templateId}`);
  if (!TEMPLATE_VARS[templateId]) throw new TemplateRenderError(`no vars allowlist for template ${templateId}`);
  const bad = disallowedVars(templateId, vars);
  if (bad.length) throw new TemplateRenderError(`vars not permitted for template ${templateId}: ${bad.join(",")}`);
  return body.replace(PLACEHOLDER, (_m, name: string) => {
    const v = vars[name];
    if (v === undefined || v === null || String(v) === "") throw new TemplateRenderError(`template ${templateId} needs var ${name}`);
    const worded = FORMAT[name] ? FORMAT[name](String(v), templateId) : String(v);
    if (worded === null) throw new TemplateRenderError(`template ${templateId} has no copy for var ${name}`);
    return worded;
  });
}
