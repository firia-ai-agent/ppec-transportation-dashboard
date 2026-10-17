"use client";
/**
 * Plan routes (PRD B-09 VEH-01…05, B-13; DESIGN-DIRECTION §4.1; copy COPY-GUIDE §5).
 *
 * One lane per van: what the van has today, how many places are taken, and the children in it
 * as stops in the order they are driven. Children in no van are at the top of the screen — a
 * plain list of names where nobody has placed them yet, and a group with a reason and the
 * options for each child planning could not place. The map's place is beside the lanes and says
 * what will be there; the live pane lands with live updates.
 *
 * Every verdict on this screen is the capacity solver's (src/domain/solver): "Plan routes" runs
 * the planner, a drag re-asks it, a substitution re-asks it, and an arrival report re-asks it.
 * Nothing is placed by a rule of thumb the four constraints did not agree with, and nothing is
 * assigned, locked or sent — a coordinator approves a plan, and the family hears nothing before
 * that (AT-12). Planning keeps what a coordinator placed by hand and fills in the rest, so the
 * one button on the screen can say the same thing every time it is read.
 *
 * No vehicle code reaches it. A van is named by what it is — "the convertible van" — because
 * "V1" is the machine's handle on it and a coordinator has to translate before they can act
 * (copy.ts `vanNamed`).
 *
 * Client state and fixtures only: no database, no API, no routing provider and no map tiles, so
 * the screen makes no network request of its own at all (TEST-SEC-02). Words come from
 * src/ui/copy.ts and colours and metrics from the tokens in src/ui/tokens.ts; the DEMO banner
 * and the one source chip come from the root layout, so this page must not mount a second pair.
 *
 * The one thing here wearing the demo violet is the scenario control in the header, and it is
 * shared demo chrome (src/ui/DemoControls) rather than anything this screen styles itself.
 */
import { useMemo, useRef, useState } from "react";
import { Ban, Check, ChevronDown, ChevronRight } from "lucide-react";
import {
  DEMO_SCENARIOS,
  PLAN_SERVICE_DATE,
  RELIEF_DRIVERS,
  asMeasured,
  askedProvider,
  checkedAtRamp,
  driverFor,
  notCheckedYet,
  planLanes,
  planRiders,
  reportedByProvider,
  spareVehicleKeys,
  substituted,
  unapprovedNeeds,
  vehicleByKey,
  type DemoScenario,
} from "@/domain/plan/day";
import {
  RAMP_DIRECTION,
  observedCapability,
  replanForArrival,
  type RampFinding,
} from "@/domain/plan/arrival";
import { arrivalBannerLines } from "@/ui/arrival-lines";
import {
  planAssignment,
  routePlan,
  tryMove,
  type Assignment,
  type DailyCapability,
  type Direction,
  type LanePlan,
  type ManualPlacements,
  type PlanInput,
  type PlanLane,
  type PlanRider,
  type ResolutionOption,
  type Unplaced,
} from "@/domain/solver";
import { board, fill, needCategories, places, planRoutes, rampPreview, rampReplan, vanName } from "@/ui/copy";
import { DemoControls } from "@/ui/DemoControls";
import { serviceDateLabel } from "@/ui/service-date";
import { StateChip } from "@/ui/StateChip";
import { icon } from "@/ui/tokens";
import {
  ARRIVAL_ANSWERS,
  arrivalLabel,
  equipmentChips,
  laneLines,
  laneState,
  needChips,
  needsADecision,
  reasonLine,
  refusalLine,
  seatLines,
  setUpAsLine,
  setUpChangeLine,
  stopLine,
  summaryLine,
  unplacedState,
  type ArrivalAnswer,
} from "./lanes";
import styles from "./plan.module.css";

/**
 * What the day knows about one lane's van, as this screen lets staff change it.
 *
 * `CHANGED` and `ASKED` are not answers anybody taps: they are where a substitution puts the
 * lane, and where asking the provider again puts it — VEH-05's chain, substitution → unknown →
 * re-request → re-solve, is this field moving through its values.
 */
type LaneStage = {
  /** The van on this lane now, which is not always the van it started the day as (AT-05). */
  vehicleKey: string;
  driverName: string;
  arrival: ArrivalAnswer | "CHANGED" | "ASKED";
  /** The configuration the ramp saw, pinned at the moment it was recorded (ASM-17). */
  rampLayoutId?: string;
  /**
   * The whole observation, when it came from a ramp check this screen was handed rather than
   * from the button on this screen.
   *
   * The button records what a coordinator can see from here — a van was checked, in the
   * configuration the lane is planned as — and nothing more, because that is all it knows. A
   * check that arrived from the ramp knows more than that: which places are out of service,
   * which nobody could answer for, whether the lift came down. Dropping those and keeping only
   * the configuration would quietly re-plan the day as if the van were fine.
   */
  rampCapability?: DailyCapability;
};

/**
 * The service date the demo replays, as "Tue, Oct 14". Read at noon UTC so the site timezone
 * (America/New_York) lands on the calendar day the fixture names.
 *
 * One date, for both scenarios: the demo control below switches which run of this day is on
 * screen, and the screen never shows a second one (Vera's review, 2026-10-17).
 */
const SERVICE_DATE_LABEL = serviceDateLabel(new Date(`${PLAN_SERVICE_DATE}T12:00:00Z`));

function initialStages(scenario: DemoScenario): Record<string, LaneStage> {
  return Object.fromEntries(
    planLanes(scenario).map((lane) => [
      lane.id,
      { vehicleKey: lane.vehicle.id, driverName: lane.driverName, arrival: "REPORTED" as const },
    ]),
  );
}

function emptyAssignment(scenario: DemoScenario): Assignment {
  return Object.fromEntries(planLanes(scenario).map((lane) => [lane.id, []]));
}

/** The drop zone that is the group at the top of the screen: in no van at all. */
const NO_LANE = "none";

/** How far a pointer travels before holding a rider counts as a drag rather than a press. */
const DRAG_THRESHOLD_PX = 5;

/**
 * The drop zone under a point, read off the screen itself: a lane id, `null` for the group at the
 * top, and `undefined` for anywhere that is neither.
 *
 * Hit-tested at the pointer rather than tracked with enter and leave events, because the row
 * being dragged holds the pointer capture for the whole gesture — which is what makes a real
 * mouse work at all — and a captured pointer sends no events to what it is over.
 */
function dropZoneAt(x: number, y: number): string | null | undefined {
  const zone = document.elementFromPoint(x, y)?.closest("[data-drop-zone]");
  const id = zone?.getAttribute("data-drop-zone");
  if (id === undefined || id === null) return undefined;
  return id === NO_LANE ? null : id;
}

/** A rider held by the pointer, from the press that picked them up to the release that drops them. */
type Gesture = {
  pointerId: number;
  childToken: string;
  childName: string;
  /** The lane they were in when they were picked up, so a drop back into it is not a move. */
  from: string | null;
  x: number;
  y: number;
  /** True once the pointer has travelled far enough for this to be a drag. */
  dragging: boolean;
};

function capabilityOf(stage: LaneStage): DailyCapability {
  switch (stage.arrival) {
    case "NOT_CHECKED":
      return notCheckedYet(stage.vehicleKey);
    case "CHANGED":
      return substituted(stage.vehicleKey);
    case "ASKED":
      return askedProvider(stage.vehicleKey);
    case "RAMP_CHECKED":
      if (stage.rampCapability) return stage.rampCapability;
      return stage.rampLayoutId
        ? checkedAtRamp(stage.vehicleKey, stage.rampLayoutId, rampPreview.observedBy)
        : reportedByProvider(stage.vehicleKey);
    default:
      return reportedByProvider(stage.vehicleKey);
  }
}

/** A button that can be the current answer, and says so with a check mark as well as a fill. */
function Button({
  label,
  onClick,
  pressed,
}: {
  label: string;
  onClick: () => void;
  pressed?: boolean;
}) {
  return (
    <button type="button" onClick={onClick} aria-pressed={pressed} className={styles.button}>
      {pressed ? <Check size={icon.inline} aria-hidden="true" /> : null}
      {label}
    </button>
  );
}

/**
 * A ramp check this screen was handed, as the state it opens in.
 *
 * `null` when there is none, which is every ordinary visit. When there is one, the screen opens
 * on the afternoon — the run a ramp check is about (PRD §9 l.865) — with the checked van's
 * observation on its lane, the chairs the ramp measured measured, and the children in the vans
 * the solver's own mover put them in. Everything after that is the screen a coordinator already
 * knows: they can drag somebody else, substitute a van, or clear the check and read the plan
 * without it.
 *
 * Computed once rather than held in state: the same finding always produces the same re-plan
 * (src/domain/plan/arrival.ts is pure), so there is nothing to keep in sync, and a screenshot of
 * the link is evidence of what it shows.
 */
function openedOn(arrival: RampFinding | null) {
  if (!arrival) return null;
  const replan = replanForArrival(arrival, RAMP_DIRECTION);
  const stages = initialStages("EVERY_RIDER_FITS");
  return {
    replan,
    direction: RAMP_DIRECTION,
    stages: {
      ...stages,
      [arrival.laneId]: {
        ...stages[arrival.laneId],
        arrival: "RAMP_CHECKED" as const,
        rampLayoutId: observedCapability(arrival).observedLayoutId ?? undefined,
        rampCapability: observedCapability(arrival),
      },
    },
    assignment: replan.after,
    measured: arrival.measured,
    /** The re-plan is a placement a person is accountable for, so planning plans around it. */
    pinned: Object.fromEntries(
      Object.entries(replan.after).flatMap(([laneId, tokens]) =>
        tokens.map((token) => [token, laneId] as const),
      ),
    ) as ManualPlacements,
  };
}

export default function PlanRoutes({ arrival = null }: { arrival?: RampFinding | null }) {
  /** The ramp check the URL carried, if it carried a readable one, as this screen's first state. */
  const opened = useMemo(() => openedOn(arrival), [arrival]);
  const [scenario, setScenario] = useState<DemoScenario>("EVERY_RIDER_FITS");
  const [direction, setDirection] = useState<Direction>(opened?.direction ?? "AM");
  const [stages, setStages] = useState<Record<string, LaneStage>>(
    () => opened?.stages ?? initialStages("EVERY_RIDER_FITS"),
  );
  const [assignment, setAssignment] = useState<Assignment>(
    () => opened?.assignment ?? emptyAssignment("EVERY_RIDER_FITS"),
  );
  /** Children whose chair the ramp has measured, which is the arrival check's whole lever. */
  const [measured, setMeasured] = useState<readonly string[]>(() => opened?.measured ?? []);
  const [moving, setMoving] = useState<string | null>(null);
  const [substituting, setSubstituting] = useState<string | null>(null);
  /**
   * Where a coordinator has put somebody by hand, so "Plan routes" can plan around them instead
   * of over them (Vera's review, 2026-10-17). Every accepted move writes here; a run or a
   * scenario change clears it, because a placement is about one fleet on one run.
   */
  const [pinned, setPinned] = useState<ManualPlacements>(() => opened?.pinned ?? {});
  /** The one lane whose "Change van or report" disclosure is open, if any. */
  const [changing, setChanging] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  /** The rider the pointer is holding, so their row can show that it has been picked up. */
  const [held, setHeld] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; refused: boolean } | null>(null);
  /**
   * The gesture in progress. A ref and not state: it is read and written inside the pointer
   * handlers between renders, and a drag that waited for a render to know where it started
   * would drop the first few millimetres of every move.
   */
  const gesture = useRef<Gesture | null>(null);

  /** The scenario's vans before anything has been reported, planned or substituted. */
  const baseLanes = useMemo(() => planLanes(scenario), [scenario]);

  const riders = useMemo<PlanRider[]>(
    () =>
      planRiders(direction).map((rider) =>
        measured.includes(rider.child.token) ? asMeasured(rider) : rider,
      ),
    [direction, measured],
  );

  const lanes = useMemo<PlanLane[]>(
    () =>
      baseLanes.map((lane) => {
        const stage = stages[lane.id];
        // The scenario was just switched: its own stages arrive in the same render, and until
        // they do the lane is exactly what the scenario hands over.
        if (!stage) return lane;
        return {
          id: lane.id,
          vehicle: vehicleByKey(stage.vehicleKey),
          capability: capabilityOf(stage),
          driverName: stage.driverName,
        };
      }),
    [baseLanes, stages],
  );

  const input: PlanInput = useMemo(
    () => ({ direction, centerLabel: places.center, lanes, riders }),
    [direction, lanes, riders],
  );
  const plan = useMemo(() => routePlan(input, assignment), [input, assignment]);

  const placed = plan.lanes.reduce((n, lane) => n + lane.riders.length, 0);
  const decisionsOpen = needsADecision(plan.lanes, plan.unplaced);

  /**
   * The two groups of children in no van, which are two different facts (Vera's review).
   *
   * `waiting` is the opening state and anybody a coordinator has taken out of a van: somewhere
   * for them exists and nobody has put them there. `blocked` is the rest — a child planning
   * could not place — and that is the group that is red and carries a reason and the options.
   */
  const waiting = plan.unplaced.filter((row) => row.cause === "NOT_IN_A_VAN");
  const blocked = plan.unplaced.filter((row) => row.cause !== "NOT_IN_A_VAN");

  /* ───────────────────────────── the actions ───────────────────────────── */

  /**
   * Plan the day. The button says "Plan routes" every time it is read, because it does the same
   * thing every time: it keeps the children a coordinator placed by hand and plans the rest of
   * the day around them. It used to re-label itself "Plan routes again" and start from nothing,
   * which threw away every drag without asking (Vera's review, 2026-10-17).
   */
  const runPlan = () => {
    setAssignment(planAssignment(input, pinned));
    setMoving(null);
    setNotice(
      Object.keys(pinned).length > 0
        ? { text: planRoutes.plannedKeptMoves, refused: false }
        : null,
    );
  };

  const chooseDirection = (next: Direction) => {
    if (next === direction) return;
    // A plan belongs to one run: the morning's lanes are not the afternoon's, and carrying the
    // assignment across would show a plan nobody made for the run on screen.
    setDirection(next);
    setAssignment(emptyAssignment(scenario));
    setPinned({});
    setMoving(null);
    setNotice(null);
  };

  /**
   * Switch which scenario of the day the screen replays. A different fleet is a different plan,
   * so everything the first one collected — the assignment, what each lane was reported as, the
   * chair the ramp measured — is dropped rather than carried onto vans it was never about.
   */
  const chooseScenario = (next: DemoScenario) => {
    if (next === scenario) return;
    setScenario(next);
    setStages(initialStages(next));
    setAssignment(emptyAssignment(next));
    setPinned({});
    setMeasured([]);
    setMoving(null);
    setSubstituting(null);
    setChanging(null);
    setNotice(null);
  };

  /**
   * Move a child into a lane, or out of every lane. The solver decides: a lane that cannot take
   * the child refuses, the assignment does not change at all, and one line says who and what is
   * missing.
   *
   * An accepted move is remembered as this coordinator's own placement, so the next press of
   * "Plan routes" plans around it rather than over it. A refusal records nothing: nothing moved.
   *
   * Every move on the screen comes through here — the drag's release and the Move menu's buttons
   * both call it — and this is the only place the assignment is set from a move. The decision
   * itself is `tryMove`'s (src/domain/solver), which either hands back the new assignment or a
   * refusal and no assignment at all: Veri's finding, 2026-10-17, was that asking the solver and
   * editing the assignment were two steps here, and dropping the first one passed every test.
   * There is nothing left to drop — a refusal has nothing in it to assign.
   */
  const move = (childToken: string, laneId: string | null) => {
    setMoving(null);
    const rider = riders.find((r) => r.child.token === childToken);
    if (!rider) return;
    const lane = laneId === null ? null : lanes.find((l) => l.id === laneId);
    if (laneId !== null && !lane) return;

    const result = tryMove(input, assignment, childToken, laneId);
    if (!result.ok) {
      // The van that refused, by name, and the one thing it is missing. Only a lane can refuse —
      // taking a child out of every van is always allowed — so `lane` is set on this branch.
      if (lane) {
        setNotice({ text: refusalLine(lane.vehicle, rider.child, result.cause), refused: true });
      }
      return;
    }
    setAssignment(result.assignment);
    setPinned((prev) => ({ ...prev, [childToken]: laneId }));
    setNotice({
      text: lane
        ? fill(planRoutes.moved, {
            child: rider.child.displayName,
            vehicle: vanName(lane.vehicle.description),
          })
        : fill(planRoutes.movedOut, { child: rider.child.displayName }),
      refused: false,
    });
  };

  const answerArrival = (lanePlan: LanePlan, answer: ArrivalAnswer) => {
    setStages((prev) => ({
      ...prev,
      [lanePlan.lane.id]: {
        ...prev[lanePlan.lane.id],
        arrival: answer,
        // The ramp reports the configuration the van arrived in, which is the one the lane is
        // planned as; from here on it pins the solver's layout search.
        rampLayoutId: answer === "RAMP_CHECKED" ? lanePlan.layout.id : undefined,
        // Answering here replaces whatever the iPad handed over: this is a coordinator saying
        // what they know, and they do not know which places were out of service.
        rampCapability: undefined,
      },
    }));
    setNotice(null);
  };

  const substitute = (laneId: string, vehicleKey: string) => {
    const previous = vehicleByKey(stages[laneId].vehicleKey);
    const replacement = vehicleByKey(vehicleKey);
    const driverName = driverFor(vehicleKey);
    setStages((prev) => ({
      ...prev,
      [laneId]: {
        vehicleKey,
        driverName,
        // VEH-05: a different van means nothing is known about it yet, whatever was known about
        // the one it replaces. The lane says so until the provider answers again.
        arrival: "CHANGED",
      },
    }));
    setSubstituting(null);
    setNotice({
      text: fill(planRoutes.substituted, {
        vehicle: vanName(replacement.description),
        previous: vanName(previous.description),
        driver: driverName,
      }),
      refused: false,
    });
  };

  const substituteDriver = (laneId: string, driverName: string) => {
    // A different person at the wheel changes nothing about what the van can carry, so the
    // capability observation is left exactly as it was.
    setStages((prev) => ({ ...prev, [laneId]: { ...prev[laneId], driverName } }));
    setSubstituting(null);
    setNotice({ text: fill(planRoutes.substitutedDriver, { driver: driverName }), refused: false });
  };

  const askProvider = (lane: PlanLane) => {
    setStages((prev) => ({ ...prev, [lane.id]: { ...prev[lane.id], arrival: "ASKED" } }));
    setNotice({
      text: fill(planRoutes.asked, {
        provider: lane.vehicle.providerName,
        vehicle: vanName(lane.vehicle.description),
      }),
      refused: false,
    });
  };

  const recordAnswer = (lane: PlanLane) => {
    setStages((prev) => ({ ...prev, [lane.id]: { ...prev[lane.id], arrival: "REPORTED" } }));
    setNotice({
      text: fill(planRoutes.answered, {
        provider: lane.vehicle.providerName,
        vehicle: vanName(lane.vehicle.description),
      }),
      refused: false,
    });
  };

  const toggleMeasured = (childToken: string) => {
    setMeasured((prev) =>
      prev.includes(childToken) ? prev.filter((t) => t !== childToken) : [...prev, childToken],
    );
    setNotice(null);
  };

  /* ───────────────────────── the pieces of the screen ───────────────────────── */

  /**
   * A lane, or the group at the top, as somewhere a held rider can be let go.
   *
   * The zone is only marked, never wired: `dropZoneAt` finds it under the pointer, so a zone
   * needs no handlers of its own and cannot be missed because a child element swallowed an
   * event.
   */
  const dropZone = (laneId: string | null) => ({
    "data-drop-zone": laneId ?? NO_LANE,
    "data-over": over === (laneId ?? NO_LANE) ? "true" : undefined,
  });

  /* ───────────────────────────── picking a rider up ───────────────────────────── */

  /**
   * Dragging a rider with a real pointer: mouse, trackpad, pen or finger.
   *
   * Not the browser's own drag-and-drop. That needs the platform to start a drag session, which
   * it does for a mouse on a desktop and does not do for a touch, for a synthetic gesture, or in
   * a headless browser — so the screen shipped with a drag that worked in exactly none of the
   * ways it was tried, and said nothing when it failed. Pointer events are the same three facts
   * (down, move, up) with no platform session in the middle: the row captures the pointer on the
   * way down, so every move reaches it however far the pointer travels, and the zone under the
   * pointer is hit-tested on release. A browser check can drive it with the mouse, and so can a
   * finger on the iPad.
   *
   * `Move` beside every rider does the same thing with no pointer at all (§9), and it stays.
   */
  const dragHandlers = (rider: PlanRider, laneId: string | null) => ({
    onPointerDown: (event: React.PointerEvent<HTMLDivElement>) => {
      // Secondary buttons belong to the browser's own menu, and a button inside the row is a
      // button: Measure and Move are pressed, not dragged.
      if (event.button !== 0) return;
      if (event.target instanceof Element && event.target.closest("button")) return;
      gesture.current = {
        pointerId: event.pointerId,
        childToken: rider.child.token,
        childName: rider.child.displayName,
        from: laneId,
        x: event.clientX,
        y: event.clientY,
        dragging: false,
      };
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    onPointerMove: (event: React.PointerEvent<HTMLDivElement>) => {
      const current = gesture.current;
      if (!current || current.pointerId !== event.pointerId) return;
      if (!current.dragging) {
        const far =
          Math.abs(event.clientX - current.x) >= DRAG_THRESHOLD_PX ||
          Math.abs(event.clientY - current.y) >= DRAG_THRESHOLD_PX;
        if (!far) return;
        current.dragging = true;
        setHeld(current.childToken);
        setMoving(null);
        setNotice({
          text: fill(planRoutes.dragging, { child: current.childName }),
          refused: false,
        });
      }
      const zone = dropZoneAt(event.clientX, event.clientY);
      setOver(zone === undefined ? null : (zone ?? NO_LANE));
    },
    onPointerUp: (event: React.PointerEvent<HTMLDivElement>) => {
      const current = gesture.current;
      gesture.current = null;
      if (!current || current.pointerId !== event.pointerId) return;
      setHeld(null);
      setOver(null);
      // A press that never travelled is not a drag, and claims nothing happened.
      if (!current.dragging) return;
      const zone = dropZoneAt(event.clientX, event.clientY);
      if (zone === undefined) {
        setNotice({
          text: fill(planRoutes.dragNowhere, { child: current.childName }),
          refused: false,
        });
        return;
      }
      // Let go over the van they are already in: nothing to say, and nothing to re-solve.
      if (zone === current.from) {
        setNotice(null);
        return;
      }
      move(current.childToken, zone);
    },
    onPointerCancel: () => {
      gesture.current = null;
      setHeld(null);
      setOver(null);
      setNotice(null);
    },
  });

  /**
   * The §9 options for a child or a run. Every one of them needs a coordinator, which is said
   * once underneath rather than on each row: the chip that used to repeat it beside every option
   * carried the same five words five times and buried the thing that differs (Vera's review,
   * 2026-10-17). `requiresApproval` is still true of every option the solver proposes — the note
   * is the screen saying so, not the screen assuming it.
   */
  const optionList = (heading: string, options: readonly ResolutionOption[]) => (
    <div>
      <h4 className={styles.menuHeading}>{heading}</h4>
      <ol className={styles.optionList}>
        {options.map((option) => (
          <li key={option.id} className={styles.option}>
            <span>{fill(planRoutes.optionRow, { label: option.label, detail: option.detail })}</span>
          </li>
        ))}
      </ol>
      <p className={styles.note}>{planRoutes.optionsNote}</p>
    </div>
  );

  /**
   * The keyboard's way to do what a drag does (§9: nothing on this screen is mouse-only). It
   * lists the lanes by name, so the choice is "Move to the center van" rather than a target to
   * aim at.
   */
  const moveMenu = (rider: PlanRider, currentLaneId: string | null) => {
    const token = rider.child.token;
    const heading = fill(planRoutes.moveHeading, { child: rider.child.displayName });
    if (moving !== token) {
      return (
        <Button
          label={fill(planRoutes.move, { child: rider.child.displayName })}
          onClick={() => setMoving(token)}
        />
      );
    }
    return (
      <div className={styles.menu} role="group" aria-label={heading}>
        <span className={styles.menuHeading}>{heading}</span>
        {lanes
          .filter((lane) => lane.id !== currentLaneId)
          .map((lane) => (
            <Button
              key={lane.id}
              label={fill(planRoutes.moveTo, { vehicle: vanName(lane.vehicle.description) })}
              onClick={() => move(token, lane.id)}
            />
          ))}
        {currentLaneId !== null ? (
          <Button label={planRoutes.moveOut} onClick={() => move(token, null)} />
        ) : null}
        <Button label={planRoutes.moveClose} onClick={() => setMoving(null)} />
      </div>
    );
  };

  const riderBody = (rider: PlanRider, laneId: string | null) => {
    const child = rider.child;
    const isMeasured = measured.includes(child.token);
    return (
      <div className={styles.stopBody}>
        <div className={styles.riderRow}>
          <span className={styles.riderName}>{child.displayName}</span>
          <span className={styles.meta}>{stopLine(rider)}</span>
        </div>
        <ul className={styles.chips}>
          {needChips(child, isMeasured).map((text) => (
            <li key={text} className={styles.chip}>
              {text}
            </li>
          ))}
          {unapprovedNeeds(child.token).map((need) => (
            <li key={need} className={styles.chip} data-approved="false">
              {fill(planRoutes.unapprovedNeed, { need: needCategories[need] })}
            </li>
          ))}
        </ul>
        <div className={styles.rowActions}>
          {child.mobility === "WC" ? (
            <Button
              label={fill(planRoutes.chairMeasure, { child: child.displayName })}
              pressed={isMeasured}
              onClick={() => toggleMeasured(child.token)}
            />
          ) : null}
          {moveMenu(rider, laneId)}
        </div>
      </div>
    );
  };

  /**
   * A child in the waiting list: their name, and the one control §9 needs.
   *
   * Nothing else. Before planning this list is the whole roster, and it was being drawn as nine
   * full rider cards — stop, window, equipment chips, the intake caption, a Measure button — in a
   * red-bordered group, which said "nine problems" about a screen whose only state was that
   * nobody had pressed the button yet (Vera's review, 2026-10-17). A name is what a coordinator
   * reads here, and `Move` stays because a drag may never be the only way to place somebody.
   */
  const waitingBody = (rider: PlanRider) => (
    <div className={styles.waitingRow}>
      <span className={styles.riderName}>{rider.child.displayName}</span>
      {moveMenu(rider, null)}
    </div>
  );

  /**
   * A rider row, dragged by whatever is inside it. `data-rider` is how the browser check finds
   * one child's row to drag it, and `data-verdict` on a lane is how it compares what the solver
   * said with what the lane shows — the words are chosen for a coordinator and are deliberately
   * not machine-readable. Nothing on the screen depends on either attribute.
   */
  const draggableRider = (rider: PlanRider, laneId: string | null, body: React.ReactNode) => (
    <div
      key={rider.child.token}
      className={styles.draggable}
      data-rider={rider.child.displayName}
      data-held={held === rider.child.token ? "true" : undefined}
      {...dragHandlers(rider, laneId)}
    >
      {body}
    </div>
  );

  const laneSection = (lanePlan: LanePlan) => {
    const { lane, seats, verdict } = lanePlan;
    const stage = stages[lane.id];
    const headingId = `lane-${lane.id}`;
    const changesId = `lane-${lane.id}-changes`;
    const state = laneState(lanePlan);
    const spares = spareVehicleKeys(scenario).filter((key) => key !== stage.vehicleKey);
    const laneIndex = baseLanes.findIndex((l) => l.id === lane.id);
    const lastStop = lanePlan.leg.stops.length;
    const van = vanName(lane.vehicle.description);
    // The van's changes are folded away, and open themselves while the van has changed: that is
    // the half of VEH-05 where the next step — ask the provider, record the answer — is inside.
    const changesOpen =
      changing === lane.id || stage.arrival === "CHANGED" || stage.arrival === "ASKED";

    return (
      <section
        key={lane.id}
        className={styles.lane}
        aria-labelledby={headingId}
        data-lane={lane.id}
        data-van={van}
        data-verdict={verdict.status}
        {...dropZone(lane.id)}
      >
        <div className={styles.laneTitleRow}>
          <h3 id={headingId} className={styles.laneTitle}>
            {van}
          </h3>
          <StateChip state={state} />
        </div>
        <p className={styles.meta}>
          {fill(planRoutes.vanMeta, {
            provider: lane.vehicle.providerName,
            driver: lane.driverName,
          })}
        </p>
        <p className={styles.meta}>{setUpAsLine(lanePlan.layout)}</p>
        {/* Why that line is not the same line all day on a van that can be re-seated. */}
        {setUpChangeLine(lanePlan) ? (
          <p className={styles.note}>{setUpChangeLine(lanePlan)}</p>
        ) : null}
        <ul className={styles.chips} aria-label={planRoutes.equipmentHeading}>
          {equipmentChips(lane.vehicle, lanePlan.layout, lane.capability).map((text) => (
            <li key={text} className={styles.chip}>
              {text}
            </li>
          ))}
        </ul>
        <ul className={styles.chips}>
          {seatLines(seats).map((line) => (
            <li key={line} className={styles.chip}>
              {line}
            </li>
          ))}
        </ul>
        {laneLines(lanePlan).map((line, index) => (
          <p key={index} className={styles.laneLine} data-tone={state.tone}>
            {line}
          </p>
        ))}

        <h4 className={styles.menuHeading}>{planRoutes.stopsHeading}</h4>
        <ol className={styles.stops}>
          {lanePlan.leg.stops.map((stop) => {
            // The end of the run that is the centre — the morning's drop-off, the afternoon's
            // pickup — is one row that says which it is, not a rider row with a place on it.
            const isCentre = direction === "AM" ? stop.k === lastStop : stop.k === 1;
            const tokens = direction === "AM" ? (stop.boarding ?? []) : (stop.alighting ?? []);
            const stopRiders = tokens.flatMap((token) => {
              const rider = lanePlan.riders.find((r) => r.child.token === token);
              return rider ? [rider] : [];
            });
            return (
              <li key={stop.k} className={styles.stopRow}>
                <span className={styles.stopIndex}>{stop.k}</span>
                {isCentre ? (
                  <span className={styles.stopBody}>
                    {fill(planRoutes.centerRow, {
                      what: direction === "AM" ? planRoutes.dropOff : planRoutes.pickUp,
                      stop: stop.label,
                    })}
                  </span>
                ) : (
                  stopRiders.map((rider) =>
                    draggableRider(rider, lane.id, riderBody(rider, lane.id)),
                  )
                )}
              </li>
            );
          })}
        </ol>

        {/*
          What arrived and who is driving, behind one control (Vera's review, 2026-10-17). Both
          are real questions and neither is the one a lane is open for, so they are folded away
          under every lane instead of being stacked beneath the stops on all three of them.
        */}
        <div className={styles.rowActions}>
          <button
            type="button"
            className={styles.button}
            aria-expanded={changesOpen}
            aria-controls={changesId}
            onClick={() => setChanging(changesOpen ? null : lane.id)}
          >
            {changesOpen ? (
              <ChevronDown size={icon.inline} aria-hidden="true" />
            ) : (
              <ChevronRight size={icon.inline} aria-hidden="true" />
            )}
            {planRoutes.changeVan}
          </button>
        </div>
        <div id={changesId} hidden={!changesOpen} className={styles.changes}>
          <div className={styles.rowActions} role="group" aria-label={planRoutes.arrivalHeading}>
            <span className={styles.menuHeading}>{planRoutes.arrivalHeading}</span>
            {ARRIVAL_ANSWERS.map((answer) => (
              <Button
                key={answer}
                label={arrivalLabel(answer, lane.vehicle.providerName)}
                pressed={stage.arrival === answer}
                onClick={() => answerArrival(lanePlan, answer)}
              />
            ))}
          </div>

          {stage.arrival === "CHANGED" ? (
            <div className={styles.rowActions}>
              <Button
                label={fill(planRoutes.askProvider, { provider: lane.vehicle.providerName })}
                onClick={() => askProvider(lane)}
              />
            </div>
          ) : null}
          {stage.arrival === "ASKED" ? (
            <div className={styles.rowActions}>
              <Button
                label={fill(planRoutes.recordAnswer, { provider: lane.vehicle.providerName })}
                onClick={() => recordAnswer(lane)}
              />
            </div>
          ) : null}

          <div className={styles.rowActions} role="group" aria-label={planRoutes.substituteHeading}>
            <span className={styles.menuHeading}>{planRoutes.substituteHeading}</span>
            {substituting === lane.id ? (
              <>
                {spares.map((key) => {
                  const spare = vehicleByKey(key);
                  return (
                    <Button
                      key={key}
                      label={fill(planRoutes.substituteOption, {
                        vehicle: vanName(spare.description),
                        driver: driverFor(key),
                      })}
                      onClick={() => substitute(lane.id, key)}
                    />
                  );
                })}
                <Button
                  label={planRoutes.substituteDriver}
                  onClick={() =>
                    substituteDriver(lane.id, RELIEF_DRIVERS[laneIndex % RELIEF_DRIVERS.length])
                  }
                />
                <Button label={planRoutes.moveClose} onClick={() => setSubstituting(null)} />
              </>
            ) : (
              <Button label={planRoutes.substitute} onClick={() => setSubstituting(lane.id)} />
            )}
          </div>
        </div>

        {verdict.options.length > 0 ? optionList(planRoutes.laneOptionsHeading, verdict.options) : null}
      </section>
    );
  };

  const unplacedRow = (unplaced: Unplaced) => {
    const lane = unplaced.laneId ? lanes.find((l) => l.id === unplaced.laneId) : undefined;
    return (
      <div key={unplaced.rider.child.token} className={styles.unplacedRow}>
        <div className={styles.riderRow}>
          <StateChip state={unplacedState(unplaced.cause)} />
          <p className={styles.reason}>
            {reasonLine(unplaced, lane ? vanName(lane.vehicle.description) : "")}
          </p>
        </div>
        {draggableRider(unplaced.rider, null, riderBody(unplaced.rider, null))}
        {unplaced.options.length > 0
          ? optionList(
              fill(planRoutes.optionsHeading, { child: unplaced.rider.child.displayName }),
              unplaced.options,
            )
          : null}
      </div>
    );
  };

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <div className={styles.titleRow}>
          <h1 className={styles.title}>{planRoutes.heading}</h1>
          <span className={styles.subtitle}>
            {fill(planRoutes.subtitle, {
              date: SERVICE_DATE_LABEL,
              direction: planRoutes.direction[direction],
            })}
          </span>
        </div>
        {/*
          Which scenario of the day is on screen. Two, because the normal one never shows the
          group at the top: with every child in a van, the reasons a child has none — and the
          fact that no family has been told anything — can only be read in the run where one
          child's equipment has no van to hold it.

          It is a demo control and wears the DEMO bar's clothes, not the screen's (Vera's
          review, 2026-10-17): a coordinator never chooses which run their day was. The date in
          the heading is the same either way — one demo day, two scenarios — and when the demo
          panel lands (B-15) this control moves into it.
        */}
        <DemoControls
          legend={planRoutes.demoScenarioLegend}
          options={DEMO_SCENARIOS.map((value) => ({
            value,
            label: planRoutes.demoScenario[value],
          }))}
          value={scenario}
          onChange={chooseScenario}
          note={planRoutes.demoScenarioNote[scenario]}
        />
        <div className={styles.actionRow} role="group" aria-label={planRoutes.directionLegend}>
          {(["AM", "PM"] as const).map((value) => (
            <Button
              key={value}
              label={planRoutes.directionButton[value]}
              pressed={direction === value}
              onClick={() => chooseDirection(value)}
            />
          ))}
        </div>
        <div className={styles.actionRow}>
          {/* One label, every time: planning keeps what a coordinator did by hand (`runPlan`). */}
          <button type="button" className={styles.primary} onClick={runPlan}>
            {planRoutes.plan}
          </button>
          <span className={styles.meta}>{summaryLine(placed, riders.length)}</span>
        </div>
        {/*
          A ramp check the iPad handed this screen: why the plan on screen is not the plan this
          route opens on. It says what the check did and how many children it is about — the
          names are in the lanes and the group above them, which is where somebody acting on one
          of them is already looking — and it offers the plan without it, because a coordinator
          reading a proposal has to be able to see what it is a proposal against.
        */}
        {opened ? (
          <section
            className={styles.arrival}
            data-arrival="true"
            aria-labelledby="arrival-heading"
          >
            <h2 id="arrival-heading" className={styles.arrivalHeading}>
              {rampReplan.bannerHeading}
            </h2>
            {arrivalBannerLines(opened.replan).map((line) => (
              <p key={line} className={styles.arrivalLine}>
                {line}
              </p>
            ))}
            <p className={styles.actionRow}>
              <a href="/plan-preview" className={styles.button}>
                {rampReplan.clear}
              </a>
              <a href="/ramp-preview" className={styles.button}>
                {rampReplan.backToRamp}
              </a>
            </p>
          </section>
        ) : null}
        {decisionsOpen ? <p className={styles.reason}>{planRoutes.nothingSent}</p> : null}
        {/*
          One line for what just happened: a move, or the refusal and what was missing. A
          refusal carries an icon as well as the tone, so it does not read as "this went
          through, in red" (§3: colour is never the cue on its own).
        */}
        <p
          className={styles.notice}
          data-notice="true"
          data-refused={notice?.refused ? "true" : undefined}
          aria-live="polite"
        >
          {notice?.refused ? <Ban size={icon.inline} aria-hidden="true" /> : null}
          {notice?.text ?? planRoutes.dragHint}
        </p>
      </header>

      <div className={styles.split}>
        <div className={styles.column}>
          {/*
            The children in no van, as two groups and one drop zone (Vera's review, 2026-10-17).
            Nobody is in a van on first load, and that is a screen waiting to be asked rather
            than nine things that went wrong — so it is a plain list of names, and the red group
            below it is kept for the children planning could not place. The zone is the wrapper,
            so a rider let go anywhere over either group is a rider taken out of their van.
          */}
          {plan.unplaced.length > 0 ? (
            <div className={styles.noVan} {...dropZone(null)}>
              {blocked.length > 0 ? (
                <section
                  className={styles.unplaced}
                  aria-labelledby="unplaced-heading"
                  data-unplaced="true"
                >
                  <h2 id="unplaced-heading" className={styles.sectionHeading}>
                    {fill(board.groupHeading, {
                      group: planRoutes.unplacedHeading,
                      count: blocked.length,
                    })}
                  </h2>
                  {blocked.map(unplacedRow)}
                </section>
              ) : null}

              {waiting.length > 0 ? (
                <section
                  className={styles.waiting}
                  aria-labelledby="waiting-heading"
                  data-waiting="true"
                >
                  <h2 id="waiting-heading" className={styles.sectionHeading}>
                    {fill(board.groupHeading, {
                      group: planRoutes.waitingHeading,
                      count: waiting.length,
                    })}
                  </h2>
                  {waiting.map((row) =>
                    draggableRider(row.rider, null, waitingBody(row.rider)),
                  )}
                </section>
              ) : null}
            </div>
          ) : null}

          <h2 className={styles.sectionHeading}>
            {fill(board.groupHeading, { group: planRoutes.lanesHeading, count: plan.lanes.length })}
          </h2>
          {/* Said once, over every rider card below: a need is never a diagnosis (§1). */}
          <p className={styles.note}>{planRoutes.needsCaption}</p>
          {plan.lanes.map((lanePlan) => laneSection(lanePlan))}
        </div>

        {/* The map's place on the screen. The live pane lands with live updates; until then this
            says what will be here rather than drawing an empty frame. */}
        <aside className={styles.mapPane} aria-labelledby="map-heading">
          <h2 id="map-heading" className={styles.sectionHeading}>
            {planRoutes.mapHeading}
          </h2>
          <div className={styles.mapBox}>
            <span>{planRoutes.mapPlaceholder}</span>
          </div>
        </aside>
      </div>
    </main>
  );
}
