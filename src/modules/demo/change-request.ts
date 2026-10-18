/**
 * The demo day's one family change request, and the proposal it produced (PRD §18.2 steps 9–10).
 *
 * `late-dropoff.ts` is the day's outbound half: a van loses time and the families still ahead of
 * it are told. This is what comes back. A parent reads that text and asks for something, and the
 * assistant drafts the reply a person has to approve before the family hears it — which is demo
 * goals 3 and 4, and the only part of the thread a coordinator actually decides.
 *
 * Pure and deterministic, like the texts it answers: no clock, no database, no network, no model
 * call. That is what lets the screen show the whole turn on a deployment with no `DATABASE_URL`
 * and on a laptop with no key — the same reason `demoLateDropoffs` exists.
 *
 * ## What is scripted, and what is computed
 *
 * The **parent's sentence** is scripted (`familyTexts.demoReply`) — a demo has to have something
 * for the assistant to read, and a fixture sentence is honest in a way an invented screenshot is
 * not. Everything else is computed from the day: who the family is and what they are called comes
 * off the fixtures, the ride and the stop come off the scenario's committed geometry, the time
 * they are asking for is the one the script asks for, and the **reply text is rendered through
 * `renderTemplate`** from the outbox's own `dropoff.changed` body — the same template, the same
 * renderer and the same words `decideApproval` would queue if a coordinator approved it.
 *
 * ## What it is not
 *
 * It is not a model call and it does not pretend to be one. A live turn is `demoAgentTurn`, and
 * what the *screen* does with the model being unreachable is show the "needs a person" staff
 * alert and no card at all (Firia's gate 5) — so the proposal here is only ever rendered on a
 * deployment where the assistant is configured. And nothing in this module reads the parent's
 * sentence for a time or a place: the change is the script's own fields, never parsed out of
 * prose, because the keyword reader is deleted and stays deleted (`no-keyword-fallback.test.ts`).
 */
import { demoDay, localTimeOn, type ServiceDay } from "@/domain/board/day";
import { formatClock, formatClock24 } from "@/domain/eta/eta";
import { demoId, KIND, familyByKey, runOfChild, VEHICLES, childByKey, stopByKey } from "@/modules/demo/fixtures/standard";
import { demoLateDropoffs, LATE_DIRECTION, type LateDropoff } from "@/modules/demo/late-dropoff";
import { renderTemplate } from "@/modules/messaging/templates";
import { fill, familyTexts } from "@/ui/copy";

/** The template an approved drop-off change is sent on — `followup.ts`'s decision template. */
export const CHANGE_TEMPLATE = "dropoff.changed";

/** How long after the day's text the family answers, and how long the draft takes. */
const REPLY_AFTER_MS = 6 * 60 * 1000;
const DRAFT_AFTER_MS = 7 * 60 * 1000;

/** The time the script asks for, as a 24-hour clock — the one field the proposal is about. */
const REQUESTED_HHMM = "17:00";

/**
 * One family's change request: what they sent, what the assistant drafted, and the two halves of
 * the change a coordinator reads before approving it.
 */
export type DemoChangeRequest = {
  /** Fixture child key — the `?thread=` value and the row this request belongs to. */
  readonly childKey: string;
  /** A deterministic id, so the same row the demo seed would write has the same name. */
  readonly approvalId: string;
  readonly childLabel: string;
  readonly childFirstName: string;
  readonly guardianName: string;
  readonly relationship: string;
  /** The family's own sentence, and when it arrived. */
  readonly askedAtMs: number;
  readonly parentText: string;
  /** When the assistant drafted the reply. */
  readonly draftedAtMs: number;
  /** The stop. Unchanged in this request, so there is one place and no arrow. */
  readonly stopPlace: string;
  /** The window the family holds now, and the single time they are asking for. */
  readonly timeFrom: string;
  readonly timeTo: string;
  /** The same time as a 24-hour clock, which is the only shape the Edit control takes. */
  readonly requestedHhmm: string;
  /** The template and vars the reply is rendered from — carried, never rebuilt. */
  readonly templateId: string;
  readonly vars: Readonly<Record<string, unknown>>;
  /** The exact words the family would get, through the outbox's own renderer. */
  readonly draftText: string;
  /** The van, by name, for the "same van" check. */
  readonly vanLabel: string;
};

/**
 * The day's change requests: one, from the family the late text reached last.
 *
 * Last on purpose. That family is the one whose drop-off is furthest away, so they are the only
 * one with time to ask for a different one — and they are the family the day's own text was
 * about, which is what makes the thread read as a conversation rather than two unrelated texts.
 */
export function demoChangeRequests(day: ServiceDay = demoDay()): readonly DemoChangeRequest[] {
  const texts = demoLateDropoffs(day);
  const last = texts[texts.length - 1];
  return last ? [requestFrom(last, day)] : [];
}

/** The request for one family, or none if the day did not text them. */
export function demoChangeRequestFor(
  childKey: string,
  day: ServiceDay = demoDay(),
): DemoChangeRequest | undefined {
  return demoChangeRequests(day).find((r) => r.childKey === childKey);
}

function requestFrom(text: LateDropoff, day: ServiceDay): DemoChangeRequest {
  const child = childByKey(text.childKey);
  const { guardian } = familyByKey(child.familyKey);
  const run = runOfChild(child.key);
  const vehicle = VEHICLES.find((v) => v.key === run?.vehicleKey);
  const stopToken = child.stopKey ? stopByKey(child.stopKey).smsToken : "";
  const vars = {
    legDate: day.iso,
    eta: REQUESTED_HHMM,
    stopLabel: stopToken,
  } as const;
  return {
    childKey: child.key,
    // The demo's own id space, so a seeded row and this projection are the same approval.
    approvalId: demoId(KIND.approvalRequest, 1),
    childLabel: child.label,
    childFirstName: child.firstName,
    guardianName: `${guardian.firstName} ${guardian.lastInitial}.`,
    relationship: guardian.relationship,
    askedAtMs: text.atMs + REPLY_AFTER_MS,
    parentText: fill(familyTexts.demoReply, { child: child.firstName }),
    draftedAtMs: text.atMs + DRAFT_AFTER_MS,
    stopPlace: text.stopPlace,
    timeFrom: text.windowText,
    timeTo: formatClock(localTimeOn(day, REQUESTED_HHMM)),
    requestedHhmm: REQUESTED_HHMM,
    templateId: CHANGE_TEMPLATE,
    vars,
    // A staff surface: the child's name in it and no STOP/HELP footer (Firia, 10:51 PM ET).
    draftText: renderTemplate(CHANGE_TEMPLATE, vars, { child: child.firstName }),
    vanLabel: vehicle?.label ?? text.vanLabel,
  };
}

/** The direction these requests are about: the afternoon, like the texts they answer. */
export const CHANGE_DIRECTION = LATE_DIRECTION;

/** Re-exported so a caller rendering the Edit control does not import the eta module for one call. */
export { formatClock24 };
