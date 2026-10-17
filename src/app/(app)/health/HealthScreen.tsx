"use client";

import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { Board, LegRow } from "@/domain/board/board";
import {
  BASELINE_ROWS,
  ridesBehind,
  type DayCounts,
  type RoiMetric,
  type RoiMetricKey,
} from "@/domain/health/metrics";
import type { AdapterHealth, AdapterStatus } from "@/domain/health/adapters";
import { board as boardCopy, fill, health, nav, serviceDate, vanName } from "@/ui/copy";
import { StateChip } from "@/ui/StateChip";
import { legStates } from "@/ui/states";
import { icon } from "@/ui/tokens";
import { LegDrawer } from "../today/LegDrawer";
import { nextStepCellText, stateValues } from "../today/next-step";
import {
  adapterDegraded,
  adapterDoing,
  adapterMockedBecause,
  adapterModeChip,
  adapterName,
  metricLabel,
  metricLine,
  metricValue,
  metricWhy,
  ridesHeading,
} from "./lines";
import styles from "./health.module.css";

/**
 * Health & ROI — SURF-07's numbers and SURF-06's adapter panel on one screen
 * (DESIGN-DIRECTION §4.6, PRD §14 l.1063–1064).
 *
 * Four numbers and three rows, and every one of them is computed: the numbers by
 * src/domain/health/metrics over the same board `/today` renders, the rows by
 * src/domain/health/adapters over this deployment's own configuration. There is no figure on
 * this screen that a module did not count, which is the only thing that makes a screenshot of a
 * ROI panel worth anything.
 *
 * Three design rules the review fixed, and each one is visible in the markup below:
 *
 *  - **Every number opens the rides behind it** (AT-15: instrumentation *with drill-down*). A
 *    tile is a button; it expands into the rides it was counted from; each ride opens the same
 *    child drawer the board opens — the component, not a copy of it, so the panel and the board
 *    cannot drift apart.
 *  - **One watermark, no charts.** §4.6 asks for a diagonal SYNTHETIC watermark on every chart,
 *    and the honest answer to a four-number panel is one watermark across the numbers and no
 *    chart at all: a bar chart of four counts is decoration, and decoration on a ROI panel is
 *    where a reader starts trusting a trend nobody measured.
 *  - **No duplicate tile.** The numbers are four counts with four different drill-downs; the
 *    adapter panel below them is not a second row of counts.
 *  - **What is not measured says so, in words.** `BaselineRows` puts hours saved and money
 *    saved on the screen with no figure at all (PRD §17.4). They sit under the counted numbers
 *    rather than among them, so the page still leads with what today was actually measured on.
 *
 * The DEMO bar and the one source chip come from the root layout, on every route, so this screen
 * must not mount a second pair — and it holds nothing violet of its own.
 */
export function HealthScreen({
  board,
  counts,
  adapters,
}: {
  board: Board;
  counts: DayCounts;
  adapters: AdapterHealth;
}) {
  const { day } = board;
  /** Which number is open, if any. One at a time: this is a way into the rides, not a report. */
  const [openMetric, setOpenMetric] = useState<RoiMetricKey | null>(null);
  const [openChild, setOpenChild] = useState<string | null>(null);

  const open = counts.metrics.find((m) => m.key === openMetric) ?? null;
  const openRides = open === null ? [] : ridesBehind(board, open);
  // The drawer is per child, and it reads the child's whole day — both rides, as the board has
  // them — even when the number that led here counted only one of the two.
  const drawerLegs = board.legs.filter((l) => l.child.childKey === openChild);

  return (
    <div className={styles.page}>
      <header className={styles.titleRow}>
        <h1 className={styles.heading}>{nav.health}</h1>
        <p className={styles.date}>
          <span className={styles.dateLabel}>{serviceDate.groupLabel}</span>{" "}
          <time dateTime={day.iso} className="tabularNums">
            {day.label}
          </time>{" "}
          <span className={styles.phase}>{serviceDate.phases[day.phase]}</span>
        </p>
      </header>
      <p className={styles.intro}>{health.intro}</p>

      <section className={styles.panel} aria-labelledby="roi-heading">
        <h2 id="roi-heading" className={styles.panelHeading}>
          {health.roiHeading}
        </h2>
        {/*
          The one watermark (§4.6). `aria-hidden`, because the ear is already told: the DEMO bar
          and the Simulated source chip in the root layout both announce it, and a third
          announcement of the same fact is noise. It is drawn behind the numbers and takes no
          pointer events, so it cannot swallow a click meant for a tile.
        */}
        <p className={styles.watermark} aria-hidden="true">
          {health.watermark}
        </p>
        <ul className={styles.tiles}>
          {counts.metrics.map((metric) => (
            <Tile
              key={metric.key}
              metric={metric}
              open={metric.key === openMetric}
              onToggle={() =>
                setOpenMetric((current) => (current === metric.key ? null : metric.key))
              }
            />
          ))}
        </ul>
        {/* SURF-07: the sample size and the confidence note, under the numbers they qualify. */}
        <p className={styles.sampleNote}>
          {fill(health.sampleNote, { children: counts.children, rides: counts.rides })}
        </p>
      </section>

      {open === null ? null : (
        <section className={styles.panel} id="rides-behind" aria-labelledby="rides-heading">
          <h2 id="rides-heading" className={styles.panelHeading}>
            {ridesHeading(open)}
          </h2>
          {openRides.length === 0 ? (
            <p className={styles.muted}>{health.noRides}</p>
          ) : (
            <ScrollableTable name={ridesHeading(open)}>
              <RideList rides={openRides} onOpen={setOpenChild} />
            </ScrollableTable>
          )}
        </section>
      )}

      {/*
        After the counted numbers and the rides behind them, never before: the page leads with
        what the demo day actually measures, and the two things it cannot measure come next.
        Below the drill-down too, so opening a number does not push these two rows between a
        tile and the rides it just opened.
      */}
      <BaselineRows />

      <section className={styles.panel} aria-labelledby="adapters-heading">
        <h2 id="adapters-heading" className={styles.panelHeading}>
          {health.adapterPanel.heading}
        </h2>
        {/*
          Said before the table and never after it. A reader who skims three rows with nothing
          red in them concludes that everything works, and on this deployment that is false of
          every row — so the panel says so in words first, and no row wears an "ok" tone.
        */}
        <p className={styles.adapterIntro}>
          {adapters.allMocked
            ? health.adapterPanel.allMockedIntro
            : health.adapterPanel.someLiveIntro}
        </p>
        <ScrollableTable name={health.adapterPanel.heading}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">{health.adapterPanel.columns.adapter}</th>
                <th scope="col">{health.adapterPanel.columns.mode}</th>
                <th scope="col">{health.adapterPanel.columns.doing}</th>
                <th scope="col">{health.adapterPanel.columns.degraded}</th>
              </tr>
            </thead>
            <tbody>
              {adapters.rows.map((row) => (
                <AdapterRow key={row.key} row={row} />
              ))}
            </tbody>
          </table>
        </ScrollableTable>
      </section>

      {drawerLegs.length > 0 ? (
        <LegDrawer legs={drawerLegs} day={day} onClose={() => setOpenChild(null)} />
      ) : null}
    </div>
  );
}

/**
 * A table that may be wider than the screen, in a region that scrolls sideways.
 *
 * One wrapper for both tables on this screen, so there is one answer to "what happens to the
 * columns that do not fit" and not two. The panel hides its own overflow — the §4.6 watermark
 * must not bleed past it — so at 390 px the rides table's last two columns and the adapter
 * table's runbook column were simply cut off, with nothing a reader could do about it (Vera's
 * review of 53423de, 2026-10-17).
 *
 * A region rather than a plain div, focusable rather than mouse-only: §9 asks that anything
 * which scrolls can be scrolled from a keyboard, and `tabIndex` plus `role="region"` is what
 * makes the browser treat this box as a place to stand. It is named out of copy.ts, by the
 * table's own heading, so the ear gets the same name the eye does and no second string is
 * written for it.
 */
function ScrollableTable({ name, children }: { name: string; children: React.ReactNode }) {
  return (
    <div
      className={styles.scroller}
      role="region"
      aria-label={fill(health.tableScroll, { table: name })}
      tabIndex={0}
    >
      {children}
    </div>
  );
}

/**
 * One headline number: the count, what it counts, the plain sentence under it, and why it is on
 * the screen at all.
 *
 * The whole tile is the button rather than a "show the rides" link beside it, because the number
 * *is* the control — a coordinator who wants the rides behind a number clicks the number. The
 * chevron and `aria-expanded` say what the click does, so the affordance is not the hover.
 */
function Tile({
  metric,
  open,
  onToggle,
}: {
  metric: RoiMetric;
  open: boolean;
  onToggle: () => void;
}) {
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <li className={styles.tile}>
      <button
        type="button"
        className={styles.tileButton}
        // No `aria-controls`: the list is rendered only while a number is open, so an idref
        // would dangle on the three tiles that are closed. `aria-expanded` is the part a screen
        // reader needs, and the list that appears carries its own heading.
        aria-expanded={open}
        onClick={onToggle}
      >
        <span className={`${styles.tileValue} tabularNums`}>{metricValue(metric)}</span>
        <span className={styles.tileLabel}>{metricLabel(metric.key)}</span>
        <span className={styles.tileLine}>{metricLine(metric)}</span>
        <span className={styles.tileWhy}>{metricWhy(metric.key)}</span>
        <span className={styles.tileDrill}>
          <Chevron size={icon.inline} aria-hidden="true" />
          {open ? health.hideRides : health.showRides}
        </span>
      </button>
    </li>
  );
}

/**
 * Hours saved and money saved — the two rows with no number (PRD §17.3, §17.4).
 *
 * Below the counted numbers and in a panel of their own, never a fifth and sixth tile. A tile on
 * this screen is a control that opens the rides behind a count; these open nothing, because
 * there is nothing behind them yet, and a tile that cannot be clicked next to four that can is
 * a worse lie than the missing figure.
 *
 * Where each row's value would go, the words "Not measured yet" are printed — not an em dash,
 * not an empty cell, not a nought. A blank is read as a loading state and a nought is read as
 * a result, and this is neither: it is a measurement nobody has taken.
 */
function BaselineRows() {
  return (
    <section className={styles.panel} aria-labelledby="baseline-heading">
      <h2 id="baseline-heading" className={styles.panelHeading}>
        {health.baseline.heading}
      </h2>
      <p className={styles.adapterIntro}>{health.baseline.intro}</p>
      <table className={styles.table}>
        <thead>
          <tr>
            <th scope="col">{health.baseline.columns.row}</th>
            <th scope="col">{health.baseline.columns.when}</th>
          </tr>
        </thead>
        <tbody>
          {BASELINE_ROWS.map((key) => (
            <tr key={key} className={styles.row} data-baseline-row={key}>
              <th scope="row" className={styles.baselineLabel}>
                {health.baseline.rows[key].label}
                {/*
                  Said on the row itself and not only in the column heading, so a row read on
                  its own — by a screen reader, or in a crop of a screenshot — still carries
                  the fact that it has no number.
                */}
                <span className={styles.baselineNoNumber}>{health.baseline.noNumber}</span>
              </th>
              <td className={styles.baselineDetail}>{health.baseline.rows[key].detail}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

/**
 * The rides one number was counted from.
 *
 * Five columns, not the board's nine: this is the way back to a child, not a second board. The
 * child's name is the button, exactly as it is on the board, so the same click opens the same
 * panel and a reader who has used one screen has used both.
 */
function RideList({
  rides,
  onOpen,
}: {
  rides: readonly LegRow[];
  onOpen: (childKey: string) => void;
}) {
  return (
    <table className={styles.table}>
      <thead>
        <tr>
          <th scope="col">{health.rideColumns.child}</th>
          <th scope="col">{health.rideColumns.ride}</th>
          <th scope="col">{health.rideColumns.state}</th>
          <th scope="col">{health.rideColumns.vehicle}</th>
          <th scope="col">{health.rideColumns.nextStep}</th>
        </tr>
      </thead>
      <tbody>
        {rides.map((leg) => {
          const spoken = leg.ride.direction === "AM" ? boardCopy.amSpoken : boardCopy.pmSpoken;
          // The board's own opener, not a second one: the same control, announced the same way.
          const opener = fill(boardCopy.openRow, { child: leg.child.childLabel, ride: spoken });
          return (
            <tr key={leg.key} className={styles.row}>
              <th scope="row" className={styles.childCell}>
                <button
                  type="button"
                  className={styles.openRow}
                  aria-label={opener}
                  onClick={() => onOpen(leg.child.childKey)}
                >
                  <span className="srOnly">{opener}</span>
                  <span aria-hidden="true">{leg.child.childLabel}</span>
                </button>
              </th>
              <td>{leg.ride.direction === "AM" ? boardCopy.am : boardCopy.pm}</td>
              <td>
                <StateChip state={legStates[leg.ride.state]} values={stateValues(leg)} />
              </td>
              {/*
                The van by what it is — "the convertible van" — and never `vehicleLabel`, which
                is "V1": the key the scenario files the van under, and the one thing in this
                column a reader standing at the screen can do nothing with. `vanName` is the
                same string every other screen names a van with, and the capital on it is the
                stylesheet's, exactly as a lane heading takes one.
              */}
              <td className={styles.vanCell}>
                {leg.ride.vehicleDescription === null
                  ? boardCopy.familyDrives
                  : vanName(leg.ride.vehicleDescription)}
              </td>
              <td className={styles.nextStep}>{nextStepCellText(leg)}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/** One part of the system: its mode, why it is in that mode, what it is doing, and the runbook. */
function AdapterRow({ row }: { row: AdapterStatus }) {
  const because = adapterMockedBecause(row);
  return (
    <tr className={styles.row}>
      <th scope="row" className={styles.adapterName}>
        {adapterName(row.key)}
      </th>
      <td>
        <StateChip state={adapterModeChip(row)} />
      </td>
      <td>
        <span className={styles.adapterDoing}>{adapterDoing(row)}</span>
        {because === null ? null : <span className={styles.muted}>{because}</span>}
      </td>
      <td className={styles.adapterDegraded}>{adapterDegraded(row.key)}</td>
    </tr>
  );
}
