/**
 * Pure helpers behind the ramp check (SURF-04): the capability checklist maps to a
 * vehicle_capability_day observation, and the solver's verdict maps to the banner copy.
 * Copy is fixed by docs/design/COPY-GUIDE.md §5 "SURF-04"; no ticket codes, no jargon.
 */
import type {
  AmbSeat, Child, DailyCapability, Layout, LayoutPosition, Leg, SolveResult, Vehicle, WcPosition,
} from "@/domain/solver";
import { onboardByStop } from "@/domain/solver";
import type { Tone } from "./tokens";

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

export const ANSWER_LABEL: Record<Answer, string> = { YES: "Yes", NO: "No", UNSURE: "Not sure" };
export const POSITION_ANSWER_LABEL: Record<PositionAnswer, string> = {
  FREE: "Free", OUT: "Out of service", UNSURE: "Not sure",
};

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
    observedBy: "Ramp staff",
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

function plural(count: number, one: string): string {
  return `${count} ${count === 1 ? one : `${one}s`}`;
}

export type Banner = { tone: Tone; title: string; detail: string | null };

/** The sticky feasibility banner (COPY-GUIDE §5 SURF-04). */
export function bannerCopy(result: SolveResult, need: Counts, available: Counts): Banner {
  if (result.status === "FEASIBLE") {
    const parts: string[] = [];
    if (need.wc > 0) parts.push(plural(need.wc, "wheelchair"));
    if (need.amb > 0) {
      parts.push(need.tether > 0
        ? `${plural(need.amb, "walking seat")} (${need.tether} with an anchor)`
        : plural(need.amb, "walking seat"));
    }
    return {
      tone: "ok",
      title: parts.length > 0 ? `Fits: ${parts.join(", ")}.` : "Fits: nobody is riding this run.",
      detail: `Checked as ${result.layout?.code ?? ""}.`.trim(),
    };
  }
  if (result.status === "CAPABILITY_PENDING") {
    return {
      tone: "warn",
      title: "Not checked yet.",
      detail: result.pendingReason ?? "Answer every row to see whether the run fits.",
    };
  }
  if (result.status === "VEHICLE_UNAVAILABLE") {
    return { tone: "crit", title: "This vehicle is out of service today.", detail: result.pendingReason };
  }
  const deficit = result.deficit;
  const phrase = !deficit ? "the run does not fit this vehicle"
    : deficit.type === "WC_POSITION" ? `needs ${plural(need.wc, "wheelchair position")}, has ${available.wc}`
    : deficit.type === "AMBULATORY_SEAT" ? `needs ${plural(need.amb, "walking seat")}, has ${available.amb}`
    : deficit.type === "TETHER_SEAT" ? `needs ${plural(need.tether, "anchored seat")}, has ${available.tether}`
    : deficit.type === "WC_SECUREMENT" ? "the securement in this vehicle does not match a rider's chair"
    : deficit.type === "WC_FOOTPRINT" ? "a rider's chair is larger than the position allows"
    : "the lift is not working and a rider boards by lift";
  return {
    tone: "crit",
    title: `Doesn't fit: ${phrase}. Coordinator alerted.`,
    detail: deficit ? `Found at stop ${deficit.k}.` : null,
  };
}

/** Transport needs in plain words, never a diagnosis (COPY-GUIDE §1). */
export function needChips(child: Child): string[] {
  const chips: string[] = [];
  if (child.mobility === "WC") {
    const securement = child.securement === "L_TRACK" ? "L-track"
      : child.securement === "SLIDE_N_CLICK" ? "slide-and-click"
      : child.securement === "FOUR_POINT_STRAP" ? "four-point straps" : "other securement";
    chips.push(`Uses a wheelchair · ${securement}`);
    if (child.wcLengthCm && child.wcWidthCm) chips.push(`Chair ${child.wcLengthCm} × ${child.wcWidthCm} cm`);
  }
  if (child.tether) chips.push("Needs an anchored seat");
  if (child.escort) chips.push("Attendant rides along");
  return chips;
}

export function positionLabel(position: LayoutPosition, index: number): string {
  if (isWc(position)) {
    const securement = position.securement === "L_TRACK" ? "L-track"
      : position.securement === "SLIDE_N_CLICK" ? "slide-and-click"
      : position.securement === "FOUR_POINT_STRAP" ? "four-point straps" : "other securement";
    return `Wheelchair position ${index} · ${securement} · fits ${position.maxLengthCm} × ${position.maxWidthCm} cm`;
  }
  return `Walking seat ${index}${position.tetherCapable ? " · has an anchor" : ""}`;
}
