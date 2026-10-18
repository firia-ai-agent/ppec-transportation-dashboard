"use client";

/**
 * The ramp iPad's van arrival (redesign spec §2, demo goal 2).
 *
 * The front desk counts what is actually on the van — four steppers and a lift switch, pre-filled
 * with today's confirmed row if there is one and the van's shared-config defaults otherwise — and
 * confirms it. That Confirm is the whole point: it writes `vehicle_setup_day` as `CHECKED` for
 * **today**, which is the only thing that makes the coordinator's board plan this van on real
 * numbers. Nothing carries into tomorrow: an unconfirmed van is planned on its defaults and says
 * so (Firia/Veri, 2026-10-17 6:00 PM ET).
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
import type { Direction } from "@/domain/day/leg";
import { boardHref } from "@/modules/plan/when";
import type { ArrivalVan } from "./view";
import { planBoard, vanArrival } from "@/ui/copy";
import { COUNTER_ICON, COUNTER_LABEL, LIFT_ICON, NeedIcons } from "@/ui/equipment";
import { icon } from "@/ui/tokens";
import {
  confirmLabel,
  differsLine,
  leavesLine,
  riderVerdict,
  shortfallLines,
  whatsOn,
} from "./lines";
import styles from "./arrival.module.css";

/** This screen's own address, which its van tabs point back at with a different `?van=`. */
const RAMP_PATH = "/ramp-ipad";

export default function VanArrival({
  vans,
  selected,
  date,
  leg,
  canPlan,
}: {
  vans: readonly ArrivalVan[];
  /** The van being counted: the one the address names, or the first one. */
  selected: ArrivalVan;
  date: string;
  /**
   * The leg being checked, read from the address by the page (`?leg=`, Morning by default).
   * Every link this screen draws carries it on, so a tab, Re-plan and the board all stay on the
   * half of the day the front desk is standing in front of.
   */
  leg: Direction;
  /** Whether this role may open the planning board at all (§9.3 hides what they cannot use). */
  canPlan: boolean;
}) {
  /**
   * The steppers open on today's counts: the row the front desk confirmed earlier today if there
   * is one, and the van's DEFAULT from the shared config otherwise (6:00 PM ET ruling — never
   * yesterday's). `defaults` is what the warn hint compares against.
   */
  const defaults = selected.van.defaultSetup;
  const [draft, setDraft] = useState<VanSetup>(selected.van.setup);
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
    leg,
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
    <main className={styles.page}>
      {/*
        No title here: the frame draws the one `h1` this screen has, out of the same access-table
        label (src/ui/PageHeader.tsx, #74), so a second one was the same words twice.
      */}

      {/* The vans out on this leg, in van order: Van 1, Van 2, Van 3. */}
      <nav className={styles.tabs} aria-label={vanArrival.ridersHeading}>
        {vans.map((arrival) => (
          <a
            key={arrival.van.id}
            className={styles.tab}
            href={boardHref(RAMP_PATH, { date, leg, van: arrival.van.id })}
            aria-current={arrival.van.id === selected.van.id ? "page" : undefined}
            data-tab={arrival.van.id}
          >
            <span
              className={styles.tabSwatch}
              style={{ background: `var(--color-${arrival.van.colourToken})` }}
              aria-hidden="true"
            />
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
            const changed = value !== defaults[counter.key];
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
                    <small className={styles.planned}>{differsLine(defaults[counter.key])}</small>
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
            {confirmed ? vanArrival.confirmed : confirmLabel(selected.van.name)}
          </button>
        </section>

        <section className={styles.card} aria-labelledby="riders">
          <h2 className={styles.cardTitle} id="riders">
            {vanArrival.ridersHeading}
            <span className={styles.riderCount}>{selected.riders.length}</span>
            <span className={styles.leaves}>{leavesLine(selected.leavesMs)}</span>
          </h2>

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
    </main>
  );
}
