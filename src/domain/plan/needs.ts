/**
 * The four flags the board and the ramp fit a child by, read off that child's approved profile.
 *
 * SOURCE: redesign spec §6.4 ("child needs become 4 flags … through the view `child_need_flags`
 * over APPROVED `transport_need_item`s"), §0's equipment vocabulary, and DECISION-LEDGER row 1 /
 * PRD VEH-01: **fulfilment counts approved needs only**. A need a family has told us about but
 * no director has signed is on the child's record and is not planned against — it must not
 * change where a child rides, and it must not disappear either, which is why the derivation is
 * written down here rather than inferred at a call site.
 *
 * `mobility` is the one thing not read from a need item: it is a column on the approved transport
 * profile (`ops.transport_profile.mobility`) and is what "rides in their own chair" means.
 *
 * Deliberately *not* here: securement hardware and chair footprint (conflict C3), seating
 * separation and maximum ride time (C7). The founder deferred all four after the demo on
 * 2026-10-17 2:59 PM ET, so they stay on the profile and out of fit.
 *
 * Pure: fixtures in, flags out. No clock, no database, no network.
 */
import { NO_NEEDS, type NeedFlags } from "@/config/equipment";
import { CHILDREN, childByKey, type Child as DemoChild, type NeedCategory } from "@/modules/demo/fixtures/standard";

/**
 * Which approved need category sets which flag.
 *
 *  - `CAR_SEAT_OR_BOOSTER` and `HARNESS_OR_VEST` are one counter, because they are one thing a
 *    van carries: §0's child chip reads "needs car seat / booster / vest" and the van counter is
 *    "Car seats on board". This is also conflict C4's answer — car seats replace the LATCH-anchor
 *    checklist for the demo.
 *  - `ATTENDANT_ESCORT` is the nurse, and a nurse is one more seat taken (§1.4).
 *  - `MEDICAL_DEVICE_POWER` is the oxygen flag. The founder approved Oxygen as a counter on every
 *    van (2026-10-17 2:59 PM ET, conflict C8). In today's synthetic day the one child with such
 *    an item has it `REPORTED` and not `APPROVED` (Zoe B.'s portable suction, PRD l.1329), so no
 *    rider demands an oxygen mount and every van's Oxygen meter reads 0 of what it carries —
 *    which is the honest reading of an approved-needs-only rule, not a counter that does nothing:
 *    the rule is unit-tested, the counter is set at the ramp and saved per van per day.
 *  - `WHEELCHAIR_SECUREMENT` sets the wheelchair flag as well as `mobility`, so a child whose
 *    profile says chair in either place is read as a chair.
 *  - `LIFT_OR_RAMP`, `EQUIPMENT_DIMENSIONS`, `SEATING_SEPARATION` and `MAX_RIDE_TIME` set no flag:
 *    the lift is implied by the chair (§0), and the other three are the deferred conflicts.
 */
const FLAG_OF: Partial<Record<NeedCategory, keyof NeedFlags>> = {
  WHEELCHAIR_SECUREMENT: "wheelchair",
  CAR_SEAT_OR_BOOSTER: "carSeat",
  HARNESS_OR_VEST: "carSeat",
  ATTENDANT_ESCORT: "nurse",
  MEDICAL_DEVICE_POWER: "oxygen",
};

/** The flags for one child of the synthetic day. */
export function needsOf(child: DemoChild): NeedFlags {
  const flags: NeedFlags = { ...NO_NEEDS, wheelchair: child.mobility === "WC" };
  for (const need of child.needs) {
    if (need.state !== "APPROVED") continue;
    const flag = FLAG_OF[need.category];
    if (flag) flags[flag] = true;
  }
  return flags;
}

/** The flags for one child by their fixture key. */
export function needsOfKey(childKey: string): NeedFlags {
  return needsOf(childByKey(childKey));
}

/** Every child of the day with a need of any kind, for the tests and the seed to read. */
export function childrenWithNeeds(): { key: string; needs: NeedFlags }[] {
  return CHILDREN.map((child) => ({ key: child.key, needs: needsOf(child) })).filter((c) =>
    Object.values(c.needs).some(Boolean),
  );
}
