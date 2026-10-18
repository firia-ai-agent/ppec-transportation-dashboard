"use client";

import { useState } from "react";
import { X } from "lucide-react";
import type { CounterKey } from "@/config/equipment";
import type { PanelNeeds } from "@/domain/plan/needs";
import { fill, planBoard } from "@/ui/copy";
import { COUNTER_ICON, COUNTER_LABEL } from "@/ui/equipment";
import { icon } from "@/ui/tokens";
import styles from "./board.module.css";

/**
 * The panel a child card opens (founder 2026-10-17 7:17 PM ET; mockup `plan-board-child-*.png`).
 *
 * Three Yes/No controls and a Save, anchored to the card on a wide screen and a bottom sheet on
 * a phone — and nothing else. No "riding today" toggle, no page of its own, no second place to
 * set a van's counts: what a coordinator is answering here is "what does this child need",
 * which is the only thing the placement function reads about them.
 *
 * The three labels and their icons come from the shared equipment list
 * (src/config/equipment.ts), the same list the van meters and the ramp's steppers are built
 * from, so a car seat is called a car seat in all three places. The category strings those
 * answers become are the shared module's too (`NEED_CATEGORY`), which is Veri's gate (a).
 *
 * **The front desk sees the same three answers and no Save.** Hiding the button is the courtesy;
 * `POST /api/children/:token/needs` refusing their role is the guard (src/auth/access.ts).
 */
export function ChildPanel({
  childName,
  where,
  needs,
  canEdit,
  saving,
  onSave,
  onClose,
}: {
  childName: string;
  /** "Van 3 · Afternoon" — where this child is on the board right now. */
  where: string;
  needs: PanelNeeds;
  /** Director and coordinator edit; the front desk reads (§2's division of labour). */
  canEdit: boolean;
  saving: boolean;
  onSave: (next: PanelNeeds) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<PanelNeeds>(needs);

  /**
   * The three the panel owns, each named and drawn by the counter it consumes — so the row a
   * coordinator reads here says the same word as the meter it will move (src/ui/equipment.tsx
   * over src/config/equipment.ts, one list).
   */
  const rows: { key: keyof PanelNeeds; counter: CounterKey }[] = [
    { key: "wheelchair", counter: "wheelchairSpots" },
    { key: "carSeat", counter: "carSeats" },
    { key: "oxygen", counter: "oxygenMounts" },
  ];

  return (
    <>
      <div className={styles.scrim} onClick={onClose} data-panel-scrim="" />
      <div className={styles.panel} role="dialog" aria-label={childName} data-child-panel="">
        <div className={styles.panelHead}>
          <span>
            <b className={styles.panelName}>{childName}</b>
            <span className={styles.panelWhere}>{where}</span>
          </span>
          <button
            type="button"
            className={styles.panelClose}
            aria-label={planBoard.child.close}
            data-panel-close=""
            onClick={onClose}
          >
            <X size={icon.inline} aria-hidden="true" />
          </button>
        </div>

        {rows.map((row) => {
          const Icon = COUNTER_ICON[row.counter];
          return (
          <div key={row.key} className={styles.panelRow} data-need={row.key}>
            <Icon size={icon.inline} aria-hidden="true" />
            <span className={styles.panelLabel} id={`need-${row.key}`}>
              {COUNTER_LABEL[row.counter]}
            </span>
            <span className={styles.panelToggle} role="group" aria-labelledby={`need-${row.key}`}>
              {[true, false].map((yes) => (
                <button
                  key={String(yes)}
                  type="button"
                  className={styles.panelOption}
                  aria-pressed={draft[row.key] === yes}
                  disabled={!canEdit}
                  data-answer={yes ? "yes" : "no"}
                  onClick={() => setDraft((current) => ({ ...current, [row.key]: yes }))}
                >
                  {yes ? planBoard.child.yes : planBoard.child.no}
                </button>
              ))}
            </span>
          </div>
          );
        })}

        {canEdit ? (
          <>
            <button
              type="button"
              className={[styles.button, styles.panelSave].join(" ")}
              data-variant="primary"
              data-panel-save=""
              disabled={saving}
              onClick={() => onSave(draft)}
            >
              {saving ? planBoard.saving : planBoard.child.save}
            </button>
            <p className={styles.panelNote}>{planBoard.child.note}</p>
          </>
        ) : (
          // No Save, and the reason said in two words rather than left to be guessed at.
          <p className={styles.panelNote} data-panel-readonly="">
            {planBoard.child.readOnly}
          </p>
        )}
      </div>
    </>
  );
}

/** "Van 3 · Afternoon" / "Unassigned · Morning" — where a child is, for the panel's subline. */
export function whereLine(vanName: string | null, leg: "AM" | "PM"): string {
  const legWord = leg === "AM" ? planBoard.morning : planBoard.afternoon;
  return vanName
    ? fill(planBoard.child.where, { van: vanName, leg: legWord })
    : fill(planBoard.child.whereUnassigned, { leg: legWord });
}
