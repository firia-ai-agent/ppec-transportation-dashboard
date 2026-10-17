"use client";

import { useMemo, useRef, useState } from "react";
import {
  ArrowDownRight,
  ArrowUpRight,
  Car,
  CirclePause,
  Clock,
  Hand,
  Locate,
  UserCheck,
} from "lucide-react";
import { formatDelta } from "@/domain/eta/eta";
import {
  matchesQuery,
  type Board,
  type DayPhase,
  type LegRow,
  type RideView,
} from "@/domain/board/board";
import { board as boardCopy, etaText, fill, serviceDate } from "@/ui/copy";
import { SourceBadge } from "@/ui/SourceBadge";
import { StateChip } from "@/ui/StateChip";
import {
  capabilityStates,
  gpsFreshnessStates,
  legStates,
  therapySessionStates,
  type StateDescriptor,
} from "@/ui/states";
import { humanizeAge } from "@/ui/age";
import { clockLabel } from "@/ui/service-date";
import { icon } from "@/ui/tokens";
import { LegDrawer } from "./LegDrawer";
import { nextStepCellText, stateValues } from "./next-step";
import styles from "./today.module.css";

/**
 * SURF-01, the board (DESIGN-DIRECTION §4.1).
 *
 * One row per child and ride, grouped needs-action first, with sticky group headers. Dense rows
 * and no cards: 56 rides on one screen is the point of the surface, and a card would spend a
 * third of the width on padding. Every state is an icon plus a label — the ride's state, the
 * van's check, the van's location, the window that is not worked out yet, the shift that has
 * moved, the stall, the receiver, the therapy session — so the board reads in greyscale and
 * colour is only ever the third cue (§3, §9).
 *
 * The rows themselves are computed on the server by src/domain/board; this component chooses
 * words and boxes, and decides nothing about the day.
 *
 * Keyboard (§4.1): J and K move between rides and Enter opens one, which is also what the row's
 * own button does, so nothing here is keyboard-only or mouse-only.
 */
export function TodayBoard({ board, query }: { board: Board; query: string }) {
  const { day } = board;
  const [onlyNeedsAction, setOnlyNeedsAction] = useState(false);
  const [openChild, setOpenChild] = useState<string | null>(null);
  const rowRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const matched = useMemo(
    () => board.legs.filter((leg) => matchesQuery(leg, query)),
    [board.legs, query],
  );
  const visible = onlyNeedsAction ? matched.filter((l) => l.group === "NEEDS_ACTION") : matched;

  const groups = board.groups
    .map((g) => ({ group: g.group, legs: g.legs.filter((l) => visible.includes(l)) }))
    .filter((g) => g.legs.length > 0);

  // Flat row order, so J and K walk the board the way the eye does: down the groups in order.
  const order = groups.flatMap((g) => g.legs);

  const focusRow = (index: number) => {
    const clamped = Math.max(0, Math.min(order.length - 1, index));
    rowRefs.current[clamped]?.focus();
  };

  // Registering from here, not from the row: the list of openers belongs to the board, which
  // is the thing that knows what "the next ride" means.
  const registerRow = (index: number) => (el: HTMLButtonElement | null) => {
    rowRefs.current[index] = el;
  };

  // The drawer is per child: its two rows are the one day it reads.
  const openLegs = board.legs.filter((l) => l.child.childKey === openChild);

  return (
    <div className={styles.page}>
      {/*
        The board's own header: one date, and which day that is (Vera's final call). The date is
        read, never changed — there is no switcher, because the only day this build replays is
        the demo day, and a control offering another one would promise a day the demo does not
        have. The heading says "Today" on the day that is true of and names the day on any
        other, because a board of finished rides under "Today" would be the one false sentence
        on the screen.
      */}
      <header className={styles.titleRow}>
        <h1 className={styles.heading}>
          {day.phase === "LIVE"
            ? boardCopy.heading
            : fill(boardCopy.headingOtherDay, { date: day.label })}
        </h1>
        <p className={styles.date}>
          <span className={styles.dateLabel}>{serviceDate.groupLabel}</span>{" "}
          <time dateTime={day.iso} className="tabularNums">
            {day.label}
          </time>{" "}
          {/* Which kind of day this is — on the demo day, that it is the demo day and not today. */}
          <span className={styles.phase}>{serviceDate.phases[day.phase]}</span>
        </p>
      </header>

      <div className={styles.filters}>
        <button
          type="button"
          role="switch"
          aria-checked={onlyNeedsAction}
          className={styles.toggle}
          onClick={() => setOnlyNeedsAction((on) => !on)}
        >
          {fill(boardCopy.groupHeading, {
            group: boardCopy.onlyNeedsAction,
            count: board.needsActionCount,
          })}
        </button>
        {query.length > 0 ? (
          <span className={styles.searchEcho}>
            {fill(boardCopy.searchedFor, { query })}{" "}
            <a href="/today">{boardCopy.clearSearch}</a>
          </span>
        ) : null}
        <p className={styles.showing}>
          {fill(boardCopy.showing, { shown: visible.length, total: board.legs.length })}
        </p>
      </div>

      {order.length === 0 ? (
        <p className={styles.empty}>
          {emptyLine({ query, onlyNeedsAction, date: day.label, rides: board.legs.length })}
        </p>
      ) : (
        <>
          <p className={styles.hint}>{boardCopy.keyboardHint}</p>
          <table className={styles.table}>
            <caption className="srOnly">{boardCopy.tableLabel}</caption>
            <colgroup>
              <col className={styles.colChild} />
              <col className={styles.colRide} />
              <col className={styles.colState} />
              <col className={styles.colVan} />
              <col className={styles.colLocation} />
              <col className={styles.colEta} />
              <col className={styles.colReceiver} />
              <col className={styles.colNextStep} />
              <col className={styles.colSource} />
            </colgroup>
            <thead>
              <tr>
                <th scope="col">{boardCopy.columns.child}</th>
                <th scope="col">{boardCopy.columns.ride}</th>
                <th scope="col">{boardCopy.columns.state}</th>
                <th scope="col">{boardCopy.columns.vehicle}</th>
                <th scope="col">{boardCopy.columns.gps}</th>
                <th scope="col">{boardCopy.columns.eta}</th>
                <th scope="col" className={styles.hideNarrow}>
                  {boardCopy.columns.receiver}
                </th>
                <th scope="col" className={styles.hideNarrow}>
                  {boardCopy.columns.nextStep}
                </th>
                <th scope="col" className={styles.hideNarrow}>
                  {boardCopy.columns.source}
                </th>
              </tr>
            </thead>
            {groups.map((group) => (
              <tbody key={group.group}>
                <tr className={styles.groupRow}>
                  <th scope="colgroup" colSpan={9} className={styles.groupHeader}>
                    {fill(boardCopy.groupHeading, {
                      group: boardCopy.groups[group.group],
                      count: group.legs.length,
                    })}
                  </th>
                </tr>
                {group.legs.map((leg) => (
                  <Row
                    key={leg.key}
                    leg={leg}
                    phase={day.phase}
                    index={order.indexOf(leg)}
                    register={registerRow(order.indexOf(leg))}
                    onMove={focusRow}
                    onOpen={() => setOpenChild(leg.child.childKey)}
                  />
                ))}
              </tbody>
            ))}
          </table>
        </>
      )}

      {openLegs.length > 0 ? (
        <LegDrawer legs={openLegs} onClose={() => setOpenChild(null)} />
      ) : null}
    </div>
  );
}

/**
 * Which "nothing here" this is.
 *
 * Three different facts, and a board that said "No rides scheduled" to a filter that is hiding
 * everything would be telling a coordinator the day is empty when it is not. Each line ends in
 * the one thing to do about it, which for two of the three is undoing what they just did.
 */
function emptyLine({
  query,
  onlyNeedsAction,
  date,
  rides,
}: {
  query: string;
  onlyNeedsAction: boolean;
  date: string;
  rides: number;
}): string {
  if (rides === 0) return fill(boardCopy.empty, { date });
  if (query.trim().length > 0) return fill(boardCopy.emptySearch, { query });
  if (onlyNeedsAction) return boardCopy.emptyNeedsAction;
  return fill(boardCopy.empty, { date });
}

function Row({
  leg,
  phase,
  index,
  register,
  onMove,
  onOpen,
}: {
  leg: LegRow;
  /** Which kind of day this row is on: a finished day has no live van to locate. */
  phase: DayPhase;
  index: number;
  register: (el: HTMLButtonElement | null) => void;
  onMove: (index: number) => void;
  onOpen: () => void;
}) {
  const { child, ride } = leg;
  const opener = fill(boardCopy.openRow, {
    child: child.childLabel,
    ride: ride.direction === "AM" ? boardCopy.amSpoken : boardCopy.pmSpoken,
  });
  return (
    <tr className={styles.row} data-group={leg.group}>
      <th scope="row" className={styles.childCell}>
        <button
          type="button"
          className={styles.openRow}
          ref={register}
          // §9: the eye reads the child's name; the ear is told what the button does with it,
          // and which of the child's two rides this row is.
          aria-label={opener}
          onClick={onOpen}
          onKeyDown={(event) => {
            // §4.1: j / k move between rides. Enter is the button's own behaviour.
            if (event.key === "j" || event.key === "J") onMove(index + 1);
            else if (event.key === "k" || event.key === "K") onMove(index - 1);
            else return;
            event.preventDefault();
          }}
        >
          <span className="srOnly">{opener}</span>
          <span aria-hidden="true">{child.childLabel}</span>
        </button>
      </th>
      <td>
        <span className={styles.direction}>
          {ride.direction === "AM" ? boardCopy.am : boardCopy.pm}
        </span>
      </td>
      <td>
        <StateChip
          state={legStates[ride.state]}
          values={stateValues(leg)}
          className={styles.cellChip}
        />
      </td>
      <td>
        <VanCell ride={ride} />
      </td>
      <td>
        <LocationCell ride={ride} phase={phase} />
      </td>
      <td>
        <ArrivingCell ride={ride} />
      </td>
      <td className={styles.hideNarrow}>
        <ReceiverCell leg={leg} />
      </td>
      <td className={styles.hideNarrow}>
        <NextStepCell leg={leg} />
      </td>
      <td className={styles.hideNarrow}>
        <SourceBadge mode={child.sourceMode} className={styles.cellChip} />
      </td>
    </tr>
  );
}

/**
 * A ride the family drives has no van and no capability to report, and saying so is not the
 * same as leaving the cell blank: a blank cell reads as missing data (COPY-GUIDE §1).
 */
const FAMILY_DRIVES: StateDescriptor = {
  icon: Car,
  label: boardCopy.familyDrives,
  tone: "neutral",
};

/**
 * A vehicle that has never sent a position we may draw — an unlinked device (LOC-01, ADR-013).
 * Deliberately not one of the four §3 GPS bands: those describe a position that exists, and
 * "No signal" would claim one did.
 */
const NO_POSITION: StateDescriptor = {
  icon: Locate,
  label: boardCopy.noPosition,
  tone: "neutral",
};

/** The same column on a day that is over: this slice keeps no position history. */
const NO_POSITION_KEPT: StateDescriptor = {
  icon: Locate,
  label: boardCopy.noPositionRecorded,
  tone: "neutral",
};

/**
 * No arrival window at all: a ride on a van whose run has no committed geometry.
 *
 * It used to be every afternoon row on the board, because the afternoon had no geometry to be
 * planned from (src/fixtures/run-routes.ts is now that geometry, read out of the scenario
 * itself). Nothing in the committed scenario reaches this any more, and it stays because the
 * honest answer to "when does this ride arrive" is sometimes "nobody has worked that out" — and
 * a blank cell says it is missing data instead (§3, §9).
 */
const WINDOW_PENDING: StateDescriptor = {
  icon: Clock,
  label: boardCopy.windowPending,
  tone: "neutral",
};

/** §5.1: a stall is words and a clock, never a colour — so neutral, with the minutes in it. */
const STOPPED: StateDescriptor = {
  icon: CirclePause,
  label: boardCopy.stopped,
  tone: "neutral",
};

/** TRP-02: the adult on file who may receive this child, named — or nobody, which is urgent. */
const RECEIVER_NAMED: StateDescriptor = {
  icon: UserCheck,
  label: boardCopy.receiverNamed,
  tone: "ok",
};

const RECEIVER_MISSING: StateDescriptor = {
  icon: Hand,
  label: boardCopy.noReceiver,
  tone: "crit",
};

/**
 * The van and what is known about it today.
 *
 * The van's label and its capability chip, and not the provider's name: §1 puts the console at
 * density 7, §4.1 caps a row at two lines, and a provider name is three or four words that
 * would take a third line on every row of a 56-row board. It is one keystroke away in the
 * drawer, and the §2 search still finds a child by their provider.
 */
function VanCell({ ride }: { ride: RideView }) {
  if (ride.vehicleLabel === null) return <StateChip state={FAMILY_DRIVES} className={styles.cellChip} />;
  return (
    <span className={styles.van}>
      <span className={styles.vanName}>{ride.vehicleLabel}</span>
      <StateChip state={capabilityStates[ride.capability]} className={styles.cellChip} />
    </span>
  );
}

function LocationCell({ ride, phase }: { ride: RideView; phase: DayPhase }) {
  if (ride.vehicleLabel === null) return <StateChip state={FAMILY_DRIVES} className={styles.cellChip} />;
  if (ride.gpsFreshness === null || ride.gpsAgeSeconds === null) {
    // "…yet" is a promise, and only a day that has not been driven can keep it.
    const state = phase === "ENDED" ? NO_POSITION_KEPT : NO_POSITION;
    return <StateChip state={state} className={styles.cellChip} />;
  }
  return (
    <span className={styles.van}>
      <StateChip
        state={gpsFreshnessStates[ride.gpsFreshness]}
        values={{ age: humanizeAge(ride.gpsAgeSeconds) }}
        className={styles.cellChip}
      />
      {ride.stoppedSeconds >= 60 ? (
        <StateChip
          state={STOPPED}
          values={{ minutes: Math.floor(ride.stoppedSeconds / 60) }}
          className={styles.cellChip}
        />
      ) : null}
    </span>
  );
}

/**
 * The window the family holds, and how far today has moved it. A paused window still shows the
 * window — never hide data (§4.1) — and says the texts about it have stopped (LOC-03). The
 * shift carries the §3 arrow, so "later than planned" is readable without the warn tone.
 */
function ArrivingCell({ ride }: { ride: RideView }) {
  const { windowText, deltaSeconds } = ride;
  if (windowText === null) {
    // A ride with no van has no arrival to publish: the family brings the child, at the time
    // the plan says, and that is the whole answer to this column.
    if (ride.vehicleLabel === null) {
      return <StateChip state={FAMILY_DRIVES} className={styles.cellChip} />;
    }
    return <StateChip state={WINDOW_PENDING} className={styles.cellChip} />;
  }
  const delta = deltaSeconds === null ? null : formatDelta(deltaSeconds);
  const late = deltaSeconds !== null && deltaSeconds > 0;
  const Arrow = late ? ArrowUpRight : ArrowDownRight;
  return (
    <span className={styles.arriving}>
      <span className="tabularNums">
        {ride.etaPaused ? fill(etaText.paused, { window: windowText }) : windowText}
      </span>
      {delta !== null && deltaSeconds !== null && delta !== etaText.onTime ? (
        <span className={styles.delta} data-late={late}>
          <Arrow size={icon.chip} aria-hidden="true" />
          {delta}
        </span>
      ) : null}
    </span>
  );
}

/**
 * Who receives the child, and the therapy session that half of the day holds.
 *
 * The receiver is a fact about the child's day rather than about one ride, so it is on both of
 * the child's rows: AT-13 is the rule that staff see a missing receiving adult in the morning,
 * not at the kerb in the afternoon. The step that fixes it still belongs to the afternoon ride,
 * which is the one it stops.
 */
function ReceiverCell({ leg }: { leg: LegRow }) {
  const { child, ride } = leg;
  const therapy = child.therapy?.direction === ride.direction ? child.therapy : null;
  return (
    <span className={styles.receiver}>
      <StateChip
        state={child.receivingAdult === null ? RECEIVER_MISSING : RECEIVER_NAMED}
        values={child.receivingAdult === null ? undefined : { adult: child.receivingAdult.name }}
        className={styles.cellChip}
      />
      {therapy ? (
        <span className={styles.therapy}>
          <StateChip state={therapySessionStates.SCHEDULED} className={styles.cellChip} />
          <span className={styles.muted}>
            {fill(boardCopy.therapyAt, {
              time: clockLabel(therapy.startsAt),
              therapist: therapy.therapist,
            })}
          </span>
        </span>
      ) : null}
    </span>
  );
}

/** The one thing to do next: a verb, and the name of the child it is done for. */
function NextStepCell({ leg }: { leg: LegRow }) {
  return (
    <span className={styles.nextStep} data-step={leg.nextStep}>
      {nextStepCellText(leg)}
    </span>
  );
}
