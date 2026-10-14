/**
 * Outbound SMS bodies (COPY-GUIDE §1 voice, §5 "Outbound family SMS", §6 "[DEMO]" suffix).
 * Callers never pass free text: the outbox carries a template id plus allowlisted vars
 * (outbox TEMPLATE_VARS), and this is the only place those become words.
 *
 * Rules enforced here and checked by tests:
 *  - every template in TEMPLATE_VARS has a body, and every placeholder is an allowlisted var for it;
 *  - no ticket codes, enum names or internal jargon in user-facing text (COPY-GUIDE §2);
 *  - every body ends with the "[DEMO]" suffix, so a simulated message is never mistaken for a real one;
 *  - family-facing bodies carry the opt-out sentence (10DLC HELP/STOP reply requirement, PRD §17 D-04).
 */
import { TEMPLATE_VARS } from "@/modules/outbox/outbox";

export class TemplateRenderError extends Error {}

const DEMO = "[DEMO]";
const OPT_OUT = "Reply HELP for help, STOP to opt out.";
/** The center's number as the copy guide writes it (COPY-GUIDE §5 dispatcher link). */
const CENTER_PHONE_DISPLAY = "(561) 555-0100";

/** Fixed HELP answer. Same words every time, no ticket codes, no child or ride detail. */
export const HELP_REPLY_TEMPLATE = "consent.help";
export const HELP_REPLY_BODY =
  `PPEC: This number sends ride updates for your child. Call us at ${CENTER_PHONE_DISPLAY} if you need help. Reply STOP to opt out. ${DEMO}`;

const BODIES: Readonly<Record<string, string>> = {
  "pickup.eta": `PPEC: {childFirstName}'s ride is on the way to {stopLabel}. Pickup window {eta}. ${OPT_OUT} ${DEMO}`,
  "dropoff.eta": `PPEC: {childFirstName}'s ride home is on the way to {stopLabel}. Arrival window {eta}. ${OPT_OUT} ${DEMO}`,
  "leg.canceled": `PPEC: Got it. {childFirstName}'s ride on {legDate} is canceled. {reason} ${OPT_OUT} ${DEMO}`,
  "leg.changed": `PPEC: {childFirstName}'s ride on {legDate} changed. New pickup window {eta} at {stopLabel}. ${OPT_OUT} ${DEMO}`,
  "therapist.absence_alert": `PPEC: {childFirstName} is not coming in today. The {sessionStart} session is affected. ${OPT_OUT} ${DEMO}`,
  "therapist.late_alert": `PPEC: {childFirstName} is running late for the {sessionStart} session. Now expected {eta}. ${OPT_OUT} ${DEMO}`,
  "child.not_received": `PPEC: We could not hand off {childFirstName} at {stopLabel} at {eta}. Please call us at ${CENTER_PHONE_DISPLAY}. ${DEMO}`,
  "center.closure": `PPEC: The center is closed on {date}. {reason} ${OPT_OUT} ${DEMO}`,
  "generic.notice": `PPEC: {text} ${OPT_OUT} ${DEMO}`,
  [HELP_REPLY_TEMPLATE]: HELP_REPLY_BODY,
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
 * Render one body. An unknown template or a missing var is a definite refusal, not a retryable error:
 * the provider turns it into ProviderRejected so the message ends FAILED instead of UNKNOWN.
 */
export function renderTemplate(templateId: string, vars: Record<string, unknown>): string {
  const body = BODIES[templateId];
  if (!body) throw new TemplateRenderError(`no body for template ${templateId}`);
  const allowed = TEMPLATE_VARS[templateId];
  const bad = Object.keys(vars).filter((k) => !allowed?.has(k));
  if (bad.length) throw new TemplateRenderError(`vars not permitted for template ${templateId}: ${bad.join(",")}`);
  return body.replace(PLACEHOLDER, (_m, name: string) => {
    const v = vars[name];
    if (v === undefined || v === null || String(v) === "") throw new TemplateRenderError(`template ${templateId} needs var ${name}`);
    return String(v);
  });
}
