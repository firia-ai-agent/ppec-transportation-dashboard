"use client";

import { useMemo, useRef, useState } from "react";
import { Car, Locate } from "lucide-react";
import { formatDelta } from "@/domain/eta/eta";
import {
  activeRide,
  matchesQuery,
  type Board,
  type BoardRow,
  type RideView,
} from "@/domain/board/board";
import { board as boardCopy, etaText, fill } from "@/ui/copy";
import { SourceBadge } from "@/ui/SourceBadge";
import { StateChip } from "@/ui/StateChip";
import {
  capabilityStates,
  gpsFreshnessStates,
  legStates,
  type StateDescriptor,
} from "@/ui/states";
import { humanizeAge } from "@/ui/age";
import { clockLabel } from "@/ui/service-date";
import { LegDrawer } from "./LegDrawer";
import styles from "./today.module.css";

/**
 * SURF-01, the board (DESIGN-DIRECTION §4.1).
 *
 * One row per child, grouped needs-action first, with sticky group headers; every state is an
 * icon plus a label, so the board reads in greyscale and colour is only ever the third cue
 * (§3, §9). The rows themselves are computed on the server by src/domain/board — this
 * component chooses words and boxes, and decides nothing about the day.
 *
 * Keyboard (§4.1): J and K move between children and Enter opens one, which is also what the
 * row's own button does, so nothing here is keyboard-only or mouse-only.
 */
export function TodayBoard({
  board,
  query,
  serviceDateLabel,
  serviceDateIso,
}: {
  board: Board;
  query: string;
  serviceDateLabel: string;
  serviceDateIso: string;
}) {
  const [onlyNeedsAction, setOnlyNeedsAction] = useState(false);
  const [openChild, setOpenChild] = useState<string | null>(null);
  const rowRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const matched = useMemo(
    () => board.rows.filter((row) => matchesQuery(row, query)),
    [board.rows, query],
  );
  const visible = onlyNeedsAction ? matched.filter((r) => r.group === "NEEDS_ACTION") : matched;

  const groups = board.groups
    .map((g) => ({ group: g.group, rows: g.rows.filter((r) => visible.includes(r)) }))
    .filter((g) => g.rows.length > 0);

  // Flat row order, so J and K walk the board the way the eye does: down the groups in order.
  const order = groups.flatMap((g) => g.rows);

  const focusRow = (index: number) => {
    const clamped = Math.max(0, Math.min(order.length - 1, index));
    rowRefs.current[clamped]?.focus();
  };

  // Registering from here, not from the row: the list of openers belongs to the board, which
  // is the thing that knows what "the next child" means.
  const registerRow = (index: number) => (el: HTMLButtonElement | null) => {
    rowRefs.current[index] = el;
  };

  const openRow = board.rows.find((r) => r.childKey === openChild) ?? null;

  return (
    <div className={styles.page}>
      <div className={styles.titleRow}>
        <h1 className={styles.heading}>{boardCopy.heading}</h1>
        <p className={styles.date}>
          <span className={styles.dateLabel}>{boardCopy.dateLabel}</span>{" "}
          <time dateTime={serviceDateIso} className="tabularNums">
            {serviceDateLabel}
          </time>
        </p>
      </div>

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
          {fill(boardCopy.showing, { shown: visible.length, total: board.rows.length })}
        </p>
      </div>

      {order.length === 0 ? (
        <p className={styles.empty}>{fill(boardCopy.empty, { date: serviceDateLabel })}</p>
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
                      count: group.rows.length,
                    })}
                  </th>
                </tr>
                {group.rows.map((row) => (
                  <Row
                    key={row.childKey}
                    row={row}
                    index={order.indexOf(row)}
                    register={registerRow(order.indexOf(row))}
                    onMove={focusRow}
                    onOpen={() => setOpenChild(row.childKey)}
                  />
                ))}
              </tbody>
            ))}
          </table>
        </>
      )}

      {openRow ? <LegDrawer row={openRow} onClose={() => setOpenChild(null)} /> : null}
    </div>
  );
}

function Row({
  row,
  index,
  register,
  onMove,
  onOpen,
}: {
  row: BoardRow;
  index: number;
  register: (el: HTMLButtonElement | null) => void;
  onMove: (index: number) => void;
  onOpen: () => void;
}) {
  /*
   * §4.1 writes a row as one AM/PM chip and one state chip, two lines at most — so the row is
   * about the ride that is *happening*, marked AM or PM, and the drawer is where both rides of
   * the day are read side by side. Stacking them here would double every row and bury the van
   * that is moving now under one six hours away.
   */
  const ride = activeRide(row.rides);
  return (
    <tr className={styles.row} data-group={row.group}>
      <th scope="row" className={styles.childCell}>
        <button
          type="button"
          className={styles.openRow}
          ref={register}
          // §9: the eye reads the child's name; the ear is told what the button does with it.
          aria-label={fill(boardCopy.openRow, { child: row.childLabel })}
          onClick={onOpen}
          onKeyDown={(event) => {
            // §4.1: j / k move between children. Enter is the button's own behaviour.
            if (event.key === "j" || event.key === "J") onMove(index + 1);
            else if (event.key === "k" || event.key === "K") onMove(index - 1);
            else return;
            event.preventDefault();
          }}
        >
          <span className="srOnly">{fill(boardCopy.openRow, { child: row.childLabel })}</span>
          <span aria-hidden="true">{row.childLabel}</span>
        </button>
      </th>
      <td>
        <DirectionTag ride={ride} />
      </td>
      <td>
        <StateChip state={legStates[ride.state]} className={styles.cellChip} />
      </td>
      <td>
        <VanCell ride={ride} />
      </td>
      <td>
        <LocationCell ride={ride} />
      </td>
      <td>
        <ArrivingCell ride={ride} />
      </td>
      <td className={styles.hideNarrow}>
        <ReceiverCell row={row} />
      </td>
      <td className={styles.hideNarrow}>{boardCopy.owners[row.nextStep]}</td>
      <td className={styles.hideNarrow}>
        <SourceBadge mode={row.sourceMode} className={styles.cellChip} />
      </td>
    </tr>
  );
}

function DirectionTag({ ride }: { ride: RideView }) {
  return (
    <span className={styles.direction}>
      {ride.direction === "AM" ? boardCopy.am : boardCopy.pm}
    </span>
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

/**
 * The van and what is known about it today.
 *
 * The van's label and its capability chip, and not the provider's name: §1 puts the console at
 * density 7, §4.1 caps a row at two lines, and a provider name is three or four words that
 * would take a third line on every row of a 28-row board. It is one keystroke away in the
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

function LocationCell({ ride }: { ride: RideView }) {
  if (ride.vehicleLabel === null) return <StateChip state={FAMILY_DRIVES} className={styles.cellChip} />;
  if (ride.gpsFreshness === null || ride.gpsAgeSeconds === null) {
    return <StateChip state={NO_POSITION} className={styles.cellChip} />;
  }
  return (
    <span className={styles.van}>
      <StateChip
        state={gpsFreshnessStates[ride.gpsFreshness]}
        values={{ age: humanizeAge(ride.gpsAgeSeconds) }}
        className={styles.cellChip}
      />
      {ride.stoppedSeconds >= 60 ? (
        <span className={styles.stopped}>
          {fill(boardCopy.stopped, { minutes: Math.floor(ride.stoppedSeconds / 60) })}
        </span>
      ) : null}
    </span>
  );
}

/**
 * The window the family holds, and how far today has moved it. A paused window still shows the
 * window — never hide data (§4.1) — and says the texts about it have stopped (LOC-03).
 */
function ArrivingCell({ ride }: { ride: RideView }) {
  const { windowText, deltaSeconds } = ride;
  if (windowText === null) {
    return <span className={styles.muted}>{etaText.pending}</span>;
  }
  const delta = deltaSeconds === null ? null : formatDelta(deltaSeconds);
  return (
    <span className={styles.arriving}>
      <span className="tabularNums">
        {ride.etaPaused ? fill(etaText.paused, { window: windowText }) : windowText}
      </span>
      {delta !== null && deltaSeconds !== null && delta !== etaText.onTime ? (
        <span className={styles.delta} data-late={deltaSeconds > 0}>
          {delta}
        </span>
      ) : null}
    </span>
  );
}

function ReceiverCell({ row }: { row: BoardRow }) {
  return (
    <span className={styles.receiver}>
      <span data-missing={!row.receivingAdultOnFile}>
        {row.receivingAdultOnFile ? boardCopy.receiverOnFile : boardCopy.noReceiver}
      </span>
      {row.therapy ? (
        <span className={styles.muted}>
          {fill(boardCopy.therapyAt, {
            time: clockLabel(row.therapy.startsAt),
            therapist: row.therapy.therapist,
          })}
        </span>
      ) : null}
    </span>
  );
}
