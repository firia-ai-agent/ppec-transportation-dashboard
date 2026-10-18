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
 * The count badge is the one number that matters here, and only while there is one: a warn chip
 * with how many are unplaced, and — once nobody is — no chip at all and the `ok` "All placed"
 * line below, a word as well as a tone, so the difference is not the colour.
 *
 * "Family drives" and "Absent" are **drop targets** (founder 2026-10-17 7:17 PM ET): both are
 * placements on this day's plan, per leg, so a child can be dragged onto either and dragged back
 * out of it, and either one shows the same cards the column above it draws.
 *
 * They do **not** open the same way, because they are not the same question (Firia, 2026-10-18).
 * Absent is a tally — who is not coming today — and stays a count row, which is all a
 * coordinator reads of it at a glance. Family drives is a lane of children who need a van the
 * moment a family cannot drive, and it was a line that read "3": no names, no needs, nothing to
 * pick up. So it opens by default, with a full card each.
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
  lifted,
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
  /**
   * Is a card in the air at all? The Family drives lane takes every child, so it shows the van
   * columns' own dashed drop outline from the lift rather than from the hover (Vera, 2026-10-18).
   */
  lifted?: boolean;
  /** The one refused drop on the board, so the card it is about carries its line (Vera). */
  refusal?: Refusal | null;
}) {
  const { setNodeRef } = useDroppable({ id: UNASSIGNED_ID });
  const waiting = unassignedRiders(day, plan);
  const groups: { bucket: Bucket; label: string; startOpen: boolean }[] = [
    { bucket: "FAMILY_DRIVES", label: planBoard.familyDrives, startOpen: true },
    { bucket: "ABSENT", label: planBoard.absent, startOpen: false },
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
        {/*
          HOW MANY ARE STILL WAITING — and nothing at all once nobody is (Vera on b3453cd,
          2026-10-18). png/plan-board.png draws a count beside the heading while two children
          are unplaced and draws no chip when the column is clear, so a "✓ 0" is a chip that
          says a number nobody needs: the green "All placed" below is the answer at zero, and
          the toolbar's "N of N placed" is the same fact in full.
        */}
        {waiting.length > 0 ? (
          <span
            className={[styles.chip, styles.count].join(" ")}
            data-tone="warn"
            data-unassigned-count=""
          >
            <TriangleAlert size={icon.chip} aria-hidden="true" />
            {waiting.length}
          </span>
        ) : null}
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
        <BucketGroup
          key={group.bucket}
          bucket={group.bucket}
          label={group.label}
          startOpen={group.startOpen}
          members={childrenInBucket(day, plan, group.bucket)}
          columns={columns}
          over={overBucket === group.bucket}
          fit={Boolean(lifted) && group.bucket === "FAMILY_DRIVES"}
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
 * One of the two groups at the bottom of the column: a count, the children in it as cards, and a
 * place to drop one.
 *
 * Dropping here is a real placement on this leg's plan — `ABSENT` or `FAMILY_DRIVES` with no
 * van — written through the one placement writer like every other move (gate (b)). Its children
 * are the same `RiderCard` the column above draws, so each one opens the child panel, can be
 * lifted onto a van — the one eligibility rule decides, with their own approved needs — and
 * dragged back in here.
 *
 * `startOpen` is the only difference between the two, and it is the whole of Firia's 2026-10-18
 * report: Family drives opens, Absent stays a count row. The toggle still works on both.
 */
function BucketGroup({
  bucket,
  label,
  members,
  columns,
  over,
  fit,
  startOpen,
  canEdit,
  refusal,
  onMove,
  onMoveToBucket,
  onOpenChild,
}: {
  bucket: Bucket;
  label: string;
  members: readonly BoardRider[];
  columns: readonly { id: string | null; name: string }[];
  over: boolean;
  /** A card is in the air and this lane would take it: the van column's own `data-fit="yes"`. */
  fit: boolean;
  /** Is this lane open the first time the board draws it? */
  startOpen: boolean;
  canEdit: boolean;
  refusal?: Refusal | null;
  onMove: (childToken: string, vanId: string | null) => void;
  onMoveToBucket: (childToken: string, bucket: Bucket) => void;
  onOpenChild: (childToken: string) => void;
}) {
  const [open, setOpen] = useState(startOpen);
  const { setNodeRef } = useDroppable({ id: bucket });
  return (
    <div
      className={styles.group}
      ref={setNodeRef}
      data-bucket={bucket}
      data-over={over ? "true" : "false"}
      data-fit={fit ? "yes" : undefined}
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
          {members.map((child) => (
            <RiderCard
              key={child.token}
              rider={child}
              columns={columns}
              moveTo={(vanId) => onMove(child.token, vanId)}
              moveToBucket={(next) => onMoveToBucket(child.token, next)}
              onOpen={() => onOpenChild(child.token)}
              canEdit={canEdit}
              refusalLine={refusalLineFor(refusal, child.token)}
            />
          ))}
        </ul>
      ) : null}
    </div>
  );
}
