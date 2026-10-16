"use client";

import { useEffect, useRef } from "react";
import { X } from "lucide-react";
import type { BoardRow, NeedView, RideView } from "@/domain/board/board";
import { board as boardCopy, drawer, etaText, fill, needCategories } from "@/ui/copy";
import { SourceBadge } from "@/ui/SourceBadge";
import { StateChip } from "@/ui/StateChip";
import { capabilityStates, legStates, needItemStates, profileStates } from "@/ui/states";
import { clockLabel } from "@/ui/service-date";
import { icon } from "@/ui/tokens";
import styles from "./today.module.css";

/**
 * SURF-02, the child's drawer (DESIGN-DIRECTION §4.2, PRD l.1059).
 *
 * Sections in the order §4.2 fixes them: today's rides, approved needs, the vehicle check,
 * who receives the child, what is waiting for a decision, what the assistant changed, history.
 * One primary action in a sticky footer — "Confirm handoff" — and when it is disabled the
 * reason is in text beside it rather than in a tooltip only (§4.2, §9).
 *
 * It is an overlay, not a page: the board stays where it was behind it (§4.2 "keeps list
 * context"), Escape closes it, and focus moves into it on open and nowhere surprising after.
 */
export function LegDrawer({ row, onClose }: { row: BoardRow; onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    closeRef.current?.focus();
  }, [row.childKey]);

  const am = row.rides.find((r) => r.direction === "AM") ?? row.rides[0];
  const pm = row.rides.find((r) => r.direction === "PM") ?? row.rides[0];
  const blocked = handoffBlocker(row, am, pm);

  return (
    <aside
      className={styles.drawer}
      role="dialog"
      aria-label={fill(drawer.label, { child: row.childLabel })}
      onKeyDown={(event) => {
        if (event.key === "Escape") onClose();
      }}
    >
      <header className={styles.drawerHeader}>
        <h2 className={styles.drawerTitle}>{row.childLabel}</h2>
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
            {row.rides.map((ride) => (
              <li key={ride.direction} className={styles.rideCard}>
                <p className={styles.rideCardTitle}>
                  <span>{ride.direction === "AM" ? drawer.amRide : drawer.pmRide}</span>{" "}
                  <span className="tabularNums">{clockLabel(ride.plannedWindow)}</span>
                </p>
                <StateChip state={legStates[ride.state]} />
                {/* The van and who runs it — the half of §4.1's "provider/vehicle" the board's
                    two-line row leaves to the drawer. */}
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
              </li>
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
            <p className={styles.muted}>{drawer.noNeeds}</p>
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
          <p data-missing={!row.receivingAdultOnFile} className={styles.receiverLine}>
            {row.receivingAdultOnFile ? drawer.receiverOnFile : drawer.receiverMissing}
          </p>
          {/* PRD §6.6 / the no-adult case: a child is held, never driven back on their own. */}
          <p className={styles.muted}>{drawer.heldNoReturn}</p>
        </section>

        <section className={styles.section}>
          <h3 className={styles.sectionHeading}>{drawer.approvalsHeading}</h3>
          <p className={styles.muted}>{drawer.noApprovals}</p>
        </section>

        <section className={styles.section}>
          <h3 className={styles.sectionHeading}>{drawer.agentHeading}</h3>
          <p className={styles.muted}>{drawer.noAgentChanges}</p>
        </section>

        <section className={styles.section}>
          <h3 className={styles.sectionHeading}>{drawer.historyHeading}</h3>
          <p className={styles.muted}>{drawer.historyEmpty}</p>
        </section>
      </div>

      <footer className={styles.drawerFooter}>
        {/*
          §4.2: one primary action, and when it cannot be taken the reason is beside it in text.
          The custody handoff is a person's act naming the adult who received the child — a
          geofence arrival is never one (PRD SURF-01 acceptance), which is why this button
          exists at all rather than the board completing a ride by itself.
        */}
        <button type="button" className={styles.primary} disabled={blocked !== null}>
          {drawer.confirmHandoff}
        </button>
        {blocked === null ? null : (
          <>
            <p className={styles.blockedReason}>{blocked}</p>
            <button type="button" className={styles.secondary} disabled>
              {drawer.overrideWithReason}
            </button>
          </>
        )}
        <p className={styles.caption}>{drawer.readOnly}</p>
      </footer>
    </aside>
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

/** §5: "Reported by provider, not checked at the ramp." — honest about which it is. */
function capabilityEvidence(ride: RideView): string {
  switch (ride.capability) {
    case "VERIFIED":
      return drawer.capabilityVerified;
    case "REPORTED":
      return drawer.capabilityReported;
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
 * Why "Confirm handoff" cannot be pressed, or null when it can.
 *
 * §4.2 names one of these — in transit without a ramp verification — and the other two follow
 * from the same rule: a handoff is a custody event naming the adult who received the child, so
 * there is nothing to confirm before the van is there, and nobody to name when no adult on
 * file may receive them (PRD §6.6).
 */
function handoffBlocker(row: BoardRow, am: RideView, pm: RideView): string | null {
  if (!row.receivingAdultOnFile && pm.mode !== "FAMILY") return drawer.handoffBlockedNoReceiver;
  if (am.capability !== "VERIFIED" && am.mode !== "FAMILY") return drawer.handoffBlockedRamp;
  if (am.state !== "ARRIVED_DROPOFF" && am.state !== "HELD_NO_RECEIVER") {
    return drawer.handoffBlockedNotArrived;
  }
  return null;
}
