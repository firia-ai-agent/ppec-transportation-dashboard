"use client";

import { useState } from "react";
import { Check, Minus, Plus, X } from "lucide-react";
import { COUNTER_MAX } from "@/config/vans";
import { EQUIPMENT_COUNTERS } from "@/config/equipment";
import { rejectReason, type FitRider, type VanSetup } from "@/domain/plan/fit";
import type { BoardRider, BoardVan } from "@/domain/plan/board";
import { planBoard, vanArrival } from "@/ui/copy";
import { COUNTER_ICON, COUNTER_LABEL, LIFT_ICON } from "@/ui/equipment";
import { icon } from "@/ui/tokens";
import { fitPreview, setupFromLine, setupTitle } from "./lines";
import styles from "./board.module.css";

/**
 * What is on this van, as a coordinator plans it (redesign spec §1.2's `VanSetupPopover`, §1.3's
 * `#setup` state).
 *
 * Four steppers, a lift switch, and one live line about a real child — "Noah O. fits" — so the
 * answer to "will raising this to 1 help" is on screen before Apply is pressed. The preview is the
 * same `rejectReason` the drag uses (src/domain/plan/fit.ts): there is no second opinion about fit
 * anywhere in this screen.
 *
 * A changed value reads as changed (`info-bg` behind the number), because the counts a van arrived
 * with are a record and the ones a coordinator is trying out are not.
 */
export function VanSetupPopover({
  van,
  aboard,
  preview,
  onApply,
  onCancel,
}: {
  van: BoardVan;
  /** Who is in the van now, so the preview answers about the load and not about the child alone. */
  aboard: readonly FitRider[];
  /** The child the preview is about: the one being dragged, or the first still waiting. */
  preview: BoardRider | null;
  onApply: (setup: VanSetup) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState<VanSetup>(van.setup);
  const from = setupFromLine(van);
  const previewFits = preview ? rejectReason(draft, aboard, preview) === null : null;

  const step = (key: keyof VanSetup, by: number) =>
    setDraft((current) => {
      const value = current[key];
      if (typeof value !== "number") return current;
      return { ...current, [key]: Math.max(0, Math.min(COUNTER_MAX, value + by)) };
    });

  return (
    <div className={styles.popover} role="dialog" aria-label={setupTitle(van.name)} data-setup={van.id}>
      <h3 className={styles.popoverTitle}>
        <span
          className={styles.swatch}
          style={{ background: `var(--color-${routeToken(van.slot)})` }}
          aria-hidden="true"
        />
        {setupTitle(van.name)}
      </h3>
      {from ? <p className={styles.popoverFrom}>{from}</p> : null}

      {EQUIPMENT_COUNTERS.map((counter) => {
        const Icon = COUNTER_ICON[counter.key];
        const value = draft[counter.key];
        return (
          <div
            key={counter.key}
            className={styles.stepper}
            data-changed={value !== van.setup[counter.key] ? "true" : "false"}
            data-stepper={counter.key}
          >
            <Icon size={icon.inline} aria-hidden="true" />
            <span>{COUNTER_LABEL[counter.key]}</span>
            <span className={styles.stepperControls}>
              <button
                type="button"
                className={styles.stepperButton}
                aria-label={`${COUNTER_LABEL[counter.key]} ${planBoard.fewer}`}
                onClick={() => step(counter.key, -1)}
              >
                <Minus size={icon.inline} aria-hidden="true" />
              </button>
              <span className={styles.stepperValue} aria-live="polite">
                {value}
              </span>
              <button
                type="button"
                className={styles.stepperButton}
                aria-label={`${COUNTER_LABEL[counter.key]} ${planBoard.more}`}
                onClick={() => step(counter.key, 1)}
              >
                <Plus size={icon.inline} aria-hidden="true" />
              </button>
            </span>
          </div>
        );
      })}

      <div className={styles.toggleRow} data-stepper="lift">
        <LIFT_ICON size={icon.inline} aria-hidden="true" />
        <span id={`lift-${van.id}`}>{planBoard.lift}</span>
        <button
          type="button"
          className={styles.button}
          role="switch"
          aria-checked={draft.hasLift}
          aria-labelledby={`lift-${van.id}`}
          onClick={() => setDraft((current) => ({ ...current, hasLift: !current.hasLift }))}
        >
          {draft.hasLift ? <Check size={icon.inline} aria-hidden="true" /> : <X size={icon.inline} aria-hidden="true" />}
          {draft.hasLift ? vanArrival.yes : vanArrival.no}
        </button>
      </div>

      {preview && previewFits !== null ? (
        <p className={styles.chip} data-tone={previewFits ? "ok" : "crit"} aria-live="polite">
          {previewFits ? <Check size={icon.chip} aria-hidden="true" /> : <X size={icon.chip} aria-hidden="true" />}
          {fitPreview(preview.name, previewFits)}
        </p>
      ) : null}

      <div className={styles.popoverActions}>
        <button type="button" className={styles.button} onClick={onCancel}>
          {planBoard.cancel}
        </button>
        <button
          type="button"
          className={styles.button}
          data-variant="primary"
          onClick={() => onApply(draft)}
        >
          {planBoard.apply}
        </button>
      </div>
    </div>
  );
}

/**
 * The route colour token for a van's slot: the first is the brand blue the map already draws
 * with, then the two route colours beside it (src/ui/tokens.ts). Three vans, three colours, and
 * no fourth copy of blue.
 */
export function routeToken(slot: number): string {
  return slot === 1 ? "brand" : slot === 2 ? "map-route-2" : "map-route-3";
}
