"use client";

import { useEffect, useRef } from "react";
import Link from "next/link";
import { familyThreadHref } from "@/auth/access";
import { MessagesSquare, X } from "lucide-react";
import type { BoardRow, LegRow, NeedView, RideView, ServiceDay } from "@/domain/board/board";
import {
  board as boardCopy,
  drawer,
  etaText,
  fill,
  liveMap,
  needCategories,
  onDay,
  places,
  planBoard,
  screenReader,
} from "@/ui/copy";
import { StateChip } from "@/ui/StateChip";
import { capabilityStates, legStates, needItemStates, profileStates, sourceModes } from "@/ui/states";
import { clockLabel } from "@/ui/service-date";
import { icon } from "@/ui/tokens";
import { needsActionReasonText, nextStepText, stateValues } from "./next-step";
import styles from "./today.module.css";

/**
 * SURF-02, the child's drawer (DESIGN-DIRECTION §4.2, PRD l.1059).
 *
 * Sections in the order §4.2 fixes them: today's rides, approved needs, the vehicle check,
 * who receives the child, what is waiting for a decision, what the assistant changed, history.
 * One primary action in a sticky footer — the handoff, named for the child it would commit —
 * and when it is disabled the reason is in text beside it rather than in a tooltip only
 * (§4.2, §9).
 *
 * Every person in here is named rather than described (COPY-GUIDE §1): the child, the adult the
 * family has on file to receive them, the dispatcher who can answer for a van. "An adult on
 * file may receive this child" is true of every family in the building; "Alma R., Mia R.'s
 * parent, may receive them." is the sentence a coordinator is actually checking. Nothing in
 * here carries a code, a ticket or a rule name — the fixture's own ids for a child, a family,
 * a run and a seat layout all stop at the fixture.
 *
 * It is an overlay, not a page: the board stays where it was behind it (§4.2 "keeps list
 * context"), Escape closes it, and focus moves into it on open and nowhere surprising after.
 */
export function LegDrawer({
  legs,
  day,
  hasTexts,
  onClose,
}: {
  /** The child's rides, as rows of the board — so the panel and the rows cannot disagree. */
  legs: readonly LegRow[];
  /** The day those rides are on: the panel's first heading may only say "Today" when it is. */
  day: ServiceDay;
  /** True when the day actually texted this child's family, so the link opens a thread with a text in it. */
  hasTexts: boolean;
  onClose: () => void;
}) {
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const row = legs[0].child;

  useEffect(() => {
    closeRef.current?.focus();
  }, [row.childKey]);

  const child = row.childLabel;
  const am = row.rides.find((r) => r.direction === "AM") ?? row.rides[0];
  const pm = row.rides.find((r) => r.direction === "PM") ?? row.rides[0];
  const blocked = handoffBlocker(row, am, pm);

  return (
    <aside
      className={styles.drawer}
      role="dialog"
      aria-label={fill(drawer.label, { child })}
      onKeyDown={(event) => {
        if (event.key === "Escape") onClose();
      }}
    >
      <header className={styles.drawerHeader}>
        <h2 className={styles.drawerTitle}>{child}</h2>
        {/*
          §7.1: a record carries its source, and the drawer header is one of the named places —
          for the ear. The one *visible* "Simulated" on a screen is the chip in the DEMO bar
          (Vera's review, 2026-10-17); a second one over the board it opens on top of would be
          the same word twice in one glance.
        */}
        <span className="srOnly">
          {fill(screenReader.source, { label: sourceModes[row.sourceMode].label })}
        </span>
        <button type="button" className={styles.drawerClose} onClick={onClose} ref={closeRef}>
          <X size={icon.inline} aria-hidden="true" />
          <span className="srOnly">{drawer.close}</span>
        </button>
      </header>

      <div className={styles.drawerBody}>
        <section className={styles.section}>
          {/*
            "Today's rides" on the day that is true of, and the day named on any other — the
            same rule as the board's own heading, because this panel opens over a board that may
            be about another day and is read without looking back at it.
          */}
          <h3 className={styles.sectionHeading}>
            {onDay({ today: drawer.ridesHeading, otherDay: drawer.ridesHeadingOtherDay }, day)}
          </h3>
          {/*
            The day in order, morning then afternoon: an ordered list, because that is what it
            is — two rides read one after the other, and the order is the information.
          */}
          <ol className={styles.timeline}>
            {legs.map((leg) => (
              <Ride key={leg.key} leg={leg} />
            ))}
          </ol>
        </section>

        <section className={styles.section}>
          <h3 className={styles.sectionHeading}>{drawer.needsHeading}</h3>
          <p className={styles.caption}>
            <StateChip
              state={profileStates.APPROVED}
              values={{ n: row.profileVersion }}
            />
          </p>
          {row.needs.length === 0 ? (
            <p className={styles.muted}>{fill(drawer.noNeeds, { child })}</p>
          ) : (
            <ul className={styles.needs}>
              {row.needs.map((need) => (
                <Need key={need.category} need={need} />
              ))}
            </ul>
          )}
          {/* §1 / PRD SURF-02: a transport need is never a diagnosis, and the screen says so. */}
          <p className={styles.caption}>{drawer.needsCaption}</p>
        </section>

        <section className={styles.section}>
          <h3 className={styles.sectionHeading}>{drawer.capabilityHeading}</h3>
          <StateChip state={capabilityStates[am.capability]} />
          <p className={styles.muted}>{capabilityEvidence(am)}</p>
          <p className={styles.muted}>{solverVerdict(am)}</p>
        </section>

        <section className={styles.section}>
          <h3 className={styles.sectionHeading}>{drawer.receiverHeading}</h3>
          <p data-missing={row.receivingAdult === null} className={styles.receiverLine}>
            {row.receivingAdult === null
              ? fill(drawer.receiverMissing, { child })
              : fill(drawer.receiverOnFile, {
                  adult: row.receivingAdult.name,
                  relationship: row.receivingAdult.relationship,
                  child,
                })}
          </p>
          {/* PRD §6.6 / the no-adult case: a child is held, never driven back on their own. */}
          <p className={styles.muted}>{fill(drawer.heldNoReturn, { child })}</p>
        </section>

        <section className={styles.section}>
          <h3 className={styles.sectionHeading}>{drawer.approvalsHeading}</h3>
          <p className={styles.muted}>{fill(drawer.noApprovals, { child })}</p>
        </section>

        <section className={styles.section}>
          <h3 className={styles.sectionHeading}>{drawer.agentHeading}</h3>
          <p className={styles.muted}>{fill(drawer.noAgentChanges, { child })}</p>
        </section>

        <section className={styles.section}>
          {/*
            What the family was told, in their own thread (§6.3). The link is only here when there
            is a text to read: a link that opened somebody else's thread, or an empty phone, would
            be worse than the sentence that says nothing was sent.
          */}
          <h3 className={styles.sectionHeading}>{drawer.textsHeading}</h3>
          {hasTexts ? (
            <Link className={styles.drawerLink} href={familyThreadHref(row.childKey)}>
              <MessagesSquare size={icon.inline} aria-hidden="true" />
              {fill(drawer.openTexts, { child })}
            </Link>
          ) : (
            <p className={styles.muted}>{fill(drawer.noTexts, { child })}</p>
          )}
        </section>

        <section className={styles.section}>
          <h3 className={styles.sectionHeading}>{drawer.historyHeading}</h3>
          <p className={styles.muted}>{fill(drawer.historyEmpty, { child })}</p>
        </section>
      </div>

      <footer className={styles.drawerFooter}>
        {/*
          §4.2: one primary action, and when it cannot be taken the reason is beside it in text.
          The custody handoff is a person's act naming the adult who received the child — a
          geofence arrival is never one (PRD SURF-01 acceptance), which is why this button
          exists at all rather than the board completing a ride by itself. It names the child,
          because the drawer opens over 56 rows and this is the control that would commit one.
        */}
        <button type="button" className={styles.primary} disabled={blocked !== null}>
          {fill(drawer.confirmHandoff, { child })}
        </button>
        {blocked === null ? null : (
          <>
            <p className={styles.blockedReason}>{blocked}</p>
            <button type="button" className={styles.secondary} disabled>
              {fill(drawer.overrideWithReason, { child })}
            </button>
            {/*
              And the override's own reason, under its own button (Vera, 2026-10-16). The line
              above belongs to the handoff; it was the only sentence beside this control too,
              which read as the child's missing receiver being what stops an override — a thing
              that is not true of it. Two disabled controls, two reasons, each under the button
              it is about.
            */}
            <p className={styles.blockedReason}>{drawer.overrideDisabled}</p>
          </>
        )}
        <p className={styles.caption}>{drawer.readOnly}</p>
      </footer>
    </aside>
  );
}

/**
 * One of the child's two rides, as a row of the day rather than as a card.
 *
 * The time it is planned for, where it runs between, and what state it is in — an icon and a
 * label like every other state on this screen (§3). The box is gone: a card draws a border
 * around a thing to say "this is a thing", and these two are halves of one day, which is what a
 * reader is here to see. Two rows under each other with the times in a column read as a day;
 * two bordered cards read as two records that happen to be adjacent.
 *
 * Underneath, the facts the row's own columns hand to this panel below 1280 (§4.1): the van and
 * who runs it, the window the family holds, and — where the ride needs a person — why it does
 * and the one step that answers it.
 */
function Ride({ leg }: { leg: LegRow }) {
  const { ride } = leg;
  const step = nextStepText(leg);
  const reasons = needsActionReasonText(leg);
  return (
    <li className={styles.ride}>
      {/*
        The plan's own time for this ride, in the column that makes the two read as a day. The
        eye gets "6:50 AM" (COPY-GUIDE §3); `dateTime` keeps the 24-hour form the plan is written
        in, which is the one a machine can read.
      */}
      <time dateTime={ride.plannedWindow} className={`${styles.rideTime} tabularNums`}>
        {clockLabel(ride.plannedWindow)}
      </time>
      <div className={styles.rideBody}>
        <p className={styles.rideTitle}>
          <span>{ride.direction === "AM" ? drawer.amRide : drawer.pmRide}</span>
          {ride.stop === null ? null : (
            <>
              <span aria-hidden="true"> · </span>
              <span className={styles.muted}>{ends(ride)}</span>
            </>
          )}
        </p>
        <StateChip state={legStates[ride.state]} values={stateValues(leg)} />
        <p className={styles.muted}>{vanLine(ride)}</p>
        {/*
          The published window, and only when a van on the road is publishing one: on a ride
          nobody has moved yet it is the plan's own time, which the row already carries in its
          time column, and printing "6:50 AM … 6:50–7:00 AM" twice says nothing the second time.
        */}
        {ride.windowText === null || (ride.deltaSeconds === null && !ride.etaPaused) ? null : (
          <p className={`${styles.muted} tabularNums`}>
            {ride.etaPaused ? fill(etaText.paused, { window: ride.windowText }) : ride.windowText}
          </p>
        )}
        {reasons.map((reason) => (
          <p key={reason} className={styles.blockedReason}>
            {reason}
          </p>
        ))}
        {step === null ? null : <p className={styles.nextStep}>{step}</p>}
      </div>
    </li>
  );
}

/**
 * Where the ride runs between, in travel order: a morning collects the child at their own stop
 * and sets them down at the centre, and an afternoon is the reverse. The centre is named and
 * never addressed (COPY-GUIDE §7), and the child's stop is the public landmark the scenario
 * gives it — no home ever appears on a screen.
 */
function ends(ride: RideView): string {
  const stop = ride.stop ?? places.center;
  return ride.direction === "AM"
    ? fill(drawer.rideFromTo, { from: stop, to: places.center })
    : fill(drawer.rideFromTo, { from: places.center, to: stop });
}

/**
 * THE VAN, NAMED THE WAY THE REST OF THE APP NAMES ONE — "Van 3 · Nadia P.".
 *
 * This line said "Van 3 · Coastal Car Service" until Firia read it (2026-10-18 3:04 AM ET).
 * The provider is a fact about who is contracted, not the person a coordinator is trying to
 * reach about a child on the road — and the board and the live map had already settled on the
 * number on the door and the driver (`liveMap.vanName`, the one key for this phrase, filled
 * with the driver through the one name helper, src/ui/display-name.ts `shortName`). A second
 * phrasing in the drawer is the same van with two names in one app.
 *
 * The van that the fleet config does not number is named by its label alone rather than
 * "Van 3 · " with nobody after it: the drawer says what it knows.
 */
function vanLine(ride: RideView): string {
  // No van, and the two different reasons for it: the family is driving, or the saved plan has
  // not given this child a van yet (the board's own Unassigned, src/modules/plan/store.ts).
  if (ride.vehicleLabel === null) {
    return ride.mode === "FAMILY" ? boardCopy.familyDrives : planBoard.unassigned;
  }
  if (ride.vanNumber === null || ride.driverName === null) return ride.vehicleLabel;
  return fill(liveMap.vanName, { number: ride.vanNumber, driver: ride.driverName });
}

function Need({ need }: { need: NeedView }) {
  return (
    <li className={styles.need} data-approved={need.usedForAllocation}>
      <span className={styles.needName}>{needCategories[need.category]}</span>
      <StateChip state={needItemStates[need.state]} />
      {need.usedForAllocation ? null : (
        <>
          <span className={styles.muted}>{drawer.needNotApproved}</span>
          <span className={styles.muted}>{drawer.needNotUsed}</span>
        </>
      )}
    </li>
  );
}

/**
 * §5: "Reported by Hal B. at SYN Palm Lift Transport. Not checked at the ramp." — honest about
 * which kind of evidence this is, and whose it is.
 */
function capabilityEvidence(ride: RideView): string {
  switch (ride.capability) {
    case "VERIFIED":
      return drawer.capabilityVerified;
    case "REPORTED":
      return fill(drawer.capabilityReported, {
        dispatcher: ride.providerDispatcher ?? "",
        provider: ride.providerName ?? "",
      });
    default:
      return drawer.capabilityUnknown;
  }
}

function solverVerdict(ride: RideView): string {
  if (ride.solver === "FEASIBLE") return drawer.fits;
  if (ride.solver === "INFEASIBLE" || ride.solver === "VEHICLE_UNAVAILABLE") {
    return drawer.doesNotFit;
  }
  return ride.solverPendingReason ?? drawer.capabilityUnknown;
}

/**
 * Why the handoff cannot be confirmed, or null when it can.
 *
 * §4.2 names one of these — in transit without a ramp verification — and the other two follow
 * from the same rule: a handoff is a custody event naming the adult who received the child, so
 * there is nothing to confirm before the van is there, and nobody to name when no adult on
 * file may receive them (PRD §6.6). Each one opens with a verb and names the child, because a
 * disabled button is only useful if it says what would make it work.
 */
function handoffBlocker(row: BoardRow, am: RideView, pm: RideView): string | null {
  const child = row.childLabel;
  if (row.receivingAdult === null && pm.mode !== "FAMILY") {
    return fill(drawer.handoffBlockedNoReceiver, { child });
  }
  // The ride a handoff would be confirmed for is the one whose van is actually at the drop-off;
  // with neither there, the morning is what the panel is waiting on.
  const ride = row.rides.find(waitingForAHandoff) ?? am;
  if (ride.capability !== "VERIFIED" && ride.mode !== "FAMILY") {
    return fill(drawer.handoffBlockedRamp, { child });
  }
  if (!waitingForAHandoff(ride)) {
    return fill(drawer.handoffBlockedNotArrived, { child });
  }
  // Everything the day could ask for is satisfied — and this slice still does not write. Said on
  // the button rather than discovered by clicking it.
  return drawer.handoffBlockedNotConnected;
}

/**
 * A ride whose van is at the drop-off and whose child has not been received: the arrival and the
 * hold, and nothing else. A handed-off ride is not waiting for a handoff, and a van still on the
 * road has nothing to confirm (AT-10: the arrival is what a geofence may say, and all of it).
 */
function waitingForAHandoff(ride: RideView): boolean {
  return ride.state === "ARRIVED_DROPOFF" || ride.state === "HELD_NO_RECEIVER";
}
