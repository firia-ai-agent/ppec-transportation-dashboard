/**
 * Who may open the developer preview routes — /map-preview and /ramp-preview — and what the
 * map preview shows them once they are in.
 *
 * SOURCE: ADR-004 (Credentials provider, roles re-read from the DB per request, the session
 * carries only a user id), ADR-014/ADR-015 (the demo flags), DECISION-LEDGER row 57 (the three
 * synthetic staff accounts and what each of them is for).
 *
 * The preview used to be open to anyone with the URL, which is survivable on a laptop and not
 * survivable on a deployed preview: the deployed URL is guessable and the page draws a whole
 * fleet, every stop's family label and every notification decision. So it is a protected route
 * now, guarded the way src/app/whoami and src/app/(app)/layout.tsx guard theirs, and what it
 * draws depends on the role.
 *
 * Pure module: no `next/*`, no Auth.js, no database, no `process.env` read of its own, so the
 * whole matrix is unit-testable, and `StaffRole` arrives as a *type-only* import so none of
 * src/auth (bcrypt, node:crypto) is pulled into the browser bundle by the map component.
 * src/auth/preview-viewer.ts does the session work and calls in here for the answers.
 */
import type { StaffRole } from "@/auth/core";

/**
 * The kinds of data the map pane can put on the screen. Deliberately finer than "the map":
 * a front-desk iPad at the door needs to see where the vans are, and has no business holding
 * the family list or the notification queue.
 */
export const MAP_DATA_KEYS = [
  /** The basemap, the center pin and the landmark stops. */
  "map",
  /** Vehicle markers, their heading, their GPS freshness and the driven line. */
  "vehiclePositions",
  /** Per-stop ETA windows in the list beside the map. */
  "stopWindows",
  /** Which family a stop belongs to ("F4"). */
  "familyLabels",
  /** What would be sent, to whom, and why — the decisions list. */
  "notificationDecisions",
  /** Demo internals: the injected fault list and the unbound-device counts. */
  "injectedFaults",
  /** The scenario clock: play / pause / speed / restart. */
  "clockControls",
] as const;

export type MapDataKey = (typeof MAP_DATA_KEYS)[number];

/** A signed-in staff role, or nobody. */
export type MapViewer = StaffRole | "ANONYMOUS";

/**
 * The role × data matrix.
 *
 * - ANONYMOUS sees nothing at all: there is no "public" row of this table, which is what makes
 *   the sign-in guard meaningful rather than decorative.
 * - FRONT_DESK handles arrivals and handoffs at the door (COPY-GUIDE demo-account wording), so
 *   it gets the map, the vans and the windows, and neither the family list nor the queue.
 * - COORDINATOR runs the day and owns the approvals, so it adds the family labels and the
 *   notification decisions.
 * - DIRECTOR also holds the demo controls, so it alone gets the scenario clock and the
 *   injected-fault panel.
 *
 * Written out per role rather than as a privilege ladder: a reader of this file should be able
 * to see what a front-desk iPad shows without having to subtract one list from another.
 */
export const MAP_DATA_BY_ROLE: Readonly<Record<MapViewer, readonly MapDataKey[]>> = {
  ANONYMOUS: [],
  FRONT_DESK: ["map", "vehiclePositions", "stopWindows"],
  COORDINATOR: ["map", "vehiclePositions", "stopWindows", "familyLabels", "notificationDecisions"],
  DIRECTOR: [
    "map",
    "vehiclePositions",
    "stopWindows",
    "familyLabels",
    "notificationDecisions",
    "injectedFaults",
    "clockControls",
  ],
};

export function canSeeMapData(viewer: MapViewer, key: MapDataKey): boolean {
  return MAP_DATA_BY_ROLE[viewer].includes(key);
}

/** A viewer may open the page at all iff there is some map data for them to see. */
export function canOpenMapPreview(viewer: MapViewer): boolean {
  return MAP_DATA_BY_ROLE[viewer].length > 0;
}

/**
 * Who may open /ramp-preview. The ramp iPad is the front desk's own surface and a coordinator
 * and a director both walk it, so every staff role is in — and anonymous is not, for the same
 * reason the map preview keeps its guard: the deployed URL is guessable, and the page lists
 * children by name, their transport needs and which seat each of them is in.
 */
export function canOpenRampPreview(viewer: MapViewer): boolean {
  return viewer !== "ANONYMOUS";
}

/**
 * The most capable role the user holds, since one person can be a member of several sites.
 * ANONYMOUS when they hold none.
 */
export function mapViewerFor(roles: readonly StaffRole[]): MapViewer {
  const ladder: StaffRole[] = ["DIRECTOR", "COORDINATOR", "FRONT_DESK"];
  return ladder.find((role) => roles.includes(role)) ?? "ANONYMOUS";
}

const STAFF_ROLES: readonly string[] = ["DIRECTOR", "COORDINATOR", "FRONT_DESK"];

/**
 * The browser-test session: a role with no credentials behind it, for a Playwright run that
 * has no database to authenticate against.
 *
 * Four gates, all of which must hold, and one of them cannot hold on any deployment we own:
 *  1. `VERCEL_ENV` is unset — so this is a local or CI shell, never a preview and never
 *     production, where `VERCEL_ENV` is always set by the platform;
 *  2. `APP_DATA_CLASS=SYNTHETIC` — the ADR-015 data class, so there is no real data to expose;
 *  3. `DEMO_MODE=1` — the ADR-014 demo switch;
 *  4. `E2E_DEMO_ROLE` names one of the three ADR-004 roles. Unset means off, which is what it
 *     is everywhere except the browser check.
 *
 * It grants a role, never an identity: no user id, no site, nothing that writes. Anything that
 * touches the database still goes through the real guard.
 */
export function demoSessionRole(env: Record<string, string | undefined>): StaffRole | null {
  if (env.VERCEL_ENV !== undefined) return null;
  if (env.APP_DATA_CLASS !== "SYNTHETIC") return null;
  if (env.DEMO_MODE !== "1") return null;
  const role = env.E2E_DEMO_ROLE;
  return role !== undefined && STAFF_ROLES.includes(role) ? (role as StaffRole) : null;
}
