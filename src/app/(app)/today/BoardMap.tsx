"use client";

/**
 * The map pane beside the rows (DESIGN-DIRECTION §4.1 split pane, §5; PRD §14 SURF-01 "map
 * right 40%").
 *
 * The pane itself is src/components/map/FleetMap.tsx, which is the only module that talks to
 * MapLibre; this is the board's half of the link between a row and a marker, plus the three
 * things the map cannot say in a canvas and which a demo has to be able to show:
 *
 *  - **the vans that are not drawn**, named, with the reason — an unlinked device has no
 *    position anybody may display, so it is absent from the map and present here (LOC-01);
 *  - **what ingest did with each van's points**: used, and how many were dropped as duplicates
 *    or as out-of-order arrivals (AT-11, ADR-013). Otherwise that rule is a claim about a seam
 *    nobody can see;
 *  - **the windows the gate has moved**, which is the damped notification AT-03 is about —
 *    decisions only, and the line above the list says so.
 *
 * The pane folds away (§4.1 "collapsible"), and folding it does not disconnect anything: the
 * rows keep updating, because the stream belongs to the shell and not to this component.
 */

import { useState } from "react";
import FleetMap from "@/components/map/FleetMap";
import { mapFixtureFrom } from "@/components/map/live-fixture";
import { formatClock } from "@/domain/eta/eta";
import type { LiveSnapshot } from "@/domain/board/live";
import { board as copy, fill } from "@/ui/copy";
import styles from "./today.module.css";

export function BoardMap({
  snapshot,
  selectedVanId,
  highlightVanId,
  onSelectVan,
}: {
  snapshot: LiveSnapshot;
  /** The van of the ride whose drawer is open: the pane rings it and flies to it. */
  selectedVanId: string | null;
  /** The van of the row under the pointer or the keyboard focus: ringed, no camera move. */
  highlightVanId: string | null;
  onSelectVan: (id: string) => void;
}) {
  const [shown, setShown] = useState(true);
  const fixture = mapFixtureFrom(snapshot);

  return (
    <section className={styles.mapPane} aria-label={copy.mapHeading}>
      <div className={styles.mapHeader}>
        <h2 className={styles.mapHeading}>{copy.mapHeading}</h2>
        <button
          type="button"
          className={styles.mapToggle}
          aria-expanded={shown}
          onClick={() => setShown((on) => !on)}
        >
          {shown ? copy.hideMap : copy.showMap}
        </button>
      </div>

      {shown ? (
        <>
          <p className={styles.mapHint}>{copy.mapHint}</p>
          <FleetMap
            fixture={fixture}
            label={copy.mapLabel}
            selectedVehicleId={selectedVanId}
            highlightVehicleId={highlightVanId}
            onSelectVehicle={onSelectVan}
          />

          {/* AT-11 / ADR-013, in numbers the seam itself produced. */}
          <ul className={styles.mapNotes}>
            {snapshot.vehicles.map((vehicle) => {
              const dropped = vehicle.counts.duplicate + vehicle.counts.outOfOrder;
              return (
                <li key={vehicle.id} data-van={vehicle.id}>
                  {fill(copy.pointsRow, {
                    van: vehicle.id,
                    used: fill(copy.pointsUsed, { accepted: vehicle.counts.accepted }),
                    dropped:
                      dropped === 0
                        ? copy.pointsNoneDropped
                        : fill(copy.pointsDropped, {
                            dropped,
                            duplicate: vehicle.counts.duplicate,
                            outOfOrder: vehicle.counts.outOfOrder,
                          }),
                  })}
                </li>
              );
            })}
          </ul>

          {snapshot.silent.length > 0 ? (
            <div className={styles.mapNotes}>
              <h3 className={styles.mapSubheading}>{copy.mapSilentHeading}</h3>
              <ul>
                {snapshot.silent.map((van) => (
                  <li key={van.id} data-silent-van={van.id}>
                    {fill(copy.mapSilent, { van: van.id })}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          <div className={styles.mapNotes}>
            <h3 className={styles.mapSubheading}>{copy.updatesHeading}</h3>
            <p className={styles.mapHint}>{copy.updatesIntro}</p>
            {snapshot.notifications.length === 0 ? (
              <p data-updates="none">{copy.updatesEmpty}</p>
            ) : (
              <ul>
                {snapshot.notifications.map((update) => (
                  <li key={`${update.vehicleId}-${update.stopId}-${update.atMs}`} data-update>
                    {fill(copy.updateRow, {
                      time: formatClock(update.atMs),
                      vehicle: update.vehicleId,
                      family: update.familyLabel ?? "",
                      shift: update.shiftText,
                      window: update.windowText ?? "",
                    })}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      ) : null}
    </section>
  );
}
