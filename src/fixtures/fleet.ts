/**
 * Synthetic fleet and riders for the capacity solver and the ramp iPad.
 *
 * Everything here is fiction (PRD §18.1, MOCKS-AND-DEMO §1-2): no real children, families,
 * providers or addresses. Names are first name + last initial (COPY-GUIDE §3); stops are public
 * landmarks, never a home. Interim fixtures until the seed slice (B-07) lands; the shapes match
 * ops.vehicle / vehicle_layout / layout_position / transport_profile so the seed can replace them.
 */
import type { AmbSeat, Child, DailyCapability, Layout, Leg, Vehicle, WcPosition } from "@/domain/solver";

export const SERVICE_DATE = "2026-10-14";

export const PROVIDERS = {
  P1: { id: "P1", name: "Provider P1" },
  P2: { id: "P2", name: "Provider P2" },
  CENTER: { id: "CENTER", name: "Center" },
} as const;

function wc(id: string, securement: WcPosition["securement"], maxLengthCm: number, maxWidthCm: number): WcPosition {
  return { id, kind: "WC", securement, maxLengthCm, maxWidthCm };
}
function amb(id: string, tetherCapable = false): AmbSeat {
  return { id, kind: "AMB", tetherCapable };
}

/** V1 convertible van: three mutually exclusive layouts (PRD §18.1 l.1328). */
export const V1_LAYOUT_0WC6A: Layout = {
  id: "V1-L1", code: "0WC/6A", liftRequired: false,
  positions: [amb("V1-L1-A1", true), amb("V1-L1-A2", true), amb("V1-L1-A3", true), amb("V1-L1-A4"), amb("V1-L1-A5"), amb("V1-L1-A6")],
};
export const V1_LAYOUT_1WC3A: Layout = {
  id: "V1-L2", code: "1WC/3A", liftRequired: true,
  positions: [wc("V1-L2-W1", "L_TRACK", 122, 76), amb("V1-L2-A1", true), amb("V1-L2-A2", true), amb("V1-L2-A3")],
};
export const V1_LAYOUT_2WC1A: Layout = {
  id: "V1-L3", code: "2WC/1A", liftRequired: true,
  positions: [wc("V1-L3-W1", "L_TRACK", 122, 76), wc("V1-L3-W2", "L_TRACK", 122, 76), amb("V1-L3-A1", true)],
};
export const V2_LAYOUT_1WC4A: Layout = {
  id: "V2-L1", code: "1WC/4A", liftRequired: true,
  positions: [wc("V2-L1-W1", "L_TRACK", 145, 80), amb("V2-L1-A1", true), amb("V2-L1-A2", true), amb("V2-L1-A3", true), amb("V2-L1-A4")],
};
export const V3_LAYOUT_1WC1A: Layout = {
  id: "V3-L1", code: "1WC/1A", liftRequired: true,
  positions: [wc("V3-L1-W1", "SLIDE_N_CLICK", 120, 75), amb("V3-L1-A1", true)],
};
export const V4_LAYOUT_0WC3A: Layout = {
  id: "V4-L1", code: "0WC/3A", liftRequired: false,
  positions: [amb("V4-L1-A1", true), amb("V4-L1-A2", true), amb("V4-L1-A3")],
};

export const V1: Vehicle = {
  id: "V1", label: "V1", description: "Convertible van",
  providerId: PROVIDERS.P1.id, providerName: PROVIDERS.P1.name, liftEquipped: true,
  layouts: [V1_LAYOUT_0WC6A, V1_LAYOUT_1WC3A, V1_LAYOUT_2WC1A],
};
/** Center-owned van, the AT-04 relief vehicle. */
export const V2: Vehicle = {
  id: "V2", label: "V2", description: "Center van",
  providerId: PROVIDERS.CENTER.id, providerName: PROVIDERS.CENTER.name, liftEquipped: true,
  layouts: [V2_LAYOUT_1WC4A],
};
/** P1's substitute van (AT-05): different securement hardware and only one ambulatory seat. */
export const V3: Vehicle = {
  id: "V3", label: "V3", description: "Substitute van",
  providerId: PROVIDERS.P1.id, providerName: PROVIDERS.P1.name, liftEquipped: true,
  layouts: [V3_LAYOUT_1WC1A],
};
export const V4: Vehicle = {
  id: "V4", label: "V4", description: "Sedan",
  providerId: PROVIDERS.P2.id, providerName: PROVIDERS.P2.name, liftEquipped: false,
  layouts: [V4_LAYOUT_0WC3A],
};
export const FLEET: Vehicle[] = [V1, V2, V3, V4];

/* ───────────────────────────── riders (synthetic) ───────────────────────────── */
/** C1: car seat, AM self-drop family. */
export const C1: Child = { token: "C1", displayName: "Mia R.", mobility: "AMB", tether: true, escort: false };
/** C2: wheelchair, fixed chair, L-track securement, boards by lift. */
export const C2: Child = { token: "C2", displayName: "Noah B.", mobility: "WC", securement: "L_TRACK", wcLengthCm: 110, wcWidthCm: 70, tether: false, escort: false };
/** C3: ambulatory. */
export const C3: Child = { token: "C3", displayName: "Ava T.", mobility: "AMB", tether: false, escort: false };
/** C4: booster. */
export const C4: Child = { token: "C4", displayName: "Sam P.", mobility: "AMB", tether: true, escort: false };
/** C5: car seat (same family as C4). */
export const C5: Child = { token: "C5", displayName: "Zoe P.", mobility: "AMB", tether: true, escort: false };
/** C6: tilt wheelchair, nurse rides along (escort takes one ambulatory seat). Dimensions as planned. */
export const C6: Child = { token: "C6", displayName: "Iris K.", mobility: "WC", securement: "L_TRACK", wcLengthCm: 118, wcWidthCm: 70, tether: false, escort: true };
/**
 * C6 as measured at the ramp (AT-04, unknown equipment at arrival): the chair that arrives with a
 * new headrest and tray is longer than the approved need said. Fits the center van, not V1.
 */
export const C6_AT_RAMP: Child = { ...C6, wcLengthCm: 140, wcWidthCm: 72 };
/** C7: vest (needs a tether-anchored seat). */
export const C7: Child = { token: "C7", displayName: "Jonah W.", mobility: "AMB", tether: true, escort: false };
/** C8: ambulatory; shares C6's route and is the rider moved in demo step 6. */
export const C8: Child = { token: "C8", displayName: "Leo B.", mobility: "AMB", tether: false, escort: false };
export const CHILDREN: Child[] = [C1, C2, C3, C4, C5, C6, C7, C8];

/* ───────────────────────────── stops (public landmarks, MOCKS §1) ───────────────────────────── */
export const STOPS = {
  library: "Greenacres Branch Library",
  park: "Okeeheelee Park",
  cityHall: "Greenacres City Hall",
  princePark: "John Prince Park",
  college: "Palm Beach State College",
  lantana: "Lantana Public Library",
  mall: "Boynton Beach Mall",
  wellington: "Mall at Wellington Green",
  center: "PPEC center",
} as const;

/* ───────────────────────────── legs ───────────────────────────── */
/** Route 2 morning run: C6 (with nurse) then C7 then C8, then the center. */
export const ROUTE2_AM: Leg = {
  id: "LEG-R2-AM", direction: "AM", manifestId: "MAN-R2-AM",
  children: [C6, C7, C8],
  stops: [
    { k: 1, label: STOPS.college, boarding: ["C6"] },
    { k: 2, label: STOPS.lantana, boarding: ["C7"] },
    { k: 3, label: STOPS.mall, boarding: ["C8"] },
    { k: 4, label: STOPS.center, alighting: ["C6", "C7", "C8"] },
  ],
};
/** Route 2 afternoon run, the one the ramp checks: riders board at the center, then go home. */
export const ROUTE2_PM: Leg = {
  id: "LEG-R2-PM", direction: "PM", manifestId: "MAN-R2-PM",
  children: [C6, C7, C8],
  stops: [
    { k: 1, label: STOPS.center, boarding: ["C6", "C7", "C8"] },
    { k: 2, label: STOPS.mall, alighting: ["C8"] },
    { k: 3, label: STOPS.lantana, alighting: ["C7"] },
    { k: 4, label: STOPS.college, alighting: ["C6"] },
  ],
};
/**
 * The two-seat crisis exactly as PRD §7 l.800 states it: the run needs {1WC, 2AMB} and the ramp
 * observes {1WC, 1AMB}. One wheelchair rider, two walking riders, no escort.
 */
export const TWO_SEAT_CRISIS_AM: Leg = {
  id: "LEG-CRISIS-AM", direction: "AM", manifestId: "MAN-CRISIS-AM",
  children: [C2, C7, C8],
  stops: [
    { k: 1, label: STOPS.park, boarding: ["C2"] },
    { k: 2, label: STOPS.lantana, boarding: ["C7"] },
    { k: 3, label: STOPS.mall, boarding: ["C8"] },
    { k: 4, label: STOPS.center, alighting: ["C2", "C7", "C8"] },
  ],
};
/** Three walking riders on the sedan; used to show a deficit reported at stop 3. */
export const SEDAN_AM: Leg = {
  id: "LEG-SEDAN-AM", direction: "AM", manifestId: "MAN-SEDAN-AM",
  children: [C1, C3, C8],
  stops: [
    { k: 1, label: STOPS.library, boarding: ["C1"] },
    { k: 2, label: STOPS.cityHall, boarding: ["C3"] },
    { k: 3, label: STOPS.mall, boarding: ["C8"] },
    { k: 4, label: STOPS.center, alighting: ["C1", "C3", "C8"] },
  ],
};

/* ───────────────────────────── capability observations ───────────────────────────── */
/** The normal morning state: nothing reported yet, so nothing is assumed (PRD §9). */
export function unknownCapability(vehicleId: string, serviceDate = SERVICE_DATE): DailyCapability {
  return { vehicleId, serviceDate, state: "UNKNOWN", liftOk: null, latchOk: null, unavailablePositionIds: [] };
}
/** Everything on the vehicle works and nothing is taken. */
export function fullyAvailable(
  vehicle: Vehicle,
  extra: Partial<DailyCapability> = {},
  serviceDate = SERVICE_DATE,
): DailyCapability {
  return {
    vehicleId: vehicle.id, serviceDate, state: "VERIFIED", liftOk: true, latchOk: true,
    unavailablePositionIds: [], observedBy: "J.T.", observedAt: `${serviceDate}T12:35:00-04:00`, ...extra,
  };
}
/** What the ramp enters in demo step 6: V1 arrives as {1WC/3A} with two walking seats out of service. */
export const CRISIS_CAPABILITY: DailyCapability = {
  vehicleId: V1.id, serviceDate: SERVICE_DATE, state: "REPORTED",
  observedLayoutId: V1_LAYOUT_1WC3A.id, liftOk: true, latchOk: true,
  unavailablePositionIds: ["V1-L2-A2", "V1-L2-A3"],
  observedBy: "J.T.", observedAt: `${SERVICE_DATE}T15:02:00-04:00`,
};

/* ───────────────────────────── ramp iPad ───────────────────────────── */
export type ArrivingVehicle = {
  vehicle: Vehicle;
  leg: Leg;
  /** Simulated arrival time, shown on the tile. */
  arrivingAt: string;
  /** Default configuration to offer on the checklist: what the manifest planned. */
  plannedLayoutId: string;
};
/** Afternoon arrivals for the ramp iPad; simulated, in route order. */
export const ARRIVING_VEHICLES: ArrivingVehicle[] = [
  { vehicle: V1, leg: { ...ROUTE2_PM, children: [C6_AT_RAMP, C7, C8] }, arrivingAt: "2:52 PM", plannedLayoutId: V1_LAYOUT_1WC3A.id },
  { vehicle: V2, leg: { ...ROUTE2_PM, id: "LEG-R1-PM", manifestId: "MAN-R1-PM", children: [C2, C1, C4] ,
    stops: [
      { k: 1, label: STOPS.center, boarding: ["C2", "C1", "C4"] },
      { k: 2, label: STOPS.park, alighting: ["C2"] },
      { k: 3, label: STOPS.library, alighting: ["C1"] },
      { k: 4, label: STOPS.princePark, alighting: ["C4"] },
    ] }, arrivingAt: "3:05 PM", plannedLayoutId: V2_LAYOUT_1WC4A.id },
  { vehicle: V4, leg: { ...SEDAN_AM, id: "LEG-R3-PM", direction: "PM", manifestId: "MAN-R3-PM", children: [C3, C5],
    stops: [
      { k: 1, label: STOPS.center, boarding: ["C3", "C5"] },
      { k: 2, label: STOPS.cityHall, alighting: ["C3"] },
      { k: 3, label: STOPS.princePark, alighting: ["C5"] },
    ] }, arrivingAt: "3:20 PM", plannedLayoutId: V4_LAYOUT_0WC3A.id },
];
