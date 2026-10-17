/**
 * The "standard" synthetic scenario (PRD §18.1 l.1327–1328, MOCKS-AND-DEMO §1–§3).
 * Data only: no SQL, no clock, no I/O. src/modules/demo/seed.ts turns this into rows.
 *
 * Rules this file must keep (ADR-015, DECISION-LEDGER rows 4, 31):
 *  - Synthetic first names plus a single last initial. No surname exists in this file at all (row 31):
 *    the staff-visible label is "Mia R.", and the identity-vault legal name is "Mia R. (SYN)".
 *  - Phones are +1-561-555-01xx; families use 0101–0108 (MOCKS §3), staff-facing externals 0109–0112,
 *    census-pad families 0121–0139.
 *  - Coordinates come only from the MOCKS §1 landmark table; scripts/seed-lint.mjs rejects any other pair.
 *  - Ids are deterministic so a reset is idempotent and a permanent test opt-out keeps pointing at the
 *    same contact token across resets.
 */

/* ───────────────────────────── ids ───────────────────────────── */

/** Deterministic, UUIDv7-shaped fixture id. `kind` namespaces the entity, `n` numbers it within the kind. */
export const demoId = (kind: number, n: number): string =>
  `01900000-0000-7000-8000-${kind.toString(16).padStart(4, "0")}${n.toString(16).padStart(8, "0")}`;

/** Id namespaces. 0x0000 is reserved: src/auth/seed.ts uses it for the org, sites and staff users. */
export const KIND = {
  family: 0x10, child: 0x11, contact: 0x12, consent: 0x13, auth: 0x14, stop: 0x15, profile: 0x16,
  need: 0x17, person: 0x18, therapist: 0x19, session: 0x1a, provider: 0x1b, vehicle: 0x1c,
  layout: 0x1d, position: 0x1e, capability: 0x1f, plan: 0x20, exception: 0x21, attendanceDay: 0x22,
  manifest: 0x23, leg: 0x24, reservation: 0x25,
} as const;

/* ───────────────────────────── types ───────────────────────────── */

export type Mobility = "AMB" | "WC";
export type Securement = "L_TRACK" | "SLIDE_N_CLICK" | "FOUR_POINT_STRAP" | "OTHER";
export type LegMode = "PROVIDER" | "FAMILY" | "CENTER";
export type NeedState = "UNKNOWN" | "REPORTED" | "VERIFIED" | "APPROVED";
export type AuthScope =
  | "RECEIVE_TRANSPORT_UPDATES" | "CANCEL_LEG" | "CHANGE_PICKUP_INSTRUCTIONS"
  | "CONFIRM_AVAILABILITY_TO_RECEIVE" | "RECEIVE_ATTENDANCE_UPDATES" | "ACCESS_SENSITIVE_INFO" | "RECEIVE_CHILD";

/** PRD §9 approved-need categories (l.880), pending CA-05. */
export const NEED_CATEGORIES = [
  "WHEELCHAIR_SECUREMENT", "LIFT_OR_RAMP", "CAR_SEAT_OR_BOOSTER", "HARNESS_OR_VEST", "ATTENDANT_ESCORT",
  "SEATING_SEPARATION", "MAX_RIDE_TIME", "EQUIPMENT_DIMENSIONS", "MEDICAL_DEVICE_POWER",
] as const;
export type NeedCategory = (typeof NEED_CATEGORIES)[number];

/**
 * `smsToken` is the short stop token an outbound message carries in its vars (outbox `stopToken` rule).
 * The place name a family reads is never this label: messaging/templates.ts resolves the token through
 * the fixed copy table (`outboundSms.stops`), which is what keeps free text out of outbound vars.
 */
export type Stop = { key: string; label: string; lat: number; lng: number; smsToken: string };
export type Need = { category: NeedCategory; value: Record<string, unknown>; state: NeedState; evidenceRef?: string };

export type Family = {
  key: string;            // "F1" … "F27"
  label: string;          // masked family label on staff screens
  guardian: { firstName: string; lastInitial: string; relationship: string; phone: string };
};

export type Child = {
  key: string;            // "C1" … "C28"
  familyKey: string;
  firstName: string;      // synthetic
  lastInitial: string;    // one letter; no surname is stored for a child anywhere (row 31)
  label: string;          // "Mia R." — what staff screens show
  dob: string;            // ISO date, synthetic
  /** Landmark pickup/drop stop; null for census-pad children, who arrive with their family. */
  stopKey: string | null;
  mobility: Mobility;
  wcLengthCm?: number; wcWidthCm?: number; securement?: Securement;
  tether?: boolean; escortRequired?: boolean; maxRideMinutes?: number;
  needs: Need[];
  amMode: LegMode; pmMode: LegMode;
  amWindow: string; pmWindow: string;  // "HH:MM" local
  /** Scopes the family's guardian holds for this child (PRD §6.4). */
  scopes: AuthScope[];
  /** True for the children that only exist to bring the board to its 28-row census (PRD §18.1). */
  censusPad: boolean;
};

export type Position = {
  kind: "WC" | "AMB"; securement?: Securement; maxLengthCm?: number; maxWidthCm?: number; tetherCapable: boolean;
};
export type Layout = { code: string; liftRequired: boolean; positions: Position[] };
export type Vehicle = { key: string; label: string; providerKey: string; liftEquipped: boolean; layouts: Layout[] };
export type Provider = { key: string; name: string; dispatchOwnership: "CENTER_FLEET" | "THIRD_PARTY" | "BROKER_NEMT"; dispatcher?: string };
export type ExternalPerson = {
  key: string; kind: "THERAPIST" | "PROVIDER_DISPATCHER"; firstName: string; lastInitial: string; phone: string;
};
export type Therapist = { key: string; personKey: string; label: string };
export type TherapySession = { key: string; therapistKey: string; childKey: string; start: string; end: string };
/** One vehicle run for the day: the children it carries, in stop order. PM reverses the order. */
export type Run = { key: string; vehicleKey: string; layoutCode: string; childKeys: string[] };

/**
 * The vault's stand-in for a surname (row 31): a last initial and the SYN marker, never a family name.
 * Synthetic people have no legal name to protect, so the fixtures hold none — not even behind the
 * identity schema, where an export or a support query could otherwise surface one.
 */
export const synLegalLastName = (lastInitial: string): string => `${lastInitial}. (SYN)`;
/** Single-column vault legal name: "Alma R. (SYN)". */
export const synLegalName = (firstName: string, lastInitial: string): string =>
  `${firstName} ${synLegalLastName(lastInitial)}`;

/* ───────────────────────────── geography (MOCKS §1) ───────────────────────────── */

export const CENTER_STOP: Stop = { key: "CENTER", label: "PPEC center, 2216 Jog Rd", lat: 26.645352, lng: -80.145541, smsToken: "CENTER" };
/** Fault-scenario detour target; no child is assigned to it. */
export const SPARE_STOP: Stop = { key: "SPARE", label: "Palm Beach Zoo", lat: 26.667739, lng: -80.069543, smsToken: "PB-ZOO" };

export const STOPS: Stop[] = [
  { key: "S1", label: "Greenacres Branch Library", lat: 26.622639, lng: -80.145953, smsToken: "GA-LIBRARY" },
  { key: "S2", label: "Okeeheelee Park", lat: 26.652165, lng: -80.164767, smsToken: "OKEE-PARK" },
  { key: "S3", label: "Greenacres City Hall", lat: 26.607061, lng: -80.135511, smsToken: "GA-CITYHALL" },
  { key: "S4", label: "John Prince Park", lat: 26.602482, lng: -80.080532, smsToken: "PRINCE-PARK" },
  { key: "S5", label: "Palm Beach State College, Lake Worth", lat: 26.613772, lng: -80.085865, smsToken: "PBSC-LW" },
  { key: "S6", label: "Lantana Public Library", lat: 26.584699, lng: -80.052871, smsToken: "LANTANA-LIB" },
  { key: "S7", label: "Boynton Beach Mall", lat: 26.535418, lng: -80.095675, smsToken: "BOYNTON-MALL" },
  { key: "S8", label: "Mall at Wellington Green", lat: 26.646683, lng: -80.208099, smsToken: "WELLINGTON" },
  CENTER_STOP, SPARE_STOP,
];

/* ───────────────────────────── families and children (PRD l.1327) ───────────────────────────── */

const SCENARIO_FAMILIES: Family[] = [
  { key: "F1", label: "F1 (Demo)", guardian: { firstName: "Alma", lastInitial: "R", relationship: "parent", phone: "+1-561-555-0101" } },
  { key: "F2", label: "F2 (Demo)", guardian: { firstName: "Dara", lastInitial: "O", relationship: "parent", phone: "+1-561-555-0102" } },
  { key: "F3", label: "F3 (Demo)", guardian: { firstName: "Rosa", lastInitial: "D", relationship: "parent", phone: "+1-561-555-0103" } },
  // F4 is one phone for two children (PRD l.1327 "shared number", AT-06 sibling ambiguity).
  { key: "F4", label: "F4 (Demo)", guardian: { firstName: "Thuy", lastInitial: "N", relationship: "parent", phone: "+1-561-555-0104" } },
  { key: "F5", label: "F5 (Demo)", guardian: { firstName: "Greta", lastInitial: "B", relationship: "parent", phone: "+1-561-555-0105" } },
  { key: "F6", label: "F6 (Demo)", guardian: { firstName: "Marisol", lastInitial: "C", relationship: "parent", phone: "+1-561-555-0106" } },
  { key: "F7", label: "F7 (Demo)", guardian: { firstName: "Paula", lastInitial: "H", relationship: "parent", phone: "+1-561-555-0107" } },
  { key: "F8", label: "F8 (Demo)", guardian: { firstName: "Lena", lastInitial: "V", relationship: "grandparent", phone: "+1-561-555-0108" } },
];

const FULL_SCOPES: AuthScope[] = [
  "RECEIVE_TRANSPORT_UPDATES", "RECEIVE_ATTENDANCE_UPDATES", "CANCEL_LEG", "CHANGE_PICKUP_INSTRUCTIONS", "RECEIVE_CHILD",
];
/** F2 has no authorized receiving adult on file: the AT-13 HELD_NO_RECEIVER case (PRD l.1327). */
const NO_RECEIVER_SCOPES: AuthScope[] = FULL_SCOPES.filter((s) => s !== "RECEIVE_CHILD");
const PAD_SCOPES: AuthScope[] = ["RECEIVE_ATTENDANCE_UPDATES", "RECEIVE_CHILD"];

const SCENARIO_CHILDREN: Child[] = [
  {
    key: "C1", familyKey: "F1", firstName: "Mia", lastInitial: "R", label: "Mia R.", dob: "2022-03-14",
    stopKey: "S1", mobility: "AMB", amMode: "PROVIDER", pmMode: "PROVIDER", amWindow: "07:10", pmWindow: "15:55",
    needs: [{ category: "CAR_SEAT_OR_BOOSTER", value: { type: "FORWARD_FACING_CAR_SEAT" }, state: "APPROVED", evidenceRef: "intake/C1" }],
    scopes: FULL_SCOPES, censusPad: false,
  },
  {
    key: "C2", familyKey: "F2", firstName: "Noah", lastInitial: "O", label: "Noah O.", dob: "2021-09-02",
    stopKey: "S2", mobility: "WC", wcLengthCm: 108, wcWidthCm: 64, securement: "L_TRACK", tether: false,
    amMode: "CENTER", pmMode: "CENTER", amWindow: "06:50", pmWindow: "16:20",
    needs: [
      { category: "WHEELCHAIR_SECUREMENT", value: { securement: "L_TRACK", position: "FIXED" }, state: "APPROVED", evidenceRef: "intake/C2" },
      { category: "LIFT_OR_RAMP", value: { required: "LIFT" }, state: "APPROVED", evidenceRef: "intake/C2" },
      { category: "EQUIPMENT_DIMENSIONS", value: { lengthCm: 108, widthCm: 64 }, state: "APPROVED", evidenceRef: "intake/C2" },
    ],
    scopes: NO_RECEIVER_SCOPES, censusPad: false,
  },
  {
    key: "C3", familyKey: "F3", firstName: "Liam", lastInitial: "D", label: "Liam D.", dob: "2022-01-27",
    stopKey: "S3", mobility: "AMB", maxRideMinutes: 45, amMode: "CENTER", pmMode: "CENTER", amWindow: "07:05", pmWindow: "16:05",
    needs: [{ category: "MAX_RIDE_TIME", value: { minutes: 45 }, state: "APPROVED", evidenceRef: "intake/C3" }],
    scopes: FULL_SCOPES, censusPad: false,
  },
  {
    key: "C4", familyKey: "F4", firstName: "Ava", lastInitial: "N", label: "Ava N.", dob: "2020-11-19",
    stopKey: "S4", mobility: "AMB", amMode: "PROVIDER", pmMode: "PROVIDER", amWindow: "07:25", pmWindow: "15:40",
    needs: [{ category: "CAR_SEAT_OR_BOOSTER", value: { type: "BOOSTER" }, state: "APPROVED", evidenceRef: "intake/C4" }],
    scopes: FULL_SCOPES, censusPad: false,
  },
  {
    key: "C5", familyKey: "F4", firstName: "Eli", lastInitial: "N", label: "Eli N.", dob: "2022-06-08",
    stopKey: "S4", mobility: "AMB", amMode: "PROVIDER", pmMode: "PROVIDER", amWindow: "07:25", pmWindow: "15:40",
    needs: [{ category: "CAR_SEAT_OR_BOOSTER", value: { type: "REAR_FACING_CAR_SEAT" }, state: "APPROVED", evidenceRef: "intake/C5" }],
    scopes: FULL_SCOPES, censusPad: false,
  },
  {
    key: "C6", familyKey: "F5", firstName: "Zoe", lastInitial: "B", label: "Zoe B.", dob: "2021-04-30",
    stopKey: "S5", mobility: "WC", wcLengthCm: 128, wcWidthCm: 70, securement: "FOUR_POINT_STRAP", tether: true,
    escortRequired: true, amMode: "PROVIDER", pmMode: "PROVIDER", amWindow: "06:45", pmWindow: "16:15",
    needs: [
      { category: "WHEELCHAIR_SECUREMENT", value: { securement: "FOUR_POINT_STRAP", position: "TILT_IN_SPACE" }, state: "APPROVED", evidenceRef: "intake/C6" },
      { category: "LIFT_OR_RAMP", value: { required: "LIFT" }, state: "APPROVED", evidenceRef: "intake/C6" },
      { category: "ATTENDANT_ESCORT", value: { escort: "NURSE" }, state: "APPROVED", evidenceRef: "intake/C6" },
      { category: "EQUIPMENT_DIMENSIONS", value: { lengthCm: 128, widthCm: 70 }, state: "APPROVED", evidenceRef: "intake/C6" },
      // The one reported-but-unapproved item (PRD l.1329 "needs with statuses incl. one unapproved reported item").
      // Fulfillment counts approved needs only (DECISION-LEDGER row 1), so this must not change today's plan.
      { category: "MEDICAL_DEVICE_POWER", value: { device: "PORTABLE_SUCTION", note: "awaiting operational-need approval" }, state: "REPORTED" },
    ],
    scopes: FULL_SCOPES, censusPad: false,
  },
  {
    key: "C7", familyKey: "F6", firstName: "Owen", lastInitial: "C", label: "Owen C.", dob: "2021-12-05",
    stopKey: "S6", mobility: "AMB", amMode: "PROVIDER", pmMode: "PROVIDER", amWindow: "07:00", pmWindow: "16:00",
    needs: [{ category: "HARNESS_OR_VEST", value: { type: "VEST" }, state: "APPROVED", evidenceRef: "intake/C7" }],
    scopes: FULL_SCOPES, censusPad: false,
  },
  {
    key: "C8", familyKey: "F7", firstName: "Ivy", lastInitial: "H", label: "Ivy H.", dob: "2020-08-21",
    stopKey: "S7", mobility: "AMB", amMode: "PROVIDER", pmMode: "PROVIDER", amWindow: "07:15", pmWindow: "15:45",
    needs: [], scopes: FULL_SCOPES, censusPad: false,
  },
  {
    key: "C9", familyKey: "F8", firstName: "Theo", lastInitial: "V", label: "Theo V.", dob: "2022-02-11",
    stopKey: "S8", mobility: "AMB", amMode: "CENTER", pmMode: "CENTER", amWindow: "07:20", pmWindow: "15:50",
    needs: [], scopes: FULL_SCOPES, censusPad: false,
  },
];

/* ───────────────────────── census pad (PRD l.1327: board shows 28) ───────────────────────── */

/** Target board size: SURF-01 is one row per child, so the census is the board row count. */
export const BOARD_CENSUS = 28;

const PAD_PEOPLE: { first: string; lastInitial: string; guardianFirst: string; phone: string; dob: string }[] = [
  { first: "Ana", lastInitial: "S", guardianFirst: "Dalia", phone: "+1-561-555-0121", dob: "2021-01-12" },
  { first: "Beni", lastInitial: "A", guardianFirst: "Femi", phone: "+1-561-555-0122", dob: "2021-02-23" },
  { first: "Cleo", lastInitial: "M", guardianFirst: "Rina", phone: "+1-561-555-0123", dob: "2021-03-04" },
  { first: "Dax", lastInitial: "W", guardianFirst: "Troy", phone: "+1-561-555-0124", dob: "2021-04-15" },
  { first: "Esme", lastInitial: "L", guardianFirst: "Noor", phone: "+1-561-555-0125", dob: "2021-05-26" },
  { first: "Finn", lastInitial: "O", guardianFirst: "Kofi", phone: "+1-561-555-0126", dob: "2021-06-07" },
  { first: "Gia", lastInitial: "P", guardianFirst: "Celia", phone: "+1-561-555-0127", dob: "2021-07-18" },
  { first: "Hugo", lastInitial: "V", guardianFirst: "Brett", phone: "+1-561-555-0128", dob: "2021-08-29" },
  { first: "Iris", lastInitial: "N", guardianFirst: "Yuki", phone: "+1-561-555-0129", dob: "2021-09-09" },
  { first: "Jonah", lastInitial: "K", guardianFirst: "Hanna", phone: "+1-561-555-0130", dob: "2021-10-20" },
  { first: "Kira", lastInitial: "A", guardianFirst: "Dion", phone: "+1-561-555-0131", dob: "2021-11-01" },
  { first: "Luca", lastInitial: "M", guardianFirst: "Paz", phone: "+1-561-555-0132", dob: "2021-12-12" },
  { first: "Maya", lastInitial: "F", guardianFirst: "Vita", phone: "+1-561-555-0133", dob: "2022-01-23" },
  { first: "Nico", lastInitial: "B", guardianFirst: "Rhea", phone: "+1-561-555-0134", dob: "2022-02-03" },
  { first: "Opal", lastInitial: "T", guardianFirst: "Tove", phone: "+1-561-555-0135", dob: "2022-03-16" },
  { first: "Pia", lastInitial: "Z", guardianFirst: "Ines", phone: "+1-561-555-0136", dob: "2022-04-27" },
  { first: "Quinn", lastInitial: "D", guardianFirst: "Mara", phone: "+1-561-555-0137", dob: "2022-05-08" },
  { first: "Rafa", lastInitial: "I", guardianFirst: "Ravi", phone: "+1-561-555-0138", dob: "2022-06-19" },
  { first: "Sana", lastInitial: "V", guardianFirst: "Anya", phone: "+1-561-555-0139", dob: "2022-07-30" },
];

const PAD_COUNT = BOARD_CENSUS - SCENARIO_CHILDREN.length;

const padFamilies: Family[] = PAD_PEOPLE.slice(0, PAD_COUNT).map((p, i) => ({
  key: `F${SCENARIO_FAMILIES.length + i + 1}`,
  label: `F${SCENARIO_FAMILIES.length + i + 1} (Demo)`,
  guardian: { firstName: p.guardianFirst, lastInitial: p.lastInitial, relationship: "parent", phone: p.phone },
}));

const padChildren: Child[] = PAD_PEOPLE.slice(0, PAD_COUNT).map((p, i) => ({
  key: `C${SCENARIO_CHILDREN.length + i + 1}`,
  familyKey: padFamilies[i].key,
  firstName: p.first, lastInitial: p.lastInitial, label: `${p.first} ${p.lastInitial}.`, dob: p.dob,
  stopKey: null, mobility: "AMB" as Mobility,
  needs: [], amMode: "FAMILY" as LegMode, pmMode: "FAMILY" as LegMode, amWindow: "08:00", pmWindow: "15:00",
  scopes: PAD_SCOPES, censusPad: true,
}));

export const FAMILIES: Family[] = [...SCENARIO_FAMILIES, ...padFamilies];
export const CHILDREN: Child[] = [...SCENARIO_CHILDREN, ...padChildren];

/* ───────────────────────── providers, vehicles, layouts (PRD l.1328, MOCKS §2) ───────────────────────── */

/** Staff-facing externals. Same rule as the children: first name + initial, SYN marker in the vault. */
export const EXTERNAL_PEOPLE: ExternalPerson[] = [
  { key: "T1", kind: "THERAPIST", firstName: "Tasha", lastInitial: "L", phone: "+1-561-555-0109" },
  { key: "T2", kind: "THERAPIST", firstName: "Devon", lastInitial: "P", phone: "+1-561-555-0110" },
  { key: "D1", kind: "PROVIDER_DISPATCHER", firstName: "Hal", lastInitial: "B", phone: "+1-561-555-0111" },
  { key: "D2", kind: "PROVIDER_DISPATCHER", firstName: "Rae", lastInitial: "S", phone: "+1-561-555-0112" },
];

export const PROVIDERS: Provider[] = [
  { key: "P1", name: "SYN Palm Lift Transport", dispatchOwnership: "THIRD_PARTY", dispatcher: "D1" },
  { key: "P2", name: "SYN Coastal Car Service", dispatchOwnership: "THIRD_PARTY", dispatcher: "D2" },
  { key: "CENTER", name: "SYN Greenacres center fleet", dispatchOwnership: "CENTER_FLEET" },
];

const amb = (tetherCapable = false): Position => ({ kind: "AMB", tetherCapable });
const wc = (securement: Securement, maxLengthCm: number, maxWidthCm: number): Position =>
  ({ kind: "WC", securement, maxLengthCm, maxWidthCm, tetherCapable: false });

export const VEHICLES: Vehicle[] = [
  {
    key: "V1", label: "V1 convertible van", providerKey: "P1", liftEquipped: true,
    layouts: [
      { code: "0WC/6A", liftRequired: false, positions: [amb(true), amb(true), amb(), amb(), amb(), amb()] },
      { code: "1WC/3A", liftRequired: true, positions: [wc("FOUR_POINT_STRAP", 130, 72), amb(true), amb(true), amb()] },
      { code: "2WC/1A", liftRequired: true, positions: [wc("FOUR_POINT_STRAP", 130, 72), wc("L_TRACK", 120, 70), amb(true)] },
    ],
  },
  {
    key: "V2", label: "V2 center van", providerKey: "CENTER", liftEquipped: true,
    layouts: [{ code: "1WC/4A", liftRequired: true, positions: [wc("L_TRACK", 125, 70), amb(true), amb(true), amb(), amb()] }],
  },
  {
    key: "V3", label: "V3 substitute van", providerKey: "P1", liftEquipped: true,
    layouts: [{ code: "1WC/1A", liftRequired: true, positions: [wc("L_TRACK", 110, 66), amb(true)] }],
  },
  {
    key: "V4", label: "V4 sedan", providerKey: "P2", liftEquipped: false,
    layouts: [{ code: "0WC/3A", liftRequired: false, positions: [amb(true), amb(true), amb()] }],
  },
];

/**
 * Today's three routes (MOCKS §5 "3 routes"). V3 stays in reserve for the AT-05 substitution.
 * R1 is the three-child route of PRD §18.2 step 6: a ramp report of {1WC, 1AMB} leaves C8 without a
 * seat, and V2 (R2) has the spare ambulatory seat the coordinator reallocates C8 into.
 */
export const RUNS: Run[] = [
  { key: "R1", vehicleKey: "V1", layoutCode: "1WC/3A", childKeys: ["C6", "C7", "C8"] },
  { key: "R2", vehicleKey: "V2", layoutCode: "1WC/4A", childKeys: ["C2", "C3", "C9"] },
  { key: "R3", vehicleKey: "V4", layoutCode: "0WC/3A", childKeys: ["C1", "C4", "C5"] },
];

/* ───────────────────────── therapy (PRD l.1327: T1 09:30, T2 PM) ───────────────────────── */

export const THERAPISTS: Therapist[] = [
  { key: "T1", personKey: "T1", label: "Tasha L." },
  { key: "T2", personKey: "T2", label: "Devon P." },
];
export const THERAPY_SESSIONS: TherapySession[] = [
  { key: "A1", therapistKey: "T1", childKey: "C3", start: "09:30", end: "10:15" },
  { key: "A2", therapistKey: "T2", childKey: "C6", start: "14:15", end: "15:00" },
];

/* ───────────────────────── what a finished day recorded (PRD §6.3) ───────────────────────── */

/**
 * Who received the child at the end of a ride.
 *
 * PRD §6.3: a handoff is a custody event naming the receiving adult, and the morning rule says
 * who that is — "at center = ramp staff" for a morning ride, and for an afternoon ride the adult
 * the family has on file with `can_receive_child` (PRD §6.4 RECEIVE_CHILD). It is a *kind* rather
 * than a name because the name is the family's, and this fixture holds no name a screen has not
 * already got: `receivingAdultOf` in src/domain/board/scenario.ts is the one place a receiving
 * adult is named, from the family's own guardian.
 */
export type Receiver = "CENTER_STAFF" | "ADULT_ON_FILE";

/**
 * One ride, as a finished service day recorded it.
 *
 * Only acts, never states: a state is what the leg machine (src/domain/machines.ts) makes of
 * these, one legal edge at a time, and a fixture that wrote "HELD_NO_RECEIVER" down would be
 * claiming an outcome instead of recording the day that produced it. The distinction is the
 * whole of AT-10 — a geofence arrival is a *vehicle* fact and can never be a child changing
 * hands — so `dropoffArrived` sits here beside the person acts and does not stand in for one.
 */
export type RideRecord = {
  childKey: string;
  direction: "AM" | "PM";
  /** The van left on its run (§6.3 MANIFEST_LOCKED → EN_ROUTE_PICKUP, by the provider). */
  departed: boolean;
  /** ASM-18: the geofence saw the van reach the child's stop. Not a person's act. */
  pickupArrived: boolean;
  /** Who reported the child aboard (§6.3 ARRIVED_PICKUP → BOARDED_REPORTED, by G or P). */
  boardingReportedBy: "GUARDIAN" | "PROVIDER" | null;
  /** Staff verified the boarding (§6.3 → BOARDED_VERIFIED, staff only — never the agent). */
  boardingVerified: boolean;
  /** ASM-18: the geofence saw the van reach the drop-off. Not a person's act either. */
  dropoffArrived: boolean;
  /** The custody event, or `null` when none was recorded — which is not the same as a refusal. */
  receivedBy: Receiver | null;
  /** Staff cancelled the ride before anyone boarded (§6.3 CANCELED_TRANSPORT, pre-boarding). */
  canceledByStaff?: true;
};

/**
 * The three rides a finished day did **not** close the ordinary way. Everything else on it ran:
 * reported aboard, verified, driven, and received — by the ramp in the morning and by the adult
 * on file in the afternoon.
 *
 *  - **C2's afternoon ride is AT-13.** F2 holds every scope except RECEIVE_CHILD (see
 *    `NO_RECEIVER_SCOPES`), so when the van reached Noah O.'s stop there was nobody on file to
 *    receive him and no custody event to record. The leg ends HELD_NO_RECEIVER: he waits with
 *    the van, every authorized and emergency contact is called, a staff task is raised, and
 *    **nothing returns him to the centre on its own** (PRD §6.6 CA-04, DECISION-LEDGER row 47).
 *    The machine agrees it is a dead end — HELD_NO_RECEIVER is in `noWildcardFrom` and exits by
 *    staff only — so a day that ends there stays there, which is what "no auto-return" looks
 *    like on a board.
 *  - **C6's afternoon ride is AT-10.** The van arrived and the handoff was never recorded. The
 *    geofence fired; a person still has to receive the child; the board says "Arrived (vehicle)"
 *    and asks for the handoff, and the one thing it must never say is that one happened.
 *  - **R3's six rides never ran.** V4 is a sedan with two tether-capable seats and R3's three
 *    children all ride in an anchored seat (PRD §7 constraint 3), so the capacity solver says
 *    the van does not fit its riders. Staff cancelled transport and the families drove — the
 *    AT-12 rule that a family is told only after staff have chosen.
 */
const FINISHED_DAY_EXCEPTIONS: Record<string, Partial<RideRecord>> = {
  "C2/PM": { receivedBy: null },
  "C6/PM": { receivedBy: null },
  ...Object.fromEntries(
    ["C1", "C4", "C5"].flatMap((childKey) =>
      (["AM", "PM"] as const).map((direction) => [
        `${childKey}/${direction}`,
        {
          departed: false,
          pickupArrived: false,
          boardingReportedBy: null,
          boardingVerified: false,
          dropoffArrived: false,
          receivedBy: null,
          canceledByStaff: true as const,
        },
      ]),
    ),
  ),
};

/** The ordinary outcome: aboard, verified, driven, and received at the end of the ride. */
function ranAsPlanned(childKey: string, direction: "AM" | "PM"): RideRecord {
  return {
    childKey,
    direction,
    departed: true,
    pickupArrived: true,
    // At home or at the ramp, it is the driver who reports the child aboard (§6.3 G/P).
    boardingReportedBy: "PROVIDER",
    boardingVerified: true,
    dropoffArrived: true,
    receivedBy: direction === "AM" ? "CENTER_STAFF" : "ADULT_ON_FILE",
  };
}

/**
 * Every ride a finished service day recorded, in run order: the children who are on a run, both
 * halves of their day, with the three exceptions above applied.
 *
 * The census children are not in here. They have no run — their family brings them — so there is
 * no ride for a day to record, and inventing one would put a van in a story that has none.
 */
export const FINISHED_DAY_RIDES: RideRecord[] = RUNS.flatMap((run) =>
  run.childKeys.flatMap((childKey) =>
    (["AM", "PM"] as const).map((direction) => ({
      ...ranAsPlanned(childKey, direction),
      ...FINISHED_DAY_EXCEPTIONS[`${childKey}/${direction}`],
    })),
  ),
);

export const rideRecordFor = (
  childKey: string,
  direction: "AM" | "PM",
): RideRecord | undefined =>
  FINISHED_DAY_RIDES.find((r) => r.childKey === childKey && r.direction === direction);

/**
 * The one ride the **demo day** has an outcome for: C2's afternoon, AT-13.
 *
 * Vera's call, 2026-10-16. The hold and the rule that goes with it — a child waits with the van
 * and nothing brings them back on its own (PRD §6.6 CA-04) — are the hardest thing on this board
 * to infer and the worst thing to find out late, and until now they existed only on the day
 * *before* the demo day, which the console offers no way to reach (slice 2 took the date switcher
 * out). A story the demo walk cannot reach is a story the demo does not tell, so this ride is on
 * the day the walk opens.
 *
 * Acts, never a state, exactly like the finished day's records: the leg machine in
 * src/domain/board/board.ts makes HELD_NO_RECEIVER out of them one legal edge at a time, so this
 * fixture cannot claim an outcome the domain would refuse. F2 holds every scope except
 * RECEIVE_CHILD (`NO_RECEIVER_SCOPES`), so the afternoon van reached Noah O.'s stop with nobody
 * on file to receive him and no custody event to record.
 *
 * And it is read **when the clock reaches it**, not before (Firia, 2026-10-17). This ride's window
 * is 4:20 PM and the demo day is read twelve minutes into its morning runs
 * (`BOARD_SCENARIO_SECONDS`), so the board used to show the hold while Noah's morning row was
 * still on the road beside it — a child set down at home before the van that collects him had
 * finished its run. `dayRecordFor` in src/domain/board/board.ts compares the day's instant with
 * the ride's planned window and declines to read a record the day has not got to, so this one is
 * a scheduled afternoon until 4:20 PM and the hold after it. That answers the open question in
 * docs/ui/B12-SLICE2-DEFERRED.md §5 the way that costs nothing.
 *
 * The consequence is that the demo walk's own board no longer *shows* the hold: a clock that
 * walks the day is what would carry it there, and this build has none (B-10). What the walk does
 * reach is the rule the hold is about — nobody on file may receive this child, and if nobody is
 * there he waits with the van and nothing brings him back — said in the present tense, on the
 * afternoon row and in the drawer, where a coordinator can still act on it. The finished day is
 * where the ended ride itself is read.
 */
export const DEMO_DAY_RIDES: RideRecord[] = [{ ...ranAsPlanned("C2", "PM"), receivedBy: null }];

export const demoDayRecordFor = (
  childKey: string,
  direction: "AM" | "PM",
): RideRecord | undefined =>
  DEMO_DAY_RIDES.find((r) => r.childKey === childKey && r.direction === direction);

/* ───────────────────────── schedules (PRD l.1329: Mon–Fri + one date exception) ───────────────────────── */

export const WEEKDAY_RRULE = "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR";
/** The single date exception: C8 is away on a family trip one week out. Today's board is untouched. */
export const DATE_EXCEPTION = { childKey: "C8", daysFromToday: 7, scope: "FULL_DAY", reason: "family travel" } as const;

/** Scenario clock start after a reset (MOCKS §6 "clock = 06:00 today"), site-local. */
export const SCENARIO_START_LOCAL = "06:00";
export const SCENARIO_NAME = "standard";

/* ───────────────────────── derived lookups ───────────────────────── */

export const stopByKey = (key: string): Stop => {
  const s = STOPS.find((x) => x.key === key);
  if (!s) throw new Error(`unknown stop ${key}`);
  return s;
};
export const childByKey = (key: string): Child => {
  const c = CHILDREN.find((x) => x.key === key);
  if (!c) throw new Error(`unknown child ${key}`);
  return c;
};
export const familyByKey = (key: string): Family => {
  const f = FAMILIES.find((x) => x.key === key);
  if (!f) throw new Error(`unknown family ${key}`);
  return f;
};
/** Index within its kind, used to build the deterministic id. */
export const indexOfChild = (key: string): number => CHILDREN.findIndex((c) => c.key === key);
export const indexOfFamily = (key: string): number => FAMILIES.findIndex((f) => f.key === key);
export const runOfChild = (key: string): Run | undefined => RUNS.find((r) => r.childKeys.includes(key));

/** Every coordinate this fixture set may use (MOCKS §1); the seed linter enforces the same list. */
export const ALLOWED_COORDS: number[] = STOPS.flatMap((s) => [s.lat, s.lng]);
