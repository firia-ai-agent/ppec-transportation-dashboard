"use client";

/**
 * The ramp iPad's van arrival (redesign spec §2, demo goal 2).
 *
 * The front desk counts what is actually on the van — four steppers and a lift switch, pre-filled
 * with what the plan had — and confirms it. That Confirm is the whole point: it writes
 * `vehicle_setup_day` as `CHECKED` for today, which is what the board plans on tomorrow
 * ("Tomorrow starts from this"), and what makes this van read "Checked" rather than "Not checked"
 * on the coordinator's screen today.
 *
 * Beside the steppers are the riders, and each one says `Fits` or the one thing that is missing,
 * **live** as the counts change — the same `src/domain/plan/fit.ts` the board drags against, so
 * the ramp and the coordinator are never told two different things about one van. When somebody
 * does not fit, the banner names them and how short the van is, with Re-plan beside it: the leg
 * goes to a coordinator rather than anybody being moved silently (§2, and PR #60's flow behind
 * src/domain/plan/replan.ts).
 *
 * What §2 removes, and what is therefore not here: the layout picker, the per-place Free / Out /
 * Not sure answers, the LATCH row, the slot matrix and every explanatory sentence.
 *
 * The DEMO bar and the one source chip come from the root layout; this page must not mount a
 * second pair.
 */

import { useMemo, useState } from "react";
import { Check, CircleSlash, Minus, Plus, X } from "lucide-react";
import { API } from "@/auth/access";
import { EQUIPMENT_COUNTERS } from "@/config/equipment";
import { COUNTER_MAX } from "@/config/vans";
import { firstShortfall, rejectReason, type VanSetup } from "@/domain/plan/fit";
import { openPlanBoard } from "@/domain/plan/replan";
import type { BoardRider } from "@/domain/plan/board";
import type { ArrivalVan } from "./view";
import { RAMP_DIRECTION } from "./when";
import { flow, planBoard, vanArrival } from "@/ui/copy";
import { COUNTER_ICON, COUNTER_LABEL, LIFT_ICON, NeedIcons } from "@/ui/equipment";
import { icon } from "@/ui/tokens";
import {
  confirmLabel,
  leavesLine,
  plannedLine,
  riderVerdict,
  shortfallLines,
  whatsOn,
} from "./lines";
import styles from "./arrival.module.css";

export default function VanArrival({
  vans,
  selected,
  date,
  canPlan,
  planSaved,
}: {
  vans: readonly ArrivalVan[];
  /** The van being counted: the one the address names, or the first to leave. */
  selected: ArrivalVan;
  date: string;
  /** Whether this role may open the planning board at all (§9.3 hides what they cannot use). */
  canPlan: boolean;
  /** No plan saved for this leg yet, so there is nobody to list beside the steppers. */
  planSaved: boolean;
}) {
  /** What the plan had on this van, which is what the steppers open on. */
  const planned = selected.van.setup;
  const [draft, setDraft] = useState<VanSetup>(planned);
  const [confirmed, setConfirmed] = useState(selected.van.setupState === "CHECKED");
  const [saving, setSaving] = useState(false);

  /**
   * Each rider against the van as it is now, in the order it drives them: a child only fails
   * once the van has run out, so the answer is the same replay the save endpoint runs.
   */
  const verdicts = useMemo(() => {
    const aboard: BoardRider[] = [];
    return selected.riders.map((rider) => {
      const reason = rejectReason(draft, aboard, rider);
      if (!reason) aboard.push(rider);
      return { rider, reason };
    });
  }, [draft, selected.riders]);

  const shortfall = firstShortfall(draft, selected.riders);
  const firstRefused = verdicts.find((verdict) => verdict.reason !== null)?.rider ?? null;
  const replan = openPlanBoard({
    date,
    leg: RAMP_DIRECTION,
    vanId: selected.van.id,
    observed: draft,
    canPlan,
  });

  const step = (key: keyof VanSetup, by: number) =>
    setDraft((current) => {
      const value = current[key];
      if (typeof value !== "number") return current;
      setConfirmed(false);
      return { ...current, [key]: Math.max(0, Math.min(COUNTER_MAX, value + by)) };
    });

  async function confirm() {
    setSaving(true);
    try {
      const response = await fetch(API.vanSetup.replace("[id]", encodeURIComponent(selected.van.id)), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ date, ...draft, state: "CHECKED" }),
      });
      setConfirmed(response.ok);
    } catch {
      setConfirmed(false);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className={styles.page}>
      <h1 className={styles.heading}>{vanArrival.heading}</h1>

      {/* The vans at the centre this afternoon, in the order they leave. */}
      <nav className={styles.tabs} aria-label={vanArrival.ridersHeading}>
        {vans.map((arrival) => (
          <a
            key={arrival.van.id}
            className={styles.tab}
            href={`?date=${date}&van=${encodeURIComponent(arrival.van.id)}`}
            aria-current={arrival.van.id === selected.van.id ? "page" : undefined}
            data-tab={arrival.van.id}
          >
            <span className={styles.tabName}>{arrival.van.name}</span>
            <span className={styles.tabTime}>{leavesLine(arrival.leavesMs)}</span>
          </a>
        ))}
      </nav>

      <div className={styles.cards}>
        <section className={styles.card} aria-labelledby="whats-on">
          <h2 className={styles.cardTitle} id="whats-on">
            {whatsOn(selected.van.name)}
          </h2>
          <p className={styles.driver}>{selected.van.driverName}</p>

          {EQUIPMENT_COUNTERS.map((counter) => {
            const Icon = COUNTER_ICON[counter.key];
            const value = draft[counter.key];
            const changed = value !== planned[counter.key];
            return (
              <div
                key={counter.key}
                className={styles.stepper}
                data-stepper={counter.key}
                data-changed={changed ? "true" : "false"}
              >
                <Icon size={icon.nav} aria-hidden="true" />
                <span className={styles.stepperLabel}>
                  {COUNTER_LABEL[counter.key]}
                  {/* What the plan had, said only when the count in front of them differs. */}
                  {changed ? (
                    <small className={styles.planned}>{plannedLine(planned[counter.key])}</small>
                  ) : null}
                </span>
                <span className={styles.stepperControls}>
                  <button
                    type="button"
                    className={styles.stepperButton}
                    aria-label={`${COUNTER_LABEL[counter.key]} ${planBoard.fewer}`}
                    onClick={() => step(counter.key, -1)}
                  >
                    <Minus size={icon.nav} aria-hidden="true" />
                  </button>
                  <output className={styles.stepperValue}>{value}</output>
                  <button
                    type="button"
                    className={styles.stepperButton}
                    aria-label={`${COUNTER_LABEL[counter.key]} ${planBoard.more}`}
                    onClick={() => step(counter.key, 1)}
                  >
                    <Plus size={icon.nav} aria-hidden="true" />
                  </button>
                </span>
              </div>
            );
          })}

          <div className={styles.stepper} data-stepper="lift">
            <LIFT_ICON size={icon.nav} aria-hidden="true" />
            <span className={styles.stepperLabel} id="lift-works">
              {vanArrival.liftWorks}
            </span>
            <span className={styles.stepperControls} role="group" aria-labelledby="lift-works">
              {[true, false].map((yes) => (
                <button
                  key={String(yes)}
                  type="button"
                  className={styles.toggle}
                  aria-pressed={draft.hasLift === yes}
                  data-lift={yes ? "yes" : "no"}
                  onClick={() => {
                    setConfirmed(false);
                    setDraft((current) => ({ ...current, hasLift: yes }));
                  }}
                >
                  {draft.hasLift === yes ? <Check size={icon.chip} aria-hidden="true" /> : null}
                  {yes ? vanArrival.yes : vanArrival.no}
                </button>
              ))}
            </span>
          </div>

          <button
            type="button"
            className={styles.confirm}
            data-confirm=""
            disabled={saving}
            onClick={() => void confirm()}
          >
            {confirmed ? <Check size={icon.nav} aria-hidden="true" /> : null}
            {confirmed ? planBoard.checked : confirmLabel(selected.van.name)}
          </button>
          <p className={styles.hint}>{vanArrival.tomorrow}</p>
        </section>

        <section className={styles.card} aria-labelledby="riders">
          <h2 className={styles.cardTitle} id="riders">
            {vanArrival.ridersHeading}
            <span className={styles.riderCount}>{selected.riders.length}</span>
            <span className={styles.leaves}>{leavesLine(selected.leavesMs)}</span>
          </h2>

          {!planSaved ? (
            <p className={styles.empty} data-empty="">
              {vanArrival.noRidersPlanned}
              {canPlan ? (
                <a className={styles.emptyLink} href={`/plan-routes?date=${date}&leg=pm`}>
                  {flow.action.planRoutes}
                </a>
              ) : null}
            </p>
          ) : null}

          {firstRefused && shortfall ? (
            <div className={styles.banner} data-shortfall="">
              <CircleSlash size={icon.nav} aria-hidden="true" />
              <span className={styles.bannerWords}>
                <strong>{shortfallLines(firstRefused.name, shortfall).who}</strong>
                <span>{shortfallLines(firstRefused.name, shortfall).short}</span>
              </span>
              {replan.kind === "OPEN_BOARD" ? (
                <a className={styles.replan} href={replan.href} data-replan="">
                  {vanArrival.replan}
                </a>
              ) : null}
            </div>
          ) : null}

          <ul className={styles.riders}>
            {verdicts.map(({ rider, reason }, index) => {
              const verdict = riderVerdict(reason);
              return (
                <li key={rider.token} className={styles.rider} data-rider={rider.token}>
                  <span className={styles.riderStop}>{index + 1}</span>
                  <span className={styles.riderName}>{rider.name}</span>
                  <span className={styles.riderNeeds}>
                    <NeedIcons needs={rider.needs} size={icon.inline} />
                  </span>
                  <span className={styles.riderStopLabel}>{rider.stopLabel}</span>
                  <span className={styles.chip} data-tone={verdict.tone} data-verdict={reason ?? "FITS"}>
                    {reason ? (
                      <X size={icon.chip} aria-hidden="true" />
                    ) : (
                      <Check size={icon.chip} aria-hidden="true" />
                    )}
                    {verdict.label}
                  </span>
                </li>
              );
            })}
          </ul>
        </section>
      </div>
    </div>
  );
}
