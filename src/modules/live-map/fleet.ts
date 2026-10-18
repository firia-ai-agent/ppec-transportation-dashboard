/**
 * THE LIVE MAP'S FLEET: three vans, and only ever three.
 *
 * Firia's ruling (2026-10-18): **the demo has exactly 3 vans.** #73's seed removes the spare van
 * and makes Van 3 a generic van, and this screen must not draw a fourth "reserve" van or
 * reference slot 4 at all. Vera's 12:30 AM ET walk is why it is a ruling: the map was reading
 * `DEMO_RUNS`, which is #53's *four*-run fixture, and filtering the fourth out at render time by
 * whether its device happened to be bound. A fleet that is three vans because one of them is
 * invisible is one fixture edit away from being four.
 *
 * So the live map declares its own fleet here instead, as three entries, and never iterates
 * `DEMO_RUNS`. There is no V4 in this file, no index 3, and no "spare": a fourth van cannot
 * appear on this screen without somebody adding a fourth line to the list below, which
 * fleet.test.ts refuses.
 *
 * ───────────────────────── why Van 3 drives route 1 ─────────────────────────
 *
 * #53's third run was `route2-substitute`: the *reserve* van's road, deliberately given route
 * 2's own geometry so the two could not drift (src/fixtures/replays.ts). That made Van 3 the
 * held-back substitute — which is exactly what Firia's ruling removes — and it had a visible
 * cost on the mockup besides: two of the three vans drove the same line, so Van 1's blue route
 * was hidden underneath Van 3's pink one and png/live-map.png's three separate roads were two.
 *
 * With the spare van gone, route 1 — R3's morning, the Greenacres library and John Prince Park,
 * which is the stop png/live-map.png itself names — is a real run with nobody on it. Van 3 takes
 * it, under its own device, as a generic van. Three vans, three roads, three colours.
 *
 * Nothing here is sent anywhere and nothing is written to a database: every position is the
 * simulated source behind the domain location interface, which is what the one "Simulated" chip
 * in the DEMO bar says (§7.1, NFR-09).
 */
import type { ReplaySpec } from "@/domain/eta/replay";
import type { Route } from "@/domain/location/route";
import { ROUTE_1 } from "@/fixtures/routes";
import { RUN_GPS_GAP, RUN_STALL, SCENARIO_START_MS } from "@/fixtures/replays";

/**
 * Van 3's road: route 1's geometry under Van 3's own device.
 *
 * A third *route* rather than a third fixture run, for the same reason #53 built its substitute
 * that way — the geometry is route 1's, so the two cannot drift — but without the substitution.
 * This van is not standing in for anybody.
 *
 * It keeps the jitter fault #53's third run carried (AT-03's other half: ±40 m must move the
 * marker and not the ETA text), because that behaviour is still worth having on the demo day and
 * this is the run that has always carried it.
 */
export const VAN_3_ROUTE: Route = {
  ...ROUTE_1,
  id: "route1-van3",
  vehicleId: "V3",
  deviceId: "DEV-V3",
};

const RUN_VAN_3: ReplaySpec = {
  route: VAN_3_ROUTE,
  startAtMs: SCENARIO_START_MS,
  seed: 42,
  faults: [{ kind: "jitter", atSimSeconds: 0, meters: 40 }],
};

/**
 * THE THREE VANS, in the order they are numbered on screen.
 *
 * The index is the van's number minus one, and the number is what the list, the map pin and the
 * colour all key off — so Van 1 is the first entry here, wears `VAN_COLORS.van1`, and is the van
 * a coordinator reads as blue on every screen.
 *
 * `vehicleId` is the data's own key for the van ("V1"). It is internal: it joins the simulated
 * run to the saved plan's `ops.vehicle` row and it never reaches the screen, which the test
 * contract lints for (`/\bV\d\b/`).
 */
export const LIVE_FLEET: ReadonlyArray<{ vehicleId: string; spec: ReplaySpec }> = [
  /* Van 1 — PRD §18.2 step 7's replayed stall, which is what makes one van read "Late". */
  { vehicleId: "V1", spec: RUN_STALL },
  /* Van 2 — step 8's GPS gap, which is what makes one van read "No GPS". */
  { vehicleId: "V2", spec: RUN_GPS_GAP },
  /* Van 3 — a generic van on route 1, with AT-03's jitter. */
  { vehicleId: "V3", spec: RUN_VAN_3 },
];

/** How many vans the demo day runs. Three, and the ruling is in this file's header. */
export const LIVE_FLEET_SIZE = LIVE_FLEET.length;

/** The vans' own keys, for the join onto the saved plan. Never printed. */
export const LIVE_FLEET_VEHICLE_IDS: readonly string[] = LIVE_FLEET.map((van) => van.vehicleId);
