/**
 * WHICH TEXTS THE DAY SENDS BY ITSELF — the allow-list behind "Auto · Delivered".
 *
 * Firia's gate 4: that label appears on templated follow-ups and on nothing else. Never on text a
 * person approved, and never on text a person wrote. The label is a claim about *who sent this*,
 * and a screen that put it under an approved reply would be telling a coordinator the assistant
 * had sent something on its own authority when a person had in fact signed it.
 *
 * So the list is an allow-list and not a negation. An unknown template id is **not** auto — a new
 * template is a decision somebody has to make about this line, rather than something that quietly
 * inherits the friendlier label.
 *
 * The three families here are the §8 notice (`pickup.eta`, `dropoff.eta`, `dropoff.late`) and the
 * one fixed-copy inbound answer (MSG-04's `consent.help`). The three templates that say a decision
 * was made — `leg.canceled`, `leg.changed`, `dropoff.changed`, which `run/exec/followup.ts` calls
 * `DECISION_TEMPLATES` — are deliberately absent, and `auto-sends.test.ts` asserts the two sets do
 * not overlap and that every family template is in exactly one of them.
 */
import { HELP_REPLY_TEMPLATE } from "@/modules/messaging/templates";

/** The templates the day sends with no person in the loop. */
export const AUTO_SEND_TEMPLATES: ReadonlySet<string> = new Set([
  "pickup.eta",
  "dropoff.eta",
  "dropoff.late",
  HELP_REPLY_TEMPLATE,
]);

/** Was this text one the day sent by itself? `null`/unknown is never auto (see the header). */
export function isAutoSend(templateId: string | null | undefined): boolean {
  return templateId !== null && templateId !== undefined && AUTO_SEND_TEMPLATES.has(templateId);
}
