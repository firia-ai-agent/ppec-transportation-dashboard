/**
 * WHAT A DROP DOES — the board's one answer to "the card was let go here".
 *
 * SOURCE: redesign spec §1.3 (the dragging and rejection states), Firia's option A (a drag is a
 * draft), and Vera's taste spec of 2026-10-18 after the S1 bug.
 *
 * Three outcomes and no fourth, which is the whole point: a drop **lands**, or it is **refused**
 * and the card stays exactly where it was with a reason on it, or there is **nothing** to do.
 * What the board used to have instead was one path with a `null` van falling through a chain of
 * `else`s to "Unassigned", so a drop on a target the day did not have, or a refusal that was not
 * checked, both ended as the cheerful success toast "Zoe B. → Unassigned" — the S1 report. A
 * card is never moved to Unassigned by anything but a drop on the Unassigned column.
 *
 * It is a function rather than four branches inside an event handler because these are the
 * assertions the screen is worth testing for and a browser is a slow way to make them:
 * src/app/plan-routes/board/drop.test.ts.
 *
 * Pure: the day, the plan and the drop in; what to do out. No state, no fetch, no React.
 */
import type { RejectReason } from "@/config/equipment";
import { eligibility } from "@/domain/plan/eligibility";
import type { Bucket, BoardDay, BoardPlan } from "@/domain/plan/board";
import { planBoard } from "@/ui/copy";
import { movedLine, rejectCardLine, rejectSr } from "./lines";

export type DropOutcome =
  /** The move to queue, the toast it leaves behind, and the sentence to announce. */
  | { kind: "MOVE"; bucket: Bucket; vanId: string | null; toast: string; announce: string }
  /**
   * The van said no. The card does not move, there is **no toast** (Vera: a refusal belongs on
   * the card), and the refusal is both a line on the card and an announced sentence.
   */
  | { kind: "REFUSED"; vanId: string; reason: RejectReason; line: string; announce: string }
  /** Nothing to move and nothing to say: a child or a target this day does not have. */
  | { kind: "NOTHING" };

const NOTHING: DropOutcome = { kind: "NOTHING" };

/**
 * One child let go on one target.
 *
 * `vanId` is the van for a `VAN` drop and `null` for every other bucket, which is what the
 * database checks too (migration 0009).
 */
export function dropOutcome(
  day: BoardDay,
  plan: BoardPlan,
  childToken: string,
  bucket: Bucket,
  vanId: string | null,
): DropOutcome {
  const rider = day.riders.find((candidate) => candidate.token === childToken);
  const other = day.others.find((candidate) => candidate.token === childToken);
  if (!rider && !other) return NOTHING;
  const name = rider?.name ?? other?.name ?? "";

  if (bucket === "VAN") {
    const van = vanId ? day.vans.find((candidate) => candidate.id === vanId) : null;
    // A target the board is not drawing. Nothing is moved and nothing is claimed: there is no
    // van here to name in a refusal and no van here to move anybody into.
    if (!van) return NOTHING;
    const verdict = eligibility(day, plan, childToken, van.id);
    if (!verdict.ok) {
      return {
        kind: "REFUSED",
        vanId: van.id,
        reason: verdict.reason,
        line: rejectCardLine(van.name, verdict.reason),
        announce: rejectSr(name, van.name, verdict.reason),
      };
    }
    return { kind: "MOVE", bucket, vanId: van.id, ...said(name, van.name) };
  }

  // Out of every van, or onto one of the two groups. Nothing to fit, so nothing to refuse — and
  // each of them says its own name rather than falling through to "Unassigned".
  return { kind: "MOVE", bucket, vanId: null, ...said(name, bucketLabel(bucket)) };
}

/** The group a drop landed on, in its own words (§1.5). */
function bucketLabel(bucket: Bucket): string {
  switch (bucket) {
    case "ABSENT":
      return planBoard.absent;
    case "FAMILY_DRIVES":
      return planBoard.familyDrives;
    default:
      return planBoard.unassigned;
  }
}

/** "Mia R. → Van 2", once for the eye and once for the ear. */
function said(child: string, where: string): { toast: string; announce: string } {
  const line = movedLine(child, where);
  return { toast: line, announce: line };
}
