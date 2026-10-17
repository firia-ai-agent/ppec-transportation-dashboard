/**
 * The one survey every committed route fixture is measured against. **Simulated data only.**
 *
 * SOURCE: docs/adr/ADR-007-routing-fixtures.md (geometry *and* durations precomputed once at dev
 * time from the public OSRM demo server and committed; runtime never calls OSRM),
 * docs/research/osrm-okeeheelee-to-center.json and docs/research/osrm-probe.txt (the one probe
 * that was actually run), docs/MOCKS-AND-DEMO.md §1 (public landmarks, no homes), PRD §8 ASM-12
 * (service time per stop).
 *
 * Three numbers, in their own module because both route files need them and neither may own the
 * other: src/fixtures/run-routes.ts is the scenario's geometry and src/fixtures/routes.ts is the
 * three tracks the simulator replays over it, so the imports run survey → run-routes → routes and
 * never in a circle.
 *
 * Nothing here touches the database, the network or a clock.
 */

import type { Coord } from "@/domain/location/geo";
import { CENTER_STOP } from "@/modules/demo/fixtures/standard";

/**
 * The PPEC centre, from the scenario's own stop table (US Census geocode, MOCKS §1).
 *
 * Read off the fixture rather than written again here: the centre is the one stop every run ends
 * at, and a second copy of its coordinate is a second thing to keep in step.
 */
export const CENTER_COORD: Coord = [CENTER_STOP.lng, CENTER_STOP.lat];

/** PRD §8 ASM-12: 8 min of service for a wheelchair stop, and none for an ambulatory one. */
export const WHEELCHAIR_SERVICE_SECONDS = 480;

/**
 * Mean speed of the one committed OSRM response, m/s — 2,739.8 m in 228.1 s, Okeeheelee Park to
 * the centre (docs/research/osrm-okeeheelee-to-center.json, probe docs/research/osrm-probe.txt).
 *
 * Every committed leg's duration is its measured distance ÷ this speed, which is what keeps the
 * fixtures' arithmetic traceable to something that was actually measured rather than to a round
 * number somebody liked. The legs themselves are hand-authored along public roads and
 * **Unverified** (ADR-007's "replace with real OSRM responses when the fixtures are
 * regenerated"), so this probe is their provenance and not their survey.
 */
export const PROBE_SPEED_MPS = 2739.8 / 228.1;
