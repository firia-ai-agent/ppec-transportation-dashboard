"use client";

import { useState } from "react";
import { useDraggable } from "@dnd-kit/core";
import { GripVertical } from "lucide-react";
import { planBoard } from "@/ui/copy";
import { NeedIcons } from "@/ui/equipment";
import { icon } from "@/ui/tokens";
import { hasStop, type Bucket, type BoardRider } from "@/domain/plan/board";
import { stopLine } from "./lines";
import styles from "./board.module.css";

/**
 * One child on the board (redesign spec §1.2's `RiderCard`).
 *
 * Four things and no sentence: the stop number their van drives them at — or a grip, while they
 * are in no van — their name, the icons for what they need, and one subline of time and place.
 *
 * It is a **draggable and a button at once**, which is what makes the keyboard walk work: dnd-kit's
 * keyboard sensor lifts the card on Space, moves between columns with the arrows and drops on
 * Space, and every announcement it makes is a word (§1.7 #4). The `Move to…` control beside it is
 * the same move without a drag at all — the only way to do it on a phone (§9.3 at 390 px) and a
 * perfectly good way to do it with a mouse. Its list includes the two groups, so "mark Mia
 * absent" is the same one control as "move Mia to Van 2" (founder 7:17 PM ET).
 *
 * **Tapping the card opens the child's panel** (`onOpen`), which is where the three needs are
 * answered. A click that followed a drag does not count as a tap: dnd-kit tells us which it was.
 *
 * The front desk gets the same card with no grip and no drag listeners: they read the board on
 * Today and may not move anybody on it. The endpoint refuses them too — hiding a handle is the
 * courtesy, not the guard.
 */
export function RiderCard({
  rider,
  stopNumber,
  colour,
  moveTo,
  moveToBucket,
  onOpen,
  canEdit = true,
  selected = false,
  columns,
  refusalLine,
}: {
  rider: BoardRider;
  /** The stop this child is driven at, inside their van. Absent for a child in no van. */
  stopNumber?: number;
  /** The van's own route colour, as a CSS custom property reference. */
  colour?: string;
  /** Where this child could be moved to, as the `Move to…` menu offers it. */
  columns: readonly { id: string | null; name: string }[];
  moveTo: (vanId: string | null) => void;
  /** The two groups, as the same control offers them: Absent and Family drives. */
  moveToBucket?: (bucket: Bucket) => void;
  /** Open this child's panel. A tap, not a drag. */
  onOpen?: () => void;
  /** Director and coordinator drag; the front desk reads. */
  canEdit?: boolean;
  /** This child's panel is open, so the card says which one it belongs to. */
  selected?: boolean;
  /**
   * Why the last drop was refused, in four words ("Van 1 wheelchair full") — Vera's taste spec
   * of 2026-10-18. The card **did not move**, so the answer is on the card and not in a toast
   * that would slide away while it sat there unexplained: it takes the card's own second line
   * and its border, and it clears on the next drag start.
   */
  refusalLine?: string;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: rider.token,
    disabled: !canEdit,
  });
  /**
   * The `Move to…` control is always in the markup and shown in two places: on a phone, where
   * there is no cross-column drag at all (§9.3), and on the card's own context menu, which is
   * where §1.2 puts it on a wide screen. One control, two ways in — not two implementations of
   * "move this child", which would be two things to keep agreeing with the fit rule.
   */
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <li>
      <button
        type="button"
        ref={setNodeRef}
        className={styles.card}
        data-dragging={isDragging ? "true" : "false"}
        data-refused={refusalLine ? "true" : undefined}
        data-rider={rider.token}
        data-selected={selected ? "true" : undefined}
        onContextMenu={(event) => {
          if (!canEdit) return;
          event.preventDefault();
          setMenuOpen((open) => !open);
        }}
        onClick={() => {
          // A click that ended a drag is not a tap; dnd-kit has already told us it was moving.
          if (isDragging) return;
          onOpen?.();
        }}
        {...listeners}
        {...attributes}
      >
        {stopNumber === undefined ? (
          <span className={styles.grip} aria-hidden="true">
            {canEdit ? <GripVertical size={icon.inline} /> : null}
          </span>
        ) : (
          <span className={styles.stopBadge} style={colour ? { background: colour } : undefined}>
            {stopNumber}
          </span>
        )}
        <span className={styles.cardName}>{rider.name}</span>
        <span className={styles.cardIcons}>
          <NeedIcons needs={rider.needs} />
        </span>
        {/*
          The one subline — and when the last drop was refused, the refusal **is** that line
          (Vera on b3453cd, 2026-10-18): a strip under the card was a second box of its own,
          with dark text on a solid coral bar, and it pushed the card below it down the column.
          The card is where the answer belongs, so it is said there, in four words, and the card
          takes a coral edge with it so the eye finds the card and not a bar.

          Otherwise it is the stop this child is driven at, or — for a child with no kerb of
          ours — the lane they are in, in the lane's own words. It used to read "No pickup
          stop", which named a thing that is missing rather than an arrangement.

          Not wired to the card with `aria-describedby`: dnd-kit puts its own keyboard
          instructions there (`attributes`), and a refusal is not worth taking those away for —
          the sentence a screen reader hears is the board's own `aria-live` region (§1.3).
        */}
        <span
          className={styles.cardSub}
          data-refusal={refusalLine ? rider.token : undefined}
          data-tone={refusalLine ? "crit" : undefined}
        >
          {refusalLine ??
            (!hasStop(rider)
              ? planBoard.familyDrives
              : stopNumber === undefined
                ? rider.stopLabel
                : stopLine(rider.window, rider.stopLabel))}
        </span>
      </button>
      {/*
        The same move, chosen rather than dragged. A `select` and not a menu of our own: it is one
        tap on a phone, it is reachable with a keyboard without any code of ours, and the screen
        reader already knows how to read it. Its label is the §1.5 string, visible only to a
        screen reader because the control explains itself (§0's rule 4).
      */}
      {canEdit ? (
      <label className={styles.moveTo} data-open={menuOpen ? "true" : "false"}>
        <span className="srOnly">{planBoard.moveTo}</span>
        <select
          className={styles.moveToSelect}
          value={""}
          data-move-to={rider.token}
          onChange={(event) => {
            const chosen = event.target.value;
            if (chosen === "") return;
            event.target.value = "";
            setMenuOpen(false);
            if (chosen === "ABSENT" || chosen === "FAMILY_DRIVES") {
              moveToBucket?.(chosen);
              return;
            }
            moveTo(chosen === "none" ? null : chosen);
          }}
        >
          <option value="">{planBoard.moveTo}</option>
          {columns.map((column) => (
            <option key={column.id ?? "none"} value={column.id ?? "none"}>
              {column.name}
            </option>
          ))}
          {moveToBucket ? (
            <>
              <option value="FAMILY_DRIVES">{planBoard.familyDrives}</option>
              <option value="ABSENT">{planBoard.absent}</option>
            </>
          ) : null}
        </select>
      </label>
      ) : null}
    </li>
  );
}
