"use client";

import { useDroppable } from "@dnd-kit/core";
import { CircleSlash, Clock, MapPin } from "lucide-react";
import type { RejectReason } from "@/config/equipment";
import type { BoardDay, BoardPlan, BoardRider, BoardVan } from "@/domain/plan/board";
import { ridersInVan, stopCount, stopNumbers, usedInVan } from "@/domain/plan/board";
import { isOver } from "@/domain/plan/fit";
import { planBoard } from "@/ui/copy";
import { icon } from "@/ui/tokens";
import { CapacityMeters } from "./CapacityMeters";
import { RiderCard } from "./RiderCard";
import { footerLines, initialsOf, rejectChip, setupLine } from "./lines";
import styles from "./board.module.css";

/**
 * One van's column (redesign spec §1.2's `VanColumn`, §1.3's dragging and rejection states).
 *
 * Top to bottom: the van's colour and name, who is driving, whether the ramp has confirmed its
 * counts today, the four read-only counters, the riders as stops in the order they are driven,
 * and a footer of stops and minutes.
 *
 * The counts are **read** here and set nowhere on this screen (Firia's rule 1): there is no ⚙ and
 * no setup popover, a chip is a link to the ramp iPad on this van, and a van nobody has confirmed
 * today says so in one line — "Using default setup", no button — because that is a soft
 * prerequisite and not a fault (§9.1, and the 5:55 and 6:00 PM ET rulings).
 *
 * While a child is held, the column says what it would do with them *before* the drop: a dashed
 * brand outline when it fits, dimmed with a one-word chip when it does not, and a hatched crit
 * border when it is the van under the pointer and would refuse. Three cues, so the answer survives
 * a greyscale screenshot (§0's rule 2).
 */
export function VanColumn({
  van,
  day,
  plan,
  minutes,
  reject,
  hovered,
  selected,
  shown,
  columns,
  onMove,
  rampHref,
}: {
  van: BoardVan;
  day: BoardDay;
  plan: BoardPlan;
  /** The van's driving time, from the survey's own measured legs (src/domain/plan/map.ts). */
  minutes: number;
  /** Why this van cannot take the child being held, or null when it can, or undefined when none is. */
  reject: RejectReason | null | undefined;
  hovered: boolean;
  /** This is the van the address names (§9.3's `?van=`): ringed, and first on a phone. */
  selected: boolean;
  shown: boolean;
  columns: readonly { id: string | null; name: string }[];
  onMove: (childToken: string, vanId: string | null) => void;
  /** Where this van is counted (the ramp iPad, on this van), or null for a role that cannot. */
  rampHref: string | null;
}) {
  const { setNodeRef, isOver: pointerOver } = useDroppable({ id: van.id });
  const riders = ridersInVan(day, plan, van.id);
  const numbers = stopNumbers(riders);
  const used = usedInVan(day, plan, van.id);
  const setupState = setupLine(van);
  const footer = footerLines(stopCount(riders), minutes);
  const over = isOver(van.setup, riders);
  const colour = `var(--color-${van.colourToken})`;

  return (
    <section
      ref={setNodeRef}
      className={styles.column}
      data-role="van"
      data-van={van.id}
      data-shown={shown ? "true" : "false"}
      data-selected={selected ? "true" : undefined}
      data-fit={reject === undefined ? undefined : reject === null ? "yes" : "no"}
      data-reject={reject && (hovered || pointerOver) ? "hover" : undefined}
      aria-label={van.name}
    >
      <div className={styles.columnHeader}>
        <span className={styles.swatch} style={{ background: colour }} aria-hidden="true" />
        <span className={styles.vanName}>{van.name}</span>
        {over ? (
          <span className={styles.chip} data-tone="crit">
            <CircleSlash size={icon.chip} aria-hidden="true" />
            {planBoard.overChip}
          </span>
        ) : null}
      </div>

      <div className={styles.driverRow}>
        <span className={styles.avatar} aria-hidden="true">
          {initialsOf(van.driverName)}
        </span>
        {van.driverName}
        {setupState.chip ? (
          <span className={styles.chip} data-tone={setupState.tone} data-checked={van.setupState}>
            {setupState.label}
          </span>
        ) : null}
      </div>

      {setupState.chip ? null : (
        <p className={styles.defaultLine} data-checked={van.setupState}>
          {setupState.label}
        </p>
      )}

      <CapacityMeters setup={van.setup} used={used} vanName={van.name} rampHref={rampHref} />

      {reject ? (
        <p className={styles.chip} data-tone="crit" data-reject-chip={van.id}>
          <CircleSlash size={icon.chip} aria-hidden="true" />
          {rejectChip(reject)}
        </p>
      ) : null}

      <ul className={styles.list}>
        {riders.map((rider: BoardRider) => (
          <RiderCard
            key={rider.token}
            rider={rider}
            stopNumber={numbers.get(rider.token)}
            colour={colour}
            columns={columns.filter((column) => column.id !== van.id)}
            moveTo={(vanId) => onMove(rider.token, vanId)}
          />
        ))}
        {/* An empty van shows where a child goes, at the top of the list rather than at the
            bottom of a column that is as tall as the board (§1.3's Empty state). */}
        {riders.length === 0 ? (
          <li className={styles.dropTarget}>{planBoard.dropHere}</li>
        ) : null}
      </ul>

      {riders.length === 0 ? null : (
        <p className={styles.footer}>
          <span className={styles.footerItem}>
            <MapPin size={icon.chip} aria-hidden="true" />
            {footer.stops}
          </span>
          <span className={styles.footerItem}>
            <Clock size={icon.chip} aria-hidden="true" />
            {footer.minutes}
          </span>
        </p>
      )}
    </section>
  );
}
