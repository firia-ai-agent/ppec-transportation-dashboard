/**
 * The three tracks the M5 GPS simulator and ETA engine replay. **Simulated data only.**
 *
 * SOURCE: docs/adr/ADR-007-routing-fixtures.md (geometry *and* durations precomputed once at dev
 * time and committed; runtime never calls OSRM), docs/MOCKS-AND-DEMO.md §1 / §5 (three routes,
 * public landmarks, no homes), §7 steps 6–8 (the ramp substitution, the stall, the GPS gap),
 * docs/PRD-v1.0.txt §18.1 (`tracks/*.gpx|jsonl (3 routes)`) and §18.2 step 7
 * (`demo replay --track=route2`), docs/ui/B12-SLICE1-DEFERRED.md §3.1 (the gap this file closes).
 *
 * ## There is no second survey in here any more
 *
 * These three routes were authored before src/modules/demo/fixtures/standard.ts, and they named
 * stops that in the scenario belong to another run's children: `route2` carried V1 but stopped at
 * John Prince Park and the Greenacres library, which are R3's and R3's children's kerbs, and each
 * stop's `familyLabel` named a different family than the scenario does. A board reading them
 * could say where a van was and never which child it was reaching, so slice 1 read them for the
 * van and nothing else and slice 2 built the plan's geometry beside them
 * (docs/ui/B12-SLICE1-DEFERRED.md §3.1–§3.2).
 *
 * They are now the scenario's own runs: each track is **one run's morning geometry**, taken
 * straight out of src/fixtures/run-routes.ts, which reads every stop, order, family label and
 * service time out of the scenario itself. The plan and the replayed morning are one survey, so a
 * van on this board arrives at its own riders' stops and the §8 notification decisions name the
 * families that actually ride from them.
 *
 * What a track adds to a run is only its **identity**: the fixture id the demo CLI names
 * (`--track=route2`) and nothing else. Vehicle and device come from the run, because the van that
 * drives a run is a fact about the run (ADR-013: one device per vehicle).
 *
 * ## What happened to the OSRM response
 *
 * `route1` used to carry the one survey-grade leg in the project — the committed OSRM demo
 * response in docs/research/osrm-okeeheelee-to-center.json, Okeeheelee Park → the centre, 2,739.8
 * m / 228.1 s. No run in the scenario drives that road: Okeeheelee Park is C2's kerb and R2 goes
 * on to City Hall and Wellington Green before the centre, so the leg could only have survived as
 * a fourth route belonging to no run — which is the very thing this change removes. So every
 * committed leg is now `DERIVED` and **Unverified**, and the probe keeps the job it was always
 * doing for the other seven: it is the speed every derived duration is divided by
 * (`PROBE_SPEED_MPS`, src/fixtures/survey.ts), asserted in routes.test.ts so it cannot drift.
 * Re-probing the scenario's eight legs needs the public OSRM demo server, which is a dev-time
 * job and not something a test or a runtime may do (ADR-007).
 *
 * Nothing here touches the database. src/fixtures/map.ts stays the *static* map fixture (the
 * still-life preview); this module is the moving one.
 */

import type { Route } from "@/domain/location/route";
import { runRoute } from "./run-routes";

/**
 * route1 — R3's morning: the Greenacres library, John Prince Park, the centre. V4's run.
 *
 * V4's own road, which matters because V4's device is the LOC-01 one: its points are ingested,
 * stored `bound=false` and displayed nowhere (src/fixtures/replays.ts `RUN_UNBOUND`). An unbound
 * device that was replaying another run's road was the one disagreement nothing could see.
 */
export const ROUTE_1: Route = { ...runRoute("R3", "AM"), id: "route1" };

/**
 * route2 — R1's morning: Palm Beach State College, the Lantana library, Boynton Beach Mall, the
 * centre. V1's run, and the track PRD §18.2 step 7 names (`--track=route2`).
 *
 * It is also the longest run the scenario plans (≈32 km), which is what the step 7 stall needs:
 * ASM-14 only notifies a family about a stop still ≥10 min away, so a stall has to land with
 * more than ten minutes of driving left to move anybody's window at all. replays.test.ts holds
 * that from the other end — it asserts the stall really does damp a downstream family's window
 * and leaves the stop already passed alone (AT-03, "downstream only").
 */
export const ROUTE_2: Route = { ...runRoute("R1", "AM"), id: "route2" };

/**
 * route3 — R2's morning: Okeeheelee Park, Greenacres City Hall, the Mall at Wellington Green, the
 * centre. V2's run, and the track the GPS-gap fault drives (PRD §18.2 step 8, AT-11).
 */
export const ROUTE_3: Route = { ...runRoute("R2", "AM"), id: "route3" };

export const FIXTURE_ROUTES: Route[] = [ROUTE_1, ROUTE_2, ROUTE_3];

export function routeById(id: string): Route {
  const route = FIXTURE_ROUTES.find((r) => r.id === id);
  if (!route) throw new Error(`unknown fixture route: ${id}`);
  return route;
}
