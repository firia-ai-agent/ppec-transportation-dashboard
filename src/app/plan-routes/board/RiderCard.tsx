"use client";

import { useState } from "react";
import { useDraggable } from "@dnd-kit/core";
import { GripVertical } from "lucide-react";
import { planBoard } from "@/ui/copy";
import { NeedIcons } from "@/ui/equipment";
import { icon } from "@/ui/tokens";
import type { BoardRider } from "@/domain/plan/board";
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
 * perfectly good way to do it with a mouse.
 */
export function RiderCard({
  rider,
  stopNumber,
  colour,
  moveTo,
  columns,
}: {
  rider: BoardRider;
  /** The stop this child is driven at, inside their van. Absent for a child in no van. */
  stopNumber?: number;
  /** The van's own route colour, as a CSS custom property reference. */
  colour?: string;
  /** Where this child could be moved to, as the `Move to…` menu offers it. */
  columns: readonly { id: string | null; name: string }[];
  moveTo: (vanId: string | null) => void;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: rider.token });
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
        data-rider={rider.token}
        onContextMenu={(event) => {
          event.preventDefault();
          setMenuOpen((open) => !open);
        }}
        {...listeners}
        {...attributes}
      >
        {stopNumber === undefined ? (
          <span className={styles.grip} aria-hidden="true">
            <GripVertical size={icon.inline} />
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
        <span className={styles.cardSub}>
          {stopNumber === undefined ? rider.stopLabel : stopLine(rider.window, rider.stopLabel)}
        </span>
      </button>
      {/*
        The same move, chosen rather than dragged. A `select` and not a menu of our own: it is one
        tap on a phone, it is reachable with a keyboard without any code of ours, and the screen
        reader already knows how to read it. Its label is the §1.5 string, visible only to a
        screen reader because the control explains itself (§0's rule 4).
      */}
      <label className={styles.moveTo} data-open={menuOpen ? "true" : "false"}>
        <span className="srOnly">{planBoard.moveTo}</span>
        <select
          className={styles.moveToSelect}
          value={""}
          data-move-to={rider.token}
          onChange={(event) => {
            const chosen = event.target.value;
            if (chosen === "") return;
            moveTo(chosen === "none" ? null : chosen);
            event.target.value = "";
            setMenuOpen(false);
          }}
        >
          <option value="">{planBoard.moveTo}</option>
          {columns.map((column) => (
            <option key={column.id ?? "none"} value={column.id ?? "none"}>
              {column.name}
            </option>
          ))}
        </select>
      </label>
    </li>
  );
}
