"use client";

import { useState } from "react";
import { useDroppable } from "@dnd-kit/core";
import { Check, ChevronDown, ChevronRight, TriangleAlert } from "lucide-react";
import type { Bucket, BoardDay, BoardPlan } from "@/domain/plan/board";
import { childrenInBucket, unassignedRiders } from "@/domain/plan/board";
import { planBoard } from "@/ui/copy";
import { icon } from "@/ui/tokens";
import type { BoardRider } from "@/domain/plan/board";
import { RiderCard } from "./RiderCard";
import { refusalLineFor, type Refusal } from "./refusal";
import styles from "./board.module.css";

/** The drop zone that is no van at all: "out of every van", which is always allowed. */
export const UNASSIGNED_ID = "unassigned";

/**
 * The children waiting to be placed, and the two groups that are not waiting for anything
 * (redesign spec §1.2's `UnassignedColumn`, §1.3's Empty and All-placed states).
 *
 * The count badge is the one number that matters here: warn while anybody is unplaced, and an
 * `ok` tick with "All placed" once nobody is — a word as well as a tone, so the difference is not
 * the colour.
 *
 * "Family drives" and "Absent" are **drop targets** (founder 2026-10-17 7:17 PM ET): both are
 * placements on this day's plan, per leg, so a child can be dragged onto either and dragged back
 * out of it. They stay collapsed, because a count is what a coordinator reads at a glance and
 * nineteen names is not a decision anybody is making — opening one shows its children as cards,
 * which is how they come back.
 */
export function UnassignedColumn({
  day,
  plan,
  shown,
  columns,
  onMove,
  onMoveToBucket,
  onOpenChild,
  canEdit,
  overBucket,
  refusal,
}: {
  day: BoardDay;
  plan: BoardPlan;
  shown: boolean;
  columns: readonly { id: string | null; name: string }[];
  onMove: (childToken: string, vanId: string | null) => void;
  /** A drop on one of the two groups: the child's bucket on this leg's plan. */
  onMoveToBucket: (childToken: string, bucket: Bucket) => void;
  onOpenChild: (childToken: string) => void;
  canEdit: boolean;
  /** Which group the card being held is over, so it can say it would take them. */
  overBucket: Bucket | null;
  /** The one refused drop on the board, so the card it is about carries its line (Vera). */
  refusal?: Refusal | null;
}) {
  const { setNodeRef } = useDroppable({ id: UNASSIGNED_ID });
  const waiting = unassignedRiders(day, plan);
  const groups: { bucket: Bucket; label: string }[] = [
    { bucket: "FAMILY_DRIVES", label: planBoard.familyDrives },
    { bucket: "ABSENT", label: planBoard.absent },
  ];

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
              columns={columns}
              moveTo={(vanId) => onMove(rider.token, vanId)}
              moveToBucket={(bucket) => onMoveToBucket(rider.token, bucket)}
              onOpen={() => onOpenChild(rider.token)}
              canEdit={canEdit}
              refusalLine={refusalLineFor(refusal, rider.token)}
            />
          ))}
        </ul>
      )}

      {groups.map((group) => (
        <CollapsedGroup
          key={group.bucket}
          bucket={group.bucket}
          label={group.label}
          members={childrenInBucket(day, plan, group.bucket)}
          columns={columns}
          over={overBucket === group.bucket}
          canEdit={canEdit}
          refusal={refusal}
          onMove={onMove}
          onMoveToBucket={onMoveToBucket}
          onOpenChild={onOpenChild}
        />
      ))}
    </section>
  );
}

/**
 * One of the two groups at the bottom of the column: a count, the children behind it one tap
 * away, and a place to drop a card.
 *
 * Dropping here is a real placement on this leg's plan — `ABSENT` or `FAMILY_DRIVES` with no
 * van — written through the one placement writer like every other move (gate (b)). Opening the
 * group shows its children as cards, which is how a child comes back out of it.
 */
function CollapsedGroup({
  bucket,
  label,
  members,
  columns,
  over,
  canEdit,
  refusal,
  onMove,
  onMoveToBucket,
  onOpenChild,
}: {
  bucket: Bucket;
  label: string;
  members: readonly { token: string; name: string; rider: BoardRider | null }[];
  columns: readonly { id: string | null; name: string }[];
  over: boolean;
  canEdit: boolean;
  refusal?: Refusal | null;
  onMove: (childToken: string, vanId: string | null) => void;
  onMoveToBucket: (childToken: string, bucket: Bucket) => void;
  onOpenChild: (childToken: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const { setNodeRef } = useDroppable({ id: bucket });
  return (
    <div
      className={styles.group}
      ref={setNodeRef}
      data-bucket={bucket}
      data-over={over ? "true" : "false"}
    >
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
        <span className={styles.count} data-bucket-count={bucket}>
          {members.length}
        </span>
      </button>
      {open ? (
        <ul className={styles.list} data-bucket-list={bucket}>
          {members.map((child) =>
            child.rider ? (
              <RiderCard
                key={child.token}
                rider={child.rider}
                columns={columns}
                moveTo={(vanId) => onMove(child.token, vanId)}
                moveToBucket={(next) => onMoveToBucket(child.token, next)}
                onOpen={() => onOpenChild(child.token)}
                canEdit={canEdit}
                refusalLine={refusalLineFor(refusal, child.token)}
              />
            ) : (
              // A child the centre never drives on this leg: a name, and no card to drag,
              // because there is no ride of ours to move them out of.
              <li key={child.token} className={styles.groupName} data-group-child={child.token}>
                {child.name}
              </li>
            ),
          )}
        </ul>
      ) : null}
    </div>
  );
}
