"use client";

import { useDroppable } from "@dnd-kit/core";
import { CircleSlash, Clock, MapPin, Settings2 } from "lucide-react";
import type { RejectReason } from "@/config/equipment";
import type { BoardDay, BoardPlan, BoardRider, BoardVan } from "@/domain/plan/board";
import { ridersInVan, stopCount, stopNumbers, usedInVan } from "@/domain/plan/board";
import { isOver } from "@/domain/plan/fit";
import { planBoard } from "@/ui/copy";
import { icon } from "@/ui/tokens";
import { CapacityMeters } from "./CapacityMeters";
import { RiderCard } from "./RiderCard";
import { checkedChip, footerLines, initialsOf, rejectChip, setupTitle } from "./lines";
import { routeToken } from "./VanSetupPopover";
import styles from "./board.module.css";

/**
 * One van's column (redesign spec §1.2's `VanColumn`, §1.3's dragging and rejection states).
 *
 * Top to bottom: the van's colour and name with its setup control, who is driving and whether the
 * ramp has checked it today, the four counters, the riders as stops in the order they are driven,
 * and a footer of stops and minutes.
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
  shown,
  columns,
  onMove,
  onOpenSetup,
  setupOpen,
  children,
}: {
  van: BoardVan;
  day: BoardDay;
  plan: BoardPlan;
  /** The van's driving time, from the survey's own measured legs (src/domain/plan/map.ts). */
  minutes: number;
  /** Why this van cannot take the child being held, or null when it can, or undefined when none is. */
  reject: RejectReason | null | undefined;
  hovered: boolean;
  shown: boolean;
  columns: readonly { id: string | null; name: string }[];
  onMove: (childToken: string, vanId: string | null) => void;
  onOpenSetup: () => void;
  setupOpen: boolean;
  /** The setup popover, rendered by the board so one is open at a time. */
  children?: React.ReactNode;
}) {
  const { setNodeRef, isOver: pointerOver } = useDroppable({ id: van.id });
  const riders = ridersInVan(day, plan, van.id);
  const numbers = stopNumbers(riders);
  const used = usedInVan(day, plan, van.id);
  const checked = checkedChip(van);
  const footer = footerLines(stopCount(riders), minutes);
  const over = isOver(van.setup, riders);
  const colour = `var(--color-${routeToken(van.slot)})`;

  return (
    <section
      ref={setNodeRef}
      className={[styles.column, styles.popoverHost].join(" ")}
      data-role="van"
      data-van={van.id}
      data-shown={shown ? "true" : "false"}
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
        <button
          type="button"
          className={[styles.button, styles.iconButton].join(" ")}
          style={{ marginLeft: "auto" }}
          aria-label={setupTitle(van.name)}
          aria-expanded={setupOpen}
          data-setup-button={van.id}
          onClick={onOpenSetup}
        >
          <Settings2 size={icon.inline} aria-hidden="true" />
        </button>
      </div>

      <div className={styles.driverRow}>
        <span className={styles.avatar} aria-hidden="true">
          {initialsOf(van.driverName)}
        </span>
        {van.driverName}
        <span className={styles.chip} data-tone={checked.tone} data-checked={van.setupState}>
          {checked.label}
        </span>
      </div>

      <CapacityMeters setup={van.setup} used={used} />

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
      {children}
    </section>
  );
}
