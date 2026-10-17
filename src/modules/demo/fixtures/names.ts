/**
 * The names the demo's surfaces print: one child's name and one van's name, read off the
 * standard scenario (./standard.ts) and nowhere else.
 *
 * Three surfaces show the same day — the Today board (SURF-01), the ramp check (SURF-04) and the
 * map preview — and until this file each of them carried its own list. So the child the board
 * called "Noah O." was "Noah B." at the ramp, and the van the board called "V1 · SYN Palm Lift
 * Transport" was "V1 · Provider P1" on the map: one scenario, three vocabularies, and a demo
 * walk where the same ride changes name as the reviewer changes screen.
 *
 * Only names live here. What a van can carry and what a chair measures are capability facts and
 * stay with the fixtures that own them (src/fixtures/fleet.ts for the solver's geometry); this
 * module answers "what does a screen call it", which has exactly one right answer per entity.
 *
 * Pure data lookups: no clock, no database, no network. Every name is synthetic and is first
 * name plus last initial (ADR-015, DECISION-LEDGER row 31).
 */

import { PROVIDERS, VEHICLES, childByKey, type Vehicle } from "./standard";

/**
 * A van's name, in the pieces a screen uses.
 *
 * The scenario writes a vehicle as one string — "V1 convertible van" — because that is how a
 * coordinator says it out loud. A screen needs the two halves apart: a tile shows the label and a
 * sentence shows the words ("the convertible van", `vanName` in src/ui/copy.ts), so the split
 * happens once, here, instead of in each surface's own fixture.
 */
export type VanName = {
  /** "V1" — the id every surface shows and the board's `data-van`. */
  label: string;
  /** "convertible van" — what it is, in plain words, lower case for mid-sentence use. */
  description: string;
  /** "P1" — the provider's key, which the fixtures also use as its id. */
  providerId: string;
  /** "SYN Palm Lift Transport" — who runs it, as the scenario names them. */
  providerName: string;
};

/** The staff-visible name of one child: "Mia R." (COPY-GUIDE §3). */
export function childName(key: string): string {
  return childByKey(key).label;
}

/** The name of one van, from the scenario's own vehicle record. */
export function vanNameOf(vehicle: Vehicle): VanName {
  const provider = PROVIDERS.find((p) => p.key === vehicle.providerKey);
  if (!provider) throw new Error(`unknown provider ${vehicle.providerKey}`);
  const [label, ...rest] = vehicle.label.split(" ");
  return {
    label,
    description: rest.join(" "),
    providerId: provider.key,
    providerName: provider.name,
  };
}

/** The name of one van, by key ("V1"). */
export function vanName(key: string): VanName {
  const vehicle = VEHICLES.find((v) => v.key === key);
  if (!vehicle) throw new Error(`unknown vehicle ${key}`);
  return vanNameOf(vehicle);
}
