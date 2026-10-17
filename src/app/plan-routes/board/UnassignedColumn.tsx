"use client";

import { useState } from "react";
import { useDroppable } from "@dnd-kit/core";
import { Check, ChevronDown, ChevronRight, TriangleAlert } from "lucide-react";
import type { BoardDay, BoardPlan, OtherChild } from "@/domain/plan/board";
import { unassignedRiders } from "@/domain/plan/board";
import { planBoard } from "@/ui/copy";
import { icon } from "@/ui/tokens";
import { RiderCard } from "./RiderCard";
import styles from "./board.module.css";

/** The drop zone that is no van at all: "out of every van", which is always allowed. */
export const UNASSIGNED_ID = "unassigned";

/**
 * The children waiting to be placed, and the two groups that are not waiting for anything
 * (redesign spec §1.2's `UnassignedColumn`, §1.3's Empty and All-placed states).
 *
 * The count badge is the one number that matters here: warn while anybody is unplaced, and an
 * `ok` tick with "All placed" once nobody is — a word as well as a tone, so the difference is not
 * the colour. "Family drives" and "Absent" are collapsed, because they are the day's own facts
 * rather than anything to decide: a census child arrives with their family, and a child recorded
 * away is not ours to drive.
 */
export function UnassignedColumn({
  day,
  plan,
  shown,
  columns,
  onMove,
}: {
  day: BoardDay;
  plan: BoardPlan;
  shown: boolean;
  columns: readonly { id: string | null; name: string }[];
  onMove: (childToken: string, vanId: string | null) => void;
}) {
  const { setNodeRef } = useDroppable({ id: UNASSIGNED_ID });
  const waiting = unassignedRiders(day, plan);
  const groups: { bucket: OtherChild["bucket"]; label: string; children: OtherChild[] }[] = [
    { bucket: "FAMILY_DRIVES", label: planBoard.familyDrives, children: [] },
    { bucket: "ABSENT", label: planBoard.absent, children: [] },
  ];
  for (const other of day.others) {
    groups.find((group) => group.bucket === other.bucket)?.children.push(other);
  }

  return (
    <section
      ref={setNodeRef}
      className={styles.column}
      data-role="unassigned"
      data-shown={shown ? "true" : "false"}
      aria-label={planBoard.unassigned}
    >
      <div className={styles.columnHeader}>
        <span className={styles.vanName}>{planBoard.unassigned}</span>
        <span
          className={[styles.chip, styles.count].join(" ")}
          data-tone={waiting.length > 0 ? "warn" : "ok"}
          data-unassigned-count=""
        >
          {waiting.length > 0 ? (
            <TriangleAlert size={icon.chip} aria-hidden="true" />
          ) : (
            <Check size={icon.chip} aria-hidden="true" />
          )}
          {waiting.length}
        </span>
      </div>

      {waiting.length === 0 ? (
        <p className={styles.chip} data-tone="ok">
          <Check size={icon.chip} aria-hidden="true" />
          {planBoard.allPlaced}
        </p>
      ) : (
        <ul className={styles.list}>
          {waiting.map((rider) => (
            <RiderCard
              key={rider.token}
              rider={rider}
              columns={columns.filter((column) => column.id !== null)}
              moveTo={(vanId) => onMove(rider.token, vanId)}
            />
          ))}
        </ul>
      )}

      {groups.map((group) => (
        <CollapsedGroup key={group.bucket} label={group.label} names={group.children.map((c) => c.name)} />
      ))}
    </section>
  );
}

/**
 * One of the two groups at the bottom of the column: a count, and the names behind it one tap
 * away. Collapsed by default because nineteen names is not a decision anybody is making.
 */
function CollapsedGroup({ label, names }: { label: string; names: readonly string[] }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={styles.group}>
      <button
        type="button"
        className={styles.groupToggle}
        aria-expanded={open}
        onClick={() => setOpen((was) => !was)}
      >
        {open ? (
          <ChevronDown size={icon.inline} aria-hidden="true" />
        ) : (
          <ChevronRight size={icon.inline} aria-hidden="true" />
        )}
        {label}
        <span className={styles.count}>{names.length}</span>
      </button>
      {open ? (
        <ul className={styles.groupNames}>
          {names.map((name) => (
            <li key={name}>{name}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
