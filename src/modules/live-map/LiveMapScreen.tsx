"use client";

/**
 * THE LIVE MAP, as the founder drew it (mockups/live-map.html; png/live-map.png at 1440,
 * png/live-map-390.png at 390).
 *
 * A 320 px list of vans beside the map at 1440, the map on top with the vans as cards below it
 * at 390. Each van gets its number, its driver, where it is going next, how many kids are still
 * aboard, a stop-progress bar and **exactly one state chip**: On route, At stop, Late, No GPS.
 * Under the list, the Auto texts feed. In the frame's header bar, the leg switch and the three
 * state counts, which are also the list's filters.
 *
 * **No ETA.** Not a time, not a window, not "+12 min", not "last seen 4 min". REDESIGN-SPEC §3
 * deletes the 13-field ETA line and the 41-word "Decisions only…" paragraph from this screen,
 * and Firia's goal-5 brief deletes the rest: a coordinator is told where the van is and whether
 * it needs them, and the time it will arrive is a promise this build does not make on screen.
 * e2e/live-map.spec.ts asserts the absence over the whole DOM.
 *
 * Everything decidable without a browser is decided in ./day.ts and ./van-state.ts, from the
 * simulated source behind the domain location interface. This component owns a clock reading,
 * a filter and a selection, and nothing else.
 */

import { useMemo, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { MapPin } from "lucide-react";
import { formatClock } from "@/domain/eta/eta";
import type { VanChip } from "@/domain/location/van-chip";
import { fill, liveMap, planRoutes } from "@/ui/copy";
import { useDemoClock } from "@/ui/demo-clock";
import { boardHref } from "@/modules/plan/when";
import { HeaderSlot } from "@/ui/HeaderSlot";
import { Pill, PillLabel } from "@/ui/Pill";
import { icon } from "@/ui/tokens";
import { liveDayAt, type LiveVan } from "./day";
import LiveMapPane from "./LiveMapPane";
import { colorForVan } from "./map-layers";
import { matchesFilter, type VanFilter } from "./van-state";
import styles from "./live-map.module.css";

const MOTION_QUERY = "(prefers-reduced-motion: reduce)";

function subscribeMotion(onChange: () => void): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => {};
  const query = window.matchMedia(MOTION_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

function readMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia(MOTION_QUERY).matches;
}

/** §9/§5.1: honoured live, so a mid-session OS change takes effect without a reload. */
function useReducedMotion(): boolean {
  return useSyncExternalStore(subscribeMotion, readMotion, () => false);
}

/**
 * The four chips, and the tone each wears.
 *
 * Teal for running, slate for standing, red for late, grey for lost — the mockup's `.s-route`,
 * `.s-stop`, `.s-late`, `.s-nogps` mapped onto the five §8 tones the one pill already has, so
 * this screen grows no chip of its own (audit §4.1; src/ui/pill.test.ts holds it).
 */
const CHIP_TONE: Record<VanChip, "info" | "neutral" | "crit"> = {
  onRoute: "info",
  atStop: "neutral",
  late: "crit",
  noGps: "neutral",
};

export interface LiveMapScreenProps {
  /** The service date being looked at, in the centre's time zone (src/modules/plan/when.ts). */
  date: string;
  /** The leg the address names, or the one the centre's own clock defaults to (§9.1). */
  leg: "AM" | "PM";
  /** True for a role allowed to see which family a text went to (map-view.ts). */
  familyLabels: boolean;
  /**
   * Is a plan saved for this date and leg? The hard gate (§9.1): without one there are no routes
   * to draw, so the map keeps its centre pin and the locked card sits over it.
   */
  unlocked: boolean;
  /**
   * How many children the SAVED PLAN puts in each van, keyed by the fixture's van key. The list's
   * "· 2 kids" is the coordinator's own decision when there is one, rather than a count derived
   * from a route fixture. Empty while the screen is locked, because there is nothing to read.
   */
  kidsByVan: Readonly<Record<string, number>>;
  /** Overlaid over the map when this leg has no saved plan: ./LockedCard.tsx. */
  locked?: React.ReactNode;
}

export default function LiveMapScreen({
  date,
  leg,
  familyLabels,
  unlocked,
  kidsByVan,
  locked,
}: LiveMapScreenProps) {
  const reduced = useReducedMotion();
  /*
   * THE CLOCK IS THE DEMO BAR'S (Firia, 2026-10-17 8:36 PM ET). This screen used to own it and
   * draw Pause / ×1 / ×10 / ×60 / Restart above the map; it reads the shared store now
   * (src/ui/demo-clock.ts) and the bar draws it, so the vans move to the time the bar shows and
   * there is one clock rather than two. There are no scenario or demo controls on this screen —
   * which is also what makes it safe as the front desk's home page.
   */
  const { seconds } = useDemoClock();
  const [filter, setFilter] = useState<VanFilter>("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const day = useMemo(
    () => liveDayAt(seconds, { tween: !reduced, familyLabels, kidsByVan }),
    [seconds, reduced, familyLabels, kidsByVan],
  );

  /*
   * Locked means there is no saved plan for this leg, so there is nothing to list: no vans, no
   * counts, no feed. The map keeps its centre pin and the card sits over it (§9.5), which is the
   * acceptance walk's "never a blank map" — and the list is honestly empty rather than showing a
   * fleet the coordinator has not committed to.
   */
  const vans = unlocked ? day.vans : [];
  const counts = unlocked ? day.counts : { all: 0, onRoute: 0, late: 0, noGps: 0 };
  const shown = vans.filter((van) => matchesFilter(van.chip, filter));
  const feed = unlocked ? day.feed : [];

  return (
    <>
      {/*
        The leg switch and the three counts live in the frame's 64 px header bar beside the
        title, which is where the mockup draws them — not in a strip of this screen's own.
        src/ui/HeaderSlot.tsx says how a page reaches a bar its layout mounted.
      */}
      <HeaderSlot>
        {/*
          The leg switch is two LINKS, not two buttons: which leg you are on decides which saved
          plan the server reads, so it belongs in the address (§9.3 — "deep links keep state in
          the URL"). A reload, a bookmark and a second tab all land on the same leg, and
          src/modules/plan/when.ts is the one thing that parses it.
        */}
        <span className={styles.seg} role="group" aria-label={liveMap.legLabel}>
          {(["AM", "PM"] as const).map((option) => (
            <Link
              key={option}
              href={boardHref("/live-map", { date, leg: option })}
              className={styles.segOption}
              aria-current={leg === option ? "page" : undefined}
              data-on={leg === option ? "true" : undefined}
            >
              {planRoutes.directionButton[option]}
            </Link>
          ))}
        </span>
        {/*
          The counts, which are a readout and not a second set of filters: the filters are the
          row above the list, where a thumb reaches them at 390 (png/live-map-390.png, where
          these counts are not drawn at all).
        */}
        <span className={styles.counts} aria-live="polite">
          <Pill tone="info">
            <PillLabel>{fill(liveMap.countOnRoute, { count: counts.onRoute })}</PillLabel>
          </Pill>
          <Pill tone="crit">
            <PillLabel>{fill(liveMap.countLate, { count: counts.late })}</PillLabel>
          </Pill>
          <Pill tone="neutral">
            <PillLabel>{fill(liveMap.countNoGps, { count: counts.noGps })}</PillLabel>
          </Pill>
        </span>
      </HeaderSlot>

      <div className={styles.work}>
        <aside className={styles.side}>
          <div className={styles.filters} role="group" aria-label={liveMap.filterLabel}>
            {(
              [
                ["all", fill(liveMap.filterAll, { count: counts.all })],
                ["late", liveMap.filterLate],
                ["noGps", liveMap.filterNoGps],
              ] as const
            ).map(([key, label]) => (
              /*
                A filter is THE ONE PILL in a bare button, not a chip of its own.
                The mockup draws these at 28 px (`.sh .chip`), and the audit's §4.1 rule — one
                pill, 22 px, everywhere, which the test contract repeats as a global check on
                every screen — is the one that binds. So the button carries no shape, no height
                and no padding; the pill inside it carries all three, and the tone says which
                filter is on. (src/ui/pill.test.ts fails if this screen grows its own.)
              */
              <button
                key={key}
                type="button"
                className={styles.filter}
                aria-pressed={filter === key}
                onClick={() => setFilter(key)}
              >
                <Pill tone={filter === key ? "info" : "neutral"}>
                  <PillLabel>{label}</PillLabel>
                </Pill>
              </button>
            ))}
          </div>

          <ul className={styles.vans} aria-label={liveMap.vansHeading}>
            {shown.map((van) => (
              <VanRow
                key={van.id}
                van={van}
                selected={selectedId === van.id}
                onSelect={() => setSelectedId(van.id)}
              />
            ))}
          </ul>
          {shown.length === 0 ? <p className={styles.empty}>{liveMap.filterEmpty}</p> : null}

          <section className={styles.feed} aria-label={liveMap.feedHeading}>
            <h2 className={styles.feedHeading}>{liveMap.feedHeading}</h2>
            {feed.length === 0 ? (
              <p className={styles.empty}>{liveMap.feedEmpty}</p>
            ) : (
              <ul className={styles.feedList}>
                {feed.slice(0, 3).map((row) => (
                  <li key={row.key} className={styles.feedRow}>
                    <span className={styles.feedTime}>{formatClock(row.atMs)}</span>
                    <span className={styles.feedWho}>
                      {/* A role that may not see family names gets the van alone — the label is
                          absent from the data, not hidden here (src/domain/access/map-view.ts). */}
                      {row.familyLabel
                        ? fill(liveMap.feedWho, {
                            family: row.familyLabel,
                            van: fill(liveMap.vanNumber, { number: row.vanNumber }),
                          })
                        : fill(liveMap.vanNumber, { number: row.vanNumber })}
                    </span>
                    <Pill tone="neutral">
                      <PillLabel>{liveMap.filterLate}</PillLabel>
                    </Pill>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </aside>

        <LiveMapPane
          vans={vans}
          center={day.center}
          centerLabel={liveMap.centerLabel}
          label={liveMap.mapLabel}
          selectedId={selectedId}
          onSelect={setSelectedId}
        >
          {locked}
          <Legend />
        </LiveMapPane>
      </div>
    </>
  );
}

/**
 * One van in the list.
 *
 * The whole row is the button, because the whole row is the target (§9: ≥44 px). Its accessible
 * name is "Van 1 · Marco D." — the two halves the eye reads apart, as one phrase for a screen
 * reader and for a test. The square beside the name is the van's own colour, which is the same
 * colour as its line and its pin on the map (Firia, 11:25 PM ET).
 *
 * A SELECTED row takes a border and a tint of the *frame's* selected colour, never a fill in the
 * van's own: the van's colour means which van, and nothing else may borrow it.
 */
function VanRow({
  van,
  selected,
  onSelect,
}: {
  van: LiveVan;
  selected: boolean;
  onSelect: () => void;
}) {
  const kids = van.kids === 1 ? liveMap.kidsOne : fill(liveMap.kids, { count: van.kids });
  return (
    <li>
      <button
        type="button"
        className={styles.van}
        aria-pressed={selected}
        aria-label={fill(liveMap.vanName, { number: van.number, driver: van.driver })}
        data-van-chip={van.chip}
        onClick={onSelect}
      >
        <span className={styles.vanTitle}>
          <span
            className={styles.vanSwatch}
            data-van-swatch={van.number}
            style={{ background: colorForVan(van.number) }}
            aria-hidden="true"
          />
          <span className={styles.vanNumber}>
            {fill(liveMap.vanNumber, { number: van.number })}
          </span>
          <span className={styles.vanDriver}>{van.driver}</span>
        </span>
        <Pill tone={CHIP_TONE[van.chip]}>
          <PillLabel>{liveMap.chips[van.chip]}</PillLabel>
        </Pill>
        <span className={styles.vanNext}>
          <MapPin size={icon.chip} aria-hidden="true" />
          {fill(liveMap.vanNext, { stop: van.nextStop, kids })}
        </span>
        {/* The bar is a picture of what the line above already says, so it is named for a
            screen reader rather than being a second, silent fact (§9). */}
        <span
          className={styles.progress}
          role="img"
          aria-label={fill(liveMap.progress, { done: van.done, total: van.total })}
        >
          {Array.from({ length: van.total }, (_, i) => (
            <span key={i} className={styles.progressStep} data-done={i < van.done ? "true" : undefined} />
          ))}
        </span>
      </button>
    </li>
  );
}

/**
 * The map's legend (mockups/live-map.html `.legend`): the four states as four marker shapes.
 *
 * It is not the van palette — a legend of colours would say which van, and the four things a
 * marker can *be* are states. The shapes are the map's own: a filled disc for a van we can see,
 * a hollow ring for one we cannot.
 */
function Legend() {
  return (
    <div className={styles.legend} role="group" aria-label={liveMap.legendHeading}>
      {(["onRoute", "atStop", "late", "noGps"] as const).map((chip) => (
        <span key={chip} className={styles.legendItem}>
          <span className={styles.legendDot} data-chip={chip} aria-hidden="true" />
          {liveMap.chips[chip]}
        </span>
      ))}
    </div>
  );
}
