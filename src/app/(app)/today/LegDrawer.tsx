"use client";

import { useEffect, useRef } from "react";
import { X } from "lucide-react";
import type { BoardRow, LegRow, NeedView, RideView } from "@/domain/board/board";
import { board as boardCopy, drawer, etaText, fill, needCategories } from "@/ui/copy";
import { SourceBadge } from "@/ui/SourceBadge";
import { StateChip } from "@/ui/StateChip";
import { capabilityStates, legStates, needItemStates, profileStates } from "@/ui/states";
import { clockLabel } from "@/ui/service-date";
import { icon } from "@/ui/tokens";
import { needsActionReasonText, nextStepText } from "./next-step";
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
  onClose,
}: {
  /** The child's rides, as rows of the board — so the panel and the rows cannot disagree. */
  legs: readonly LegRow[];
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
        {/* §7.1: a record carries its source, and the drawer header is one of the named places. */}
        <SourceBadge mode={row.sourceMode} />
        <button type="button" className={styles.drawerClose} onClick={onClose} ref={closeRef}>
          <X size={icon.inline} aria-hidden="true" />
          <span className="srOnly">{drawer.close}</span>
        </button>
      </header>

      <div className={styles.drawerBody}>
        <section className={styles.section}>
          <h3 className={styles.sectionHeading}>{drawer.ridesHeading}</h3>
          <ul className={styles.rideCards}>
            {legs.map((leg) => (
              <Ride key={leg.key} leg={leg} />
            ))}
          </ul>
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
          </>
        )}
        <p className={styles.caption}>{drawer.readOnly}</p>
      </footer>
    </aside>
  );
}

/**
 * One of the child's two rides: its state, its van, its window, its stop — and, where the ride
 * needs a person, why it does and the one step that answers it. The row carries the same step
 * in its "Next step" column at 1280 and hands that column to this panel below it (§4.1), so
 * this is where it has to be for the narrow widths to keep it.
 */
function Ride({ leg }: { leg: LegRow }) {
  const { ride } = leg;
  const step = nextStepText(leg);
  return (
    <li className={styles.rideCard}>
      <p className={styles.rideCardTitle}>
        <span>{ride.direction === "AM" ? drawer.amRide : drawer.pmRide}</span>{" "}
        <span className="tabularNums">{clockLabel(ride.plannedWindow)}</span>
      </p>
      <StateChip state={legStates[ride.state]} />
      {/* The van and who runs it — the half of §4.1's "provider/vehicle" the board's dense row
          leaves to the drawer. */}
      {ride.vehicleLabel === null ? (
        <p className={styles.muted}>{boardCopy.familyDrives}</p>
      ) : (
        <p className={styles.muted}>
          {fill(boardCopy.vanAndProvider, {
            van: ride.vehicleLabel,
            provider: ride.providerName ?? "",
          })}
        </p>
      )}
      <p className={styles.muted}>
        {ride.windowText === null
          ? etaText.pending
          : ride.etaPaused
            ? fill(etaText.paused, { window: ride.windowText })
            : ride.windowText}
      </p>
      {ride.stop === null ? null : <p className={styles.muted}>{ride.stop}</p>}
      {needsActionReasonText(leg).map((reason) => (
        <p key={reason} className={styles.blockedReason}>
          {reason}
        </p>
      ))}
      {step === null ? null : <p className={styles.nextStep}>{step}</p>}
    </li>
  );
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
  if (am.capability !== "VERIFIED" && am.mode !== "FAMILY") {
    return fill(drawer.handoffBlockedRamp, { child });
  }
  if (am.state !== "ARRIVED_DROPOFF" && am.state !== "HELD_NO_RECEIVER") {
    return fill(drawer.handoffBlockedNotArrived, { child });
  }
  return null;
}
