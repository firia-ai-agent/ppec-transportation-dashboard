/**
 * THE AFTERNOON'S HANDOFF TEXTS — the families the day has already finished with.
 *
 * Firia, 2026-10-17 10:51 PM ET: "The mockup's 5 threads, from demo fixture data
 * (src/modules/demo/fixtures), synthetic numbers only, not hardcoded UI." Two of those five are
 * the afternoon's late texts (`late-dropoff.ts`) and one is the change a parent asked for
 * (`change-request.ts`). These are the rest: the families whose child was **received** at their
 * stop, which is the other thing that happens to a family on a demo afternoon.
 *
 * ## It is a recorded custody event, never a geofence
 *
 * The fact behind every row here is `FINISHED_DAY_RIDES[child/PM].receivedBy` — the adult on file
 * took the child (`ADULT_ON_FILE`). PRD SURF-01 and COPY-GUIDE §2 are explicit that a van
 * *arriving* is not a child being *received*, so the two rides the fixtures record as arrived
 * with no handoff (C2's AT-13, C6's AT-10) send nothing and appear here as nothing. A thread that
 * said "off the van" for either of them would be the one lie this screen must never tell.
 *
 * Nothing is invented. The children, the guardians, the stops and the outcomes are all read out
 * of `fixtures/standard.ts`; the words are `outboundSms.bodies["dropoff.received"]` through the
 * one renderer; the phone numbers are the sim personas (MOCKS §3), which are synthetic by
 * construction. There is no string on a screen here that is not a fixture or copy.
 */
import { demoDay, type ServiceDay } from "@/domain/board/day";
import { renderTemplate } from "@/modules/messaging/templates";
import {
  CHILDREN,
  FAMILIES,
  FINISHED_DAY_RIDES,
  RUNS,
  VEHICLES,
  stopByKey,
  type Child,
} from "./fixtures/standard";

/** The template every row here is rendered from: a place, and no time left to estimate. */
export const HANDOFF_TEMPLATE = "dropoff.received";

/** One family's handoff text, in the shape the Family texts list and thread read. */
export type HandoffNotice = {
  readonly childKey: string;
  readonly childLabel: string;
  readonly childFirstName: string;
  readonly guardianName: string;
  readonly guardianFirstName: string;
  readonly relationship: string;
  /** The family's sim persona number (MOCKS §3). Synthetic by construction. */
  readonly phone: string;
  /** The public landmark the child was set down at (MOCKS §1), never a home. */
  readonly stopPlace: string;
  readonly vanLabel: string;
  /** When the text went out, epoch ms on the scenario clock. */
  readonly atMs: number;
  readonly templateId: string;
  readonly body: string;
};

/**
 * How long after the day's own instant a handoff text is stamped.
 *
 * The finished-day record says a handoff happened; it does not say at which minute, and this
 * screen needs the thread in time order. One step per child, backwards from the day's clock, so
 * the list reads newest-first and two rows never share a minute. It is a stamp on a demo text,
 * not a claim about when anybody was handed over — nothing is derived from it.
 */
const STEP_MS = 7 * 60 * 1000;

/**
 * The families the afternoon has finished with, newest first.
 *
 * `limit` is how many the screen has room for: the list is the day's five threads, and the other
 * three come from the late texts and the change request.
 */
export function demoHandoffNotices(
  day: ServiceDay = demoDay(),
  limit = 2,
  exclude: readonly string[] = [],
): readonly HandoffNotice[] {
  const received = FINISHED_DAY_RIDES.filter(
    (ride) => ride.direction === "PM" && ride.receivedBy === "ADULT_ON_FILE",
  );

  const notices: HandoffNotice[] = [];
  for (const ride of received) {
    if (notices.length === limit) break;
    if (exclude.includes(ride.childKey)) continue;
    const child = CHILDREN.find((c) => c.key === ride.childKey);
    if (!child || child.stopKey === null) continue;
    const notice = noticeFor(child, day, notices.length);
    if (notice) notices.push(notice);
  }
  return notices;
}

function noticeFor(child: Child, day: ServiceDay, index: number): HandoffNotice | null {
  const family = FAMILIES.find((f) => f.key === child.familyKey);
  const stop = child.stopKey ? stopByKey(child.stopKey) : null;
  const run = RUNS.find((r) => r.childKeys.includes(child.key));
  const vehicle = VEHICLES.find((v) => v.key === run?.vehicleKey);
  if (!family || !stop || !vehicle) return null;

  const { guardian } = family;
  return {
    childKey: child.key,
    childLabel: child.label,
    childFirstName: child.firstName,
    guardianName: `${guardian.firstName} ${guardian.lastInitial}.`,
    guardianFirstName: guardian.firstName,
    relationship: guardian.relationship,
    phone: guardian.phone,
    stopPlace: stop.label,
    vanLabel: vehicle.label,
    atMs: day.instantMs - (index + 1) * STEP_MS,
    templateId: HANDOFF_TEMPLATE,
    /*
     * Through the one renderer, with the child named from their own row and no STOP/HELP footer:
     * this is what a staff screen shows (Firia, 10:51 PM ET). The send path renders the same
     * words with the footer on them.
     */
    body: renderTemplate(
      HANDOFF_TEMPLATE,
      { stopLabel: stop.smsToken },
      { child: child.label },
    ),
  };
}
