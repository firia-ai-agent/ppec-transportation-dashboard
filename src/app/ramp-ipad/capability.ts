/**
 * Pure helpers behind the ramp check (SURF-04): the capability checklist maps to a
 * vehicle_capability_day observation, and the solver's verdict maps to the banner copy.
 * Copy is fixed by docs/design/COPY-GUIDE.md §5 "SURF-04"; no ticket codes, no jargon. Every
 * word these helpers assemble comes from src/ui/copy.ts — the verdict is computed here, the
 * sentence that says it is not written here.
 */
import type {
  AmbSeat, Child, DailyCapability, Layout, LayoutPosition, Leg, SolveResult, Vehicle, WcPosition,
} from "@/domain/solver";
import { onboardByStop } from "@/domain/solver";
import type { RampArrival, RampFinding } from "@/domain/plan/arrival";
import { countable, fill, layoutName, pluralize, rampIpad, securement } from "@/ui/copy";
import type { Tone } from "@/ui/tokens";

export type Answer = "YES" | "NO" | "UNSURE";
export type PositionAnswer = "FREE" | "OUT" | "UNSURE";

export type Checklist = {
  /** Which configuration the vehicle arrived in. */
  layoutId: string;
  lift: Answer;
  latch: Answer;
  /** One answer per position id in the chosen configuration. */
  positions: Record<string, PositionAnswer>;
};

export const ANSWER_LABEL: Record<Answer, string> = rampIpad.answer;
export const POSITION_ANSWER_LABEL: Record<PositionAnswer, string> = rampIpad.positionAnswer;

export function layoutOf(vehicle: Vehicle, layoutId: string): Layout {
  const layout = vehicle.layouts.find((l) => l.id === layoutId);
  if (!layout) throw new Error(`vehicle ${vehicle.id} has no layout ${layoutId}`);
  return layout;
}

/** Nothing is answered yet: the honest starting state at the ramp ("Unknown until arrival"). */
export function defaultChecklist(vehicle: Vehicle, layoutId: string): Checklist {
  const layout = layoutOf(vehicle, layoutId);
  return {
    layoutId, lift: "UNSURE", latch: "UNSURE",
    positions: Object.fromEntries(layout.positions.map((p) => [p.id, "UNSURE" as PositionAnswer])),
  };
}

export function isWc(position: LayoutPosition): position is WcPosition { return position.kind === "WC"; }
export function isAmb(position: LayoutPosition): position is AmbSeat { return position.kind === "AMB"; }

/** The checklist as the observation a ramp check records for the vehicle-day. */
export function toCapability(vehicle: Vehicle, checklist: Checklist, serviceDate: string): DailyCapability {
  const layout = layoutOf(vehicle, checklist.layoutId);
  const ids = layout.positions.map((p) => p.id);
  return {
    vehicleId: vehicle.id,
    serviceDate,
    // Ramp staff check the vehicle themselves, so the observation is a verified one.
    state: "VERIFIED",
    observedLayoutId: layout.id,
    liftOk: checklist.lift === "UNSURE" ? null : checklist.lift === "YES",
    latchOk: checklist.latch === "UNSURE" ? null : checklist.latch === "YES",
    unavailablePositionIds: ids.filter((id) => checklist.positions[id] === "OUT"),
    unknownPositionIds: ids.filter((id) => (checklist.positions[id] ?? "UNSURE") === "UNSURE"),
    observedBy: rampIpad.observedBy,
  };
}

/**
 * The checklist as a finding about the van, which is the shape the plan and the board read
 * (src/domain/plan/arrival.ts).
 *
 * The two differ in one way on purpose: a checklist is keyed by the solver's position ids,
 * because that is what the rows on screen are built from, and a finding names places by their
 * 1-based position in the configuration that arrived. The ids belong to a projection and would
 * pin a finding to it; an ordinal survives a trip through a URL, which is how one screen hands
 * a ramp check to another. `toCapability` above is the same conversion for the solver's own
 * benefit — this one is for the two screens that were not in the room.
 *
 * `measured` is the ramp's other kind of finding: a chair measured at arrival rather than
 * anything about the van. It is passed in rather than read off the checklist because the
 * checklist is the §4.4 vehicle check and a chair is not part of the vehicle.
 */
export function findingOfChecklist(
  arrival: RampArrival,
  checklist: Checklist,
  measured: readonly string[] = [],
): RampFinding {
  const layout = layoutOf(arrival.vehicle, checklist.layoutId);
  const ordinalsAnswered = (answer: PositionAnswer) =>
    layout.positions.flatMap((position, index) =>
      (checklist.positions[position.id] ?? "UNSURE") === answer ? [index + 1] : [],
    );
  const riders = new Set(arrival.riders.map((rider) => rider.child.token));
  return {
    laneId: arrival.laneId,
    layoutCode: layout.code,
    outOfService: ordinalsAnswered("OUT"),
    unanswered: ordinalsAnswered("UNSURE"),
    liftOk: checklist.lift === "UNSURE" ? null : checklist.lift === "YES",
    latchOk: checklist.latch === "UNSURE" ? null : checklist.latch === "YES",
    // A chair the ramp did not have in front of it is not a measurement: only this run's riders.
    measured: measured.filter((token) => riders.has(token)),
  };
}

export type Counts = { wc: number; amb: number; tether: number };

/** Peak places the run needs across the manifest: chairs, seats (riders + escorts + staff), anchors. */
export function needSummary(leg: Leg): Counts {
  const stops = onboardByStop(leg);
  const peak = (pick: (stop: (typeof stops)[number]) => number) => Math.max(0, ...stops.map(pick));
  return {
    wc: peak((s) => s.onboard.filter((c) => c.mobility === "WC").length),
    amb: peak((s) => s.onboard.filter((c) => c.mobility === "AMB").length
      + s.onboard.filter((c) => c.escort).length + s.staffEscorts),
    tether: peak((s) => s.onboard.filter((c) => c.tether).length),
  };
}

/** Places the checklist says are free right now. "Not sure" is never counted as free. */
export function availableSummary(vehicle: Vehicle, checklist: Checklist): Counts {
  const layout = layoutOf(vehicle, checklist.layoutId);
  const free = layout.positions.filter((p) => checklist.positions[p.id] === "FREE");
  return {
    wc: free.filter(isWc).length,
    amb: free.filter(isAmb).length,
    tether: checklist.latch === "YES" ? free.filter(isAmb).filter((s) => s.tetherCapable).length : 0,
  };
}

export type Banner = { tone: Tone; title: string; detail: string | null };

/** The sticky feasibility banner (COPY-GUIDE §5 SURF-04). */
export function bannerCopy(result: SolveResult, need: Counts, available: Counts): Banner {
  if (result.status === "FEASIBLE") {
    const parts: string[] = [];
    if (need.wc > 0) parts.push(pluralize(need.wc, countable.wheelchair));
    if (need.amb > 0) {
      const seats = pluralize(need.amb, countable.walkingSeat);
      parts.push(need.tether > 0
        ? fill(rampIpad.withAnchors, { parts: seats, count: need.tether })
        : seats);
    }
    return {
      tone: "ok",
      title: parts.length > 0
        ? fill(rampIpad.fits, { parts: parts.join(", ") })
        : rampIpad.fitsNobody,
      // "Checked as 1 wheelchair · 3 seats." — the banner reads the same words as the button
      // that was tapped, never the provider's shorthand.
      detail: fill(rampIpad.checkedAs, {
        layout: result.layout ? layoutName(result.layout.code) : "",
      }).trim(),
    };
  }
  if (result.status === "CAPABILITY_PENDING") {
    return {
      tone: "warn",
      title: rampIpad.notChecked,
      detail: result.pendingReason ?? rampIpad.notCheckedDetail,
    };
  }
  if (result.status === "VEHICLE_UNAVAILABLE") {
    return { tone: "crit", title: rampIpad.vehicleOut, detail: result.pendingReason };
  }
  const deficit = result.deficit;
  const shortfall = (needed: string, have: number) =>
    fill(rampIpad.deficitCount, { needed, available: have });
  const phrase = !deficit ? rampIpad.deficitFallback
    : deficit.type === "WC_POSITION" ? shortfall(pluralize(need.wc, countable.wcPosition), available.wc)
    : deficit.type === "AMBULATORY_SEAT" ? shortfall(pluralize(need.amb, countable.walkingSeat), available.amb)
    : deficit.type === "TETHER_SEAT" ? shortfall(pluralize(need.tether, countable.anchoredSeat), available.tether)
    : deficit.type === "WC_SECUREMENT" ? rampIpad.deficitSecurement
    : deficit.type === "WC_FOOTPRINT" ? rampIpad.deficitFootprint
    : rampIpad.deficitLift;
  return {
    tone: "crit",
    title: fill(rampIpad.doesntFit, { phrase }),
    detail: deficit ? fill(rampIpad.foundAtStop, { k: deficit.k }) : null,
  };
}

/** Transport needs in plain words, never a diagnosis (COPY-GUIDE §1). */
export function needChips(child: Child): string[] {
  const chips: string[] = [];
  if (child.mobility === "WC") {
    chips.push(fill(rampIpad.usesWheelchair, { securement: securement[child.securement ?? "OTHER"] }));
    if (child.wcLengthCm && child.wcWidthCm) {
      chips.push(fill(rampIpad.chairSize, { length: child.wcLengthCm, width: child.wcWidthCm }));
    }
  }
  if (child.tether) chips.push(rampIpad.needsAnchoredSeat);
  if (child.escort) chips.push(rampIpad.escortRides);
  return chips;
}

/** A position's own name: "Wheelchair position 1" / "Walking seat 3". */
export function positionName(position: LayoutPosition, index: number): string {
  const template = isWc(position) ? rampIpad.wcPosition : rampIpad.ambPosition;
  return fill(template, { n: index });
}

/**
 * What the ramp needs to know about a position beyond its name — securement and footprint for a
 * chair, whether a seat has an anchor. Empty when there is nothing extra to say.
 */
export function positionDetail(position: LayoutPosition): string {
  if (isWc(position)) {
    return fill(rampIpad.wcPositionDetail, {
      securement: securement[position.securement],
      length: position.maxLengthCm,
      width: position.maxWidthCm,
    });
  }
  return position.tetherCapable ? rampIpad.ambPositionDetail : "";
}

/** Name plus detail, as the checklist and the slot matrix read it out together. */
export function positionLabel(position: LayoutPosition, index: number): string {
  const detail = positionDetail(position);
  return detail ? [positionName(position, index), detail].join(" · ") : positionName(position, index);
}
