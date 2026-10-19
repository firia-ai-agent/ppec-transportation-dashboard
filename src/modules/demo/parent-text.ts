/**
 * "SIMULATE PARENT TEXT" (ledger #78): a parent texts that they won't be home at their child's
 * estimated drop-off, and asks for a later time — built from the day, sent through the real inbound
 * path (`inbound-script.ts`), so the agent hears it the way it hears any text.
 *
 * Nothing in it is fixed: the child is the one asked for, or the next estimated drop-off still
 * ahead this afternoon (the earliest, once they have all passed); the time is that child's
 * estimate on the saved plan, forward from their van's departure (`plannedStopTimes`); the later
 * time is `parentTextConfig`'s; the words are `familyTexts.parentCantReceive`; the sender is that
 * child's guardian, by the demo fixtures' synthetic number. Change a departure or a placement and
 * the text changes with it.
 *
 * Demo and synthetic data only: the caller gates it (`simulate-actions.ts`).
 */
import type { Db } from "@/db/exec";
import { parentTextConfig } from "@/config/live";
import { hhmmOf, plannedStopTimes } from "@/domain/plan/arrivals";
import type { DayDataSource } from "@/domain/day/source";
import { loadBoard } from "@/modules/plan/store";
import type { PlanStore } from "@/modules/plan/types";
import { demoTokenForId } from "@/modules/agent/run/scope-tokens";
import { familyTexts, fill } from "@/ui/copy";
import { clockLabel, serviceDateIso, siteMinuteOfDay } from "@/ui/service-date";
import { childByKey, familyByKey } from "./fixtures/standard";
import { sendSimulatedInbound, type SimulatedInboundDeps } from "./inbound-script";

export type ParentTextRequest = {
  readonly siteId: string;
  /** A fixture child key ("C2"); none means the next drop-off still ahead. */
  readonly childKey?: string | null;
  /** The children the screen can open a thread for; none means any rider. */
  readonly among?: readonly string[];
};

export type ParentTextResult =
  | { readonly sent: true; readonly childKey: string; readonly text: string }
  | { readonly sent: false; readonly reason: "NO_PLAN" | "NO_RIDER" | "NOT_SENT"; readonly detail?: string };

/** Minutes, rounded up to a step: 15:42 + 30 → 16:15 on a five-minute step. */
const roundUp = (minute: number, step: number) => Math.ceil(minute / step) * step;

export async function simulateParentText(
  db: Db,
  deps: SimulatedInboundDeps & { readonly store: PlanStore; readonly source: DayDataSource },
  req: ParentTextRequest,
): Promise<ParentTextResult> {
  const view = await loadBoard(deps.store, req.siteId, serviceDateIso(deps.now), "PM", deps.source);
  if (view.version === 0) return { sent: false, reason: "NO_PLAN" };
  const times = plannedStopTimes(view.day, view.plan, view.departs);
  const riders = view.day.riders
    .map((r) => ({ rider: r, key: demoTokenForId(r.token), at: times.get(r.token)?.arrivesAtMinute }))
    .filter((r): r is { rider: typeof r.rider; key: string; at: number } => r.key !== null && r.at !== undefined)
    .filter((r) => !req.among || req.among.includes(r.key))
    .sort((a, b) => a.at - b.at);
  const now = siteMinuteOfDay(deps.now);
  const pick = req.childKey
    ? riders.find((r) => r.key === req.childKey)
    : (riders.find((r) => r.at >= now) ?? riders[0]);
  if (!pick) return { sent: false, reason: "NO_RIDER" };

  const child = childByKey(pick.key);
  const eta = Math.round(pick.at);
  const text = fill(familyTexts.parentCantReceive, {
    eta: clockLabel(hhmmOf(eta)),
    child: child.firstName,
    later: clockLabel(hhmmOf(roundUp(eta + parentTextConfig.laterByMinutes, parentTextConfig.roundToMinutes))),
  });
  const sent = await sendSimulatedInbound(db, deps, {
    // One text per press: a press is a new message, never the webhook's duplicate of an earlier one.
    sid: `SIMPARENT-${view.day.date}-${pick.key}-${deps.now.getTime()}`,
    from: familyByKey(child.familyKey).guardian.phone,
    body: text,
  });
  return sent.sent ? { sent: true, childKey: pick.key, text } : { sent: false, reason: "NOT_SENT", detail: sent.reason };
}
