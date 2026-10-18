/**
 * MAY THIS CHILD GO IN THIS VAN — one exported answer, for the three places that ask.
 *
 * SOURCE: redesign spec §1.4 (the fit rule), Firia's rule 2 of 2026-10-17 5:48 PM ET ("ONE pure
 * function … places every child and computes every shortfall"), and the S1 bug of 2026-10-18:
 * a card that bounced out of a van with no reason anywhere on the screen.
 *
 * The board had three call sites for the same question and each wrote the call out itself — the
 * pre-check while a card is held, the check at the drop, and Auto-plan — so "does Van 1 take Zoe
 * B." was three expressions that *happened* to agree. This is that question as a function of the
 * day and the plan, so there is one expression and the agreement is a fact rather than a habit:
 *
 *  - the board's pre-check, which rings or dims every column while a card is lifted;
 *  - the board's drop, which either lands the card or leaves it where it was with a reason;
 *  - Auto-plan and the save endpoint, through `placeRiders` / `checkPlan`, which ask
 *    {@link rejectReason} — the counter arithmetic this module resolves a day's van and child
 *    against and then delegates to, so there is no second arithmetic to disagree with.
 *
 * `src/domain/plan/eligibility.test.ts` holds that last sentence as a cross product: every
 * seeded child against every van, on an empty day and on a part-planned one.
 *
 * Pure: no clock, no database, no network, no copy. The reason it returns is a key
 * (src/config/equipment.ts `RejectReason`); the words for it are in src/ui/copy.ts and are built
 * by src/app/plan-routes/board/lines.ts.
 */
import type { RejectReason } from "@/config/equipment";
import { rejectReason } from "./fit";
import { ridersInVan, type BoardDay, type BoardPlan } from "./board";

/** The answer: yes, or no and the one thing that is missing. */
export type Eligibility = { ok: true } | { ok: false; reason: RejectReason };

const ALLOWED: Eligibility = { ok: true };

/**
 * May this child be put in this van, on top of whoever is in it already?
 *
 * `vanId` is `null` for "out of every van", which is the one move that is always allowed: a
 * child in no van takes nothing from anybody.
 *
 * Two inputs the board can hand over that are not a placement decision at all, and both are
 * allowed rather than refused, because a refusal has to name something a coordinator can act on:
 * a child who is not a rider on this leg (a family-drives child has no ride of ours to fit), and
 * a van this day does not have — the caller resolves the van before it has a name to put in a
 * refusal, so a drop on a target that is not on the board moves nobody and says nothing
 * (src/app/plan-routes/board/drop.ts).
 */
export function eligibility(
  day: BoardDay,
  plan: BoardPlan,
  childToken: string,
  vanId: string | null,
): Eligibility {
  if (vanId === null) return ALLOWED;
  const van = day.vans.find((candidate) => candidate.id === vanId);
  const rider = day.riders.find((candidate) => candidate.token === childToken);
  if (!van || !rider) return ALLOWED;
  /*
   * The riders already in the van, in the van's own drive order, plus this child — which is
   * exactly what `placeRiders` asks of each van it considers, and what the save endpoint replays
   * on the server. A child already in this van is not counted twice (fit.ts).
   */
  const reason = rejectReason(van.setup, ridersInVan(day, plan, van.id), rider);
  return reason ? { ok: false, reason } : ALLOWED;
}
