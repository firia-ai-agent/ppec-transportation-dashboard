"use client";
/**
 * Plan routes (PRD B-09 VEH-01…05, B-13; DESIGN-DIRECTION §4.1; copy COPY-GUIDE §5).
 *
 * One lane per van: what the van has today, how many places are taken, and the children in it
 * as stops in the order they are driven. Children in no van are at the top of the screen, each
 * with one plain sentence saying what is missing. The map's place is beside the lanes and says
 * what will be there; the live pane lands with live updates.
 *
 * Every verdict on this screen is the capacity solver's (src/domain/solver): "Plan routes" runs
 * the planner, a drag re-asks it, a substitution re-asks it, and an arrival report re-asks it.
 * Nothing is placed by a rule of thumb the four constraints did not agree with, and nothing is
 * assigned, locked or sent — a coordinator approves a plan, and the family hears nothing before
 * that (AT-12).
 *
 * Client state and fixtures only: no database, no API, no routing provider and no map tiles, so
 * the screen makes no network request of its own at all (TEST-SEC-02). Words come from
 * src/ui/copy.ts and colours and metrics from the tokens in src/ui/tokens.ts; the DEMO banner
 * and the one source chip come from the root layout, so this page must not mount a second pair.
 */
import { useMemo, useState } from "react";
import { Ban, Check } from "lucide-react";
import {
  PLAN_SERVICE_DATE,
  RELIEF_DRIVERS,
  SPARE_VEHICLE_KEYS,
  asMeasured,
  askedProvider,
  checkedAtRamp,
  driverFor,
  notCheckedYet,
  planLanes,
  planRiders,
  reportedByProvider,
  substituted,
  unapprovedNeeds,
  vehicleByKey,
} from "@/domain/plan/day";
import {
  canTake,
  planAssignment,
  routePlan,
  withMove,
  type Assignment,
  type DailyCapability,
  type Direction,
  type LanePlan,
  type PlanInput,
  type PlanLane,
  type PlanRider,
  type ResolutionOption,
  type Unplaced,
} from "@/domain/solver";
import { board, fill, needCategories, places, planRoutes, rampPreview } from "@/ui/copy";
import { serviceDateLabel } from "@/ui/service-date";
import { StateChip } from "@/ui/StateChip";
import { icon } from "@/ui/tokens";
import {
  ARRIVAL_ANSWERS,
  ARRIVAL_LABEL,
  equipmentChips,
  laneLines,
  laneState,
  needChips,
  needsADecision,
  reasonLine,
  refusalLine,
  setUpAsLine,
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
};

/**
 * The service date the scenario replays, as "Tue, Oct 14". Read at noon UTC so the site
 * timezone (America/New_York) lands on the calendar day the fixture names.
 */
const SERVICE_DATE_LABEL = serviceDateLabel(new Date(`${PLAN_SERVICE_DATE}T12:00:00Z`));

/** The day's lanes as the scenario hands them over, before anything has been planned. */
const BASE_LANES = planLanes();

function initialStages(): Record<string, LaneStage> {
  return Object.fromEntries(
    BASE_LANES.map((lane) => [
      lane.id,
      { vehicleKey: lane.vehicle.id, driverName: lane.driverName, arrival: "REPORTED" as const },
    ]),
  );
}

function emptyAssignment(): Assignment {
  return Object.fromEntries(BASE_LANES.map((lane) => [lane.id, []]));
}

function capabilityOf(stage: LaneStage): DailyCapability {
  switch (stage.arrival) {
    case "NOT_CHECKED":
      return notCheckedYet(stage.vehicleKey);
    case "CHANGED":
      return substituted(stage.vehicleKey);
    case "ASKED":
      return askedProvider(stage.vehicleKey);
    case "RAMP_CHECKED":
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

export default function PlanRoutes() {
  const [direction, setDirection] = useState<Direction>("AM");
  const [stages, setStages] = useState<Record<string, LaneStage>>(initialStages);
  const [assignment, setAssignment] = useState<Assignment>(emptyAssignment);
  /** Children whose chair the ramp has measured, which is AT-04's whole lever. */
  const [measured, setMeasured] = useState<readonly string[]>([]);
  const [moving, setMoving] = useState<string | null>(null);
  const [substituting, setSubstituting] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; refused: boolean } | null>(null);

  const riders = useMemo<PlanRider[]>(
    () =>
      planRiders(direction).map((rider) =>
        measured.includes(rider.child.token) ? asMeasured(rider) : rider,
      ),
    [direction, measured],
  );

  const lanes = useMemo<PlanLane[]>(
    () =>
      BASE_LANES.map((lane) => {
        const stage = stages[lane.id];
        return {
          id: lane.id,
          vehicle: vehicleByKey(stage.vehicleKey),
          capability: capabilityOf(stage),
          driverName: stage.driverName,
        };
      }),
    [stages],
  );

  const input: PlanInput = useMemo(
    () => ({ direction, centerLabel: places.center, lanes, riders }),
    [direction, lanes, riders],
  );
  const plan = useMemo(() => routePlan(input, assignment), [input, assignment]);

  const placed = plan.lanes.reduce((n, lane) => n + lane.riders.length, 0);
  const decisionsOpen = needsADecision(plan.lanes, plan.unplaced);

  /* ───────────────────────────── the actions ───────────────────────────── */

  const runPlan = () => {
    setAssignment(planAssignment(input));
    setMoving(null);
    setNotice(null);
  };

  const chooseDirection = (next: Direction) => {
    if (next === direction) return;
    // A plan belongs to one run: the morning's lanes are not the afternoon's, and carrying the
    // assignment across would show a plan nobody made for the run on screen.
    setDirection(next);
    setAssignment(emptyAssignment());
    setMoving(null);
    setNotice(null);
  };

  /**
   * Move a child into a lane, or out of every lane. The solver decides: a lane that cannot take
   * the child refuses, the assignment does not change at all, and one line says who and what is
   * missing.
   */
  const move = (childToken: string, laneId: string | null) => {
    setMoving(null);
    const rider = riders.find((r) => r.child.token === childToken);
    if (!rider) return;
    if (laneId === null) {
      setAssignment(withMove(assignment, childToken, null));
      setNotice({
        text: fill(planRoutes.movedOut, { child: rider.child.displayName }),
        refused: false,
      });
      return;
    }
    const lane = lanes.find((l) => l.id === laneId);
    if (!lane) return;
    const check = canTake(input, assignment, laneId, childToken);
    if (!check.ok) {
      setNotice({ text: refusalLine(lane.vehicle, rider.child, check.cause), refused: true });
      return;
    }
    setAssignment(withMove(assignment, childToken, laneId));
    setNotice({
      text: fill(planRoutes.moved, { child: rider.child.displayName, vehicle: lane.vehicle.label }),
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
        vehicle: replacement.label,
        previous: previous.label,
        driver: driverName,
      }),
      refused: false,
    });
  };

  const substituteDriver = (laneId: string, driverName: string) => {
    const vehicle = vehicleByKey(stages[laneId].vehicleKey);
    // A different person at the wheel changes nothing about what the van can carry, so the
    // capability observation is left exactly as it was.
    setStages((prev) => ({ ...prev, [laneId]: { ...prev[laneId], driverName } }));
    setSubstituting(null);
    setNotice({
      text: fill(planRoutes.substitutedDriver, { driver: driverName, vehicle: vehicle.label }),
      refused: false,
    });
  };

  const askProvider = (lane: PlanLane) => {
    setStages((prev) => ({ ...prev, [lane.id]: { ...prev[lane.id], arrival: "ASKED" } }));
    setNotice({
      text: fill(planRoutes.asked, {
        provider: lane.vehicle.providerName,
        vehicle: lane.vehicle.label,
      }),
      refused: false,
    });
  };

  const recordAnswer = (lane: PlanLane) => {
    setStages((prev) => ({ ...prev, [lane.id]: { ...prev[lane.id], arrival: "REPORTED" } }));
    setNotice({
      text: fill(planRoutes.answered, {
        provider: lane.vehicle.providerName,
        vehicle: lane.vehicle.label,
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

  /** A lane, or the group at the top, as somewhere a dragged rider can be dropped. */
  const dropZone = (laneId: string | null) => ({
    "data-over": over === (laneId ?? "none") ? "true" : undefined,
    onDragOver: (event: React.DragEvent) => {
      event.preventDefault();
      setOver(laneId ?? "none");
    },
    onDragLeave: () => setOver(null),
    onDrop: (event: React.DragEvent) => {
      event.preventDefault();
      setOver(null);
      const token = event.dataTransfer.getData("text/plain");
      if (token) move(token, laneId);
    },
  });

  const optionList = (heading: string, options: readonly ResolutionOption[]) => (
    <div>
      <h4 className={styles.menuHeading}>{heading}</h4>
      <ol className={styles.optionList}>
        {options.map((option) => (
          <li key={option.id} className={styles.option}>
            <span>{fill(planRoutes.optionRow, { label: option.label, detail: option.detail })}</span>
            <span className={styles.chip}>{planRoutes.needsApproval}</span>
          </li>
        ))}
      </ol>
      <p className={styles.note}>{planRoutes.optionsNote}</p>
    </div>
  );

  /**
   * The keyboard's way to do what a drag does (§9: nothing on this screen is mouse-only). It
   * lists the lanes by name, so the choice is "Move to V2" rather than a target to aim at.
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
              label={fill(planRoutes.moveTo, { vehicle: lane.vehicle.label })}
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
        <p className={styles.meta}>{planRoutes.needsCaption}</p>
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
   * A rider row. `data-rider` is how the browser check finds one child's row to drag it, and
   * `data-verdict` on a lane is how it compares what the solver said with what the lane shows —
   * the words are chosen for a coordinator and are deliberately not machine-readable. Nothing
   * on the screen depends on either attribute.
   */
  const draggableRider = (rider: PlanRider, laneId: string | null) => (
    <div
      key={rider.child.token}
      className={styles.draggable}
      data-rider={rider.child.displayName}
      draggable
      onDragStart={(event) => event.dataTransfer.setData("text/plain", rider.child.token)}
    >
      {riderBody(rider, laneId)}
    </div>
  );

  const laneSection = (lanePlan: LanePlan) => {
    const { lane, seats, verdict } = lanePlan;
    const stage = stages[lane.id];
    const headingId = `lane-${lane.id}`;
    const state = laneState(lanePlan);
    const spares = SPARE_VEHICLE_KEYS.filter((key) => key !== stage.vehicleKey);
    const laneIndex = BASE_LANES.findIndex((l) => l.id === lane.id);
    const lastStop = lanePlan.leg.stops.length;

    return (
      <section
        key={lane.id}
        className={styles.lane}
        aria-labelledby={headingId}
        data-lane={lane.id}
        data-verdict={verdict.status}
        {...dropZone(lane.id)}
      >
        <div className={styles.laneTitleRow}>
          <h3 id={headingId} className={styles.laneTitle}>
            {fill(planRoutes.vanTile, {
              vehicle: lane.vehicle.label,
              description: lane.vehicle.description,
            })}
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
        <ul className={styles.chips} aria-label={planRoutes.equipmentHeading}>
          {equipmentChips(lane.vehicle, lanePlan.layout, lane.capability, {
            wc: seats.wcAvailable,
            amb: seats.ambAvailable,
            tether: seats.tetherAvailable,
          }).map((text) => (
            <li key={text} className={styles.chip}>
              {text}
            </li>
          ))}
        </ul>
        <ul className={styles.chips}>
          <li className={styles.chip}>
            {fill(planRoutes.seatsWc, { used: seats.wcUsed, available: seats.wcAvailable })}
          </li>
          <li className={styles.chip}>
            {fill(planRoutes.seatsAmb, { used: seats.ambUsed, available: seats.ambAvailable })}
          </li>
          <li className={styles.chip}>
            {fill(planRoutes.seatsTether, {
              used: seats.tetherUsed,
              available: seats.tetherAvailable,
            })}
          </li>
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
                  stopRiders.map((rider) => draggableRider(rider, lane.id))
                )}
              </li>
            );
          })}
        </ol>

        <div className={styles.rowActions} role="group" aria-label={planRoutes.arrivalHeading}>
          <span className={styles.menuHeading}>{planRoutes.arrivalHeading}</span>
          {ARRIVAL_ANSWERS.map((answer) => (
            <Button
              key={answer}
              label={ARRIVAL_LABEL[answer]}
              pressed={stage.arrival === answer}
              onClick={() => answerArrival(lanePlan, answer)}
            />
          ))}
        </div>

        {stage.arrival === "CHANGED" ? (
          <div className={styles.rowActions}>
            <Button label={planRoutes.askProvider} onClick={() => askProvider(lane)} />
          </div>
        ) : null}
        {stage.arrival === "ASKED" ? (
          <div className={styles.rowActions}>
            <Button label={planRoutes.recordAnswer} onClick={() => recordAnswer(lane)} />
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
                      vehicle: spare.label,
                      description: spare.description,
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

        {verdict.options.length > 0 ? optionList(planRoutes.laneOptionsHeading, verdict.options) : null}
      </section>
    );
  };

  const unplacedRow = (unplaced: Unplaced) => {
    const vehicleLabel = unplaced.laneId
      ? (lanes.find((l) => l.id === unplaced.laneId)?.vehicle.label ?? "")
      : "";
    return (
      <div key={unplaced.rider.child.token} className={styles.unplacedRow}>
        <div className={styles.riderRow}>
          <StateChip state={unplacedState(unplaced.cause)} />
          <p className={styles.reason}>{reasonLine(unplaced, vehicleLabel)}</p>
        </div>
        {draggableRider(unplaced.rider, null)}
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
          <button type="button" className={styles.primary} onClick={runPlan}>
            {placed > 0 ? planRoutes.planAgain : planRoutes.plan}
          </button>
          <span className={styles.meta}>{summaryLine(placed, riders.length)}</span>
        </div>
        <p className={styles.note}>{planRoutes.localOnly}</p>
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
          {plan.unplaced.length > 0 ? (
            <section
              className={styles.unplaced}
              aria-labelledby="unplaced-heading"
              data-unplaced="true"
              {...dropZone(null)}
            >
              <h2 id="unplaced-heading" className={styles.sectionHeading}>
                {fill(board.groupHeading, {
                  group: planRoutes.unplacedHeading,
                  count: plan.unplaced.length,
                })}
              </h2>
              {plan.unplaced.map(unplacedRow)}
            </section>
          ) : null}

          <h2 className={styles.sectionHeading}>
            {fill(board.groupHeading, { group: planRoutes.lanesHeading, count: plan.lanes.length })}
          </h2>
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
