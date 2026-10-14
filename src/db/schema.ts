/**
 * PPEC transportation dashboard: DRAFT Drizzle schema (spec artifact, not yet a migration).
 * Source of truth: PRD v1.0 §6.1 (tables), §6.3 (state machines), §6.4 (authorization), §12 (contracts).
 * Status: B-02 migration source (from docs/schema-draft.ts, PROPOSED by Firia 2026-10-14). Typechecked with drizzle-orm 0.45.4 + typescript 5 (see DATA-MODEL.md "Evidence").
 *
 * Conventions (PRD §6.1, Tokos reuse notes in TOKOS-REUSE.md):
 *  - Two Postgres schemas: `identity` (restricted: legal names, phones, DOB) and `ops` (tokenized).
 *    `child_token` / `contact_token` are the ONLY person references inside ops.
 *  - Every ops row carries: id (UUIDv7, app-generated), site_id, version, created_at/by, updated_at/by, source_mode.
 *  - Timestamps are timestamptz. Operational "service dates" are `date` in the site's timezone (America/New_York).
 *  - State columns are Postgres enums; allowed transitions live in code (src/domain/machines.ts) and are enforced in
 *    one function, `transition()`, which does UPDATE ... WHERE id=$1 AND version=$2 AND state=$from (optimistic + guarded).
 */
import { sql } from "drizzle-orm";
import {
  boolean, date, doublePrecision, index, integer, jsonb, pgEnum, pgSchema, smallint,
  text, timestamp, uniqueIndex, uuid, bigserial, bigint, primaryKey, check,
} from "drizzle-orm/pg-core";

export const identity = pgSchema("identity");
export const ops = pgSchema("ops");

/* ───────────────────────────── shared enums ───────────────────────────── */
export const sourceMode = pgEnum("source_mode", ["LIVE", "SANDBOX", "REPLAY", "SIMULATED", "MANUAL"]);
export const staffRole = pgEnum("staff_role", ["DIRECTOR", "COORDINATOR", "FRONT_DESK", "PLATFORM_ADMIN"]);
export const actorKind = pgEnum("actor_kind", ["STAFF", "PROVIDER", "GUARDIAN", "THERAPIST", "AGENT", "SYSTEM", "DEMO"]);

/* §6.3 state machines (frozen) */
export const legState = pgEnum("leg_state", [
  "SCHEDULED", "PROVISIONAL_ASSIGNED", "CAPABILITY_PENDING", "CAPABILITY_REPORTED", "CAPABILITY_VERIFIED",
  "MANIFEST_LOCKED", "EN_ROUTE_PICKUP", "ARRIVED_PICKUP", "BOARDED_REPORTED", "BOARDED_VERIFIED",
  "IN_TRANSIT", "ARRIVED_DROPOFF", "COMPLETED_HANDOFF",
  "CANCELED_TRANSPORT", "CANCELED_ATTENDANCE", "NO_SHOW", "HELD_NO_RECEIVER", "LEFT_BEHIND_CAPACITY", "EXCEPTION",
]);
export const attendanceState = pgEnum("attendance_state", [
  "SCHEDULED", "EXPECTED_LATE", "AM_SELF_DROP", "CHECKED_IN", "EARLY_DEPARTURE", "CHECKED_OUT", "ABSENT_FULL_DAY",
]);
export const capabilityState = pgEnum("capability_state", [
  "UNKNOWN", "REQUESTED", "REPORTED", "VERIFIED", "CHANGED", "REJECTED", "UNAVAILABLE", "VERIFIED_INFEASIBLE",
]);
export const reservationState = pgEnum("reservation_state", [
  "PROVISIONAL", "FEASIBLE", "INFEASIBLE", "COMMITTED", "RELEASED", "NEEDS_REVIEW",
]);
export const outboundState = pgEnum("outbound_state", [
  "DRAFTED", "POLICY_CHECKED", "QUEUED", "BLOCKED_EGRESS", "SENDING", "SENT", "DELIVERED", "UNDELIVERED",
  "FAILED", "UNKNOWN", "REDACTED", "CANCELED_STALE",
]);
export const ackState = pgEnum("ack_state", ["PENDING", "ACKNOWLEDGED", "DECLINED", "EXPIRED_ESCALATED", "SUPERSEDED"]);
export const taskState = pgEnum("task_state", [
  "OPEN", "IN_PROGRESS", "RESOLVED_APPROVED", "RESOLVED_OVERRIDE", "CLOSED_VERIFIED", "SNOOZED",
]);
export const threadState = pgEnum("thread_state", ["OPEN", "PAUSED_HUMAN", "CLOSED"]);
export const profileState = pgEnum("profile_state", ["DRAFT", "APPROVED", "SUPERSEDED"]);
export const needItemState = pgEnum("need_item_state", ["UNKNOWN", "REPORTED", "VERIFIED", "APPROVED"]);

export const legDirection = pgEnum("leg_direction", ["AM", "PM"]);
export const legMode = pgEnum("leg_mode", ["PROVIDER", "FAMILY", "CENTER"]);
export const dispatchOwnership = pgEnum("dispatch_ownership", ["CENTER_FLEET", "THIRD_PARTY", "BROKER_NEMT"]);
export const channel = pgEnum("channel", ["SMS_1TO1", "MMS_GROUP", "TEAMS", "VOICE_TASK", "DISPATCHER_LINK"]);
export const severity = pgEnum("severity", ["GREEN", "AMBER", "RED"]);
export const securement = pgEnum("securement", ["L_TRACK", "SLIDE_N_CLICK", "FOUR_POINT_STRAP", "OTHER"]);
export const mobility = pgEnum("mobility", ["AMB", "WC"]);
export const jobState = pgEnum("job_state", ["SCHEDULED", "CLAIMED", "DONE", "CANCELED", "FAILED", "DEAD"]);
export const agentRunState = pgEnum("agent_run_state", [
  "QUEUED", "RUNNING", "WAITING_TOOL", "SUCCEEDED", "FAILED", "ABORTED_SUPERSEDED_BY_HUMAN",
]);
export const roiCohort = pgEnum("roi_cohort", ["SYNTHETIC", "BASELINE", "LIVE"]);
export const authScope = pgEnum("auth_scope", [
  "RECEIVE_TRANSPORT_UPDATES", "CANCEL_LEG", "CHANGE_PICKUP_INSTRUCTIONS", "CONFIRM_AVAILABILITY_TO_RECEIVE",
  "RECEIVE_ATTENDANCE_UPDATES", "ACCESS_SENSITIVE_INFO", "RECEIVE_CHILD",
]);

/* ───────────────────────────── common columns ───────────────────────────── */
const audit = {
  version: integer("version").notNull().default(1),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  createdBy: text("created_by").notNull(), // "staff:<uuid>" | "agent:<run_id>" | "system:<job>" | "demo"
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  updatedBy: text("updated_by").notNull(),
  sourceMode: sourceMode("source_mode").notNull().default("SIMULATED"),
};
const pk = () => uuid("id").primaryKey(); // UUIDv7 generated in app (uuidv7 1.2.1)
const site = () => uuid("site_id").notNull();
// FK to ops.site (B-02, DATA-MODEL §6.1): used on non-append-only ops tables.
const siteRef = () => uuid("site_id").notNull().references(() => siteT.id, { onDelete: "restrict" });

/* ───────────────────────────── identity schema ─────────────────────────────
 * Restricted. App role `app_rw` gets NO select on these; only `identity_gateway` role (used by IdentityGateway)
 * does. In P2/AWS: KMS CMK per data class + RLS (B-19). In P1: pgcrypto/app-level AES-GCM with key from env. */
export const childIdentity = identity.table("child_identity", {
  childToken: uuid("child_token").primaryKey(),
  siteId: siteRef(),
  externalEhrId: text("external_ehr_id").notNull(),
  legalFirstName: text("legal_first_name").notNull(),
  legalLastName: text("legal_last_name").notNull(),
  dob: date("dob"),
  addressEnc: text("address_enc"),            // ciphertext; geocode stored separately on ops.stop_location
  keyVersion: smallint("key_version").notNull().default(1),
  ...audit,
}, (t) => [uniqueIndex("child_identity_ehr_uq").on(t.siteId, t.externalEhrId)]);

export const guardianContact = identity.table("guardian_contact", {
  contactToken: uuid("contact_token").primaryKey(),
  siteId: siteRef(),
  familyGroupId: uuid("family_group_id").notNull().references(() => familyGroup.id, { onDelete: "restrict" }), // identity→ops is allowed; ops→identity is not
  legalName: text("legal_name").notNull(),
  phoneHmac: text("phone_hmac").notNull(),    // HMAC-SHA256(E.164, pepper) blind index for inbound resolution
  phoneEnc: text("phone_enc").notNull(),
  relationship: text("relationship").notNull(),
  canReceiveUpdates: boolean("can_receive_updates").notNull().default(false),
  canRequestChanges: boolean("can_request_changes").notNull().default(false),
  canReceiveChild: boolean("can_receive_child").notNull().default(false),
  isEmergency: boolean("is_emergency").notNull().default(false),
  validFrom: timestamp("valid_from", { withTimezone: true }).notNull().defaultNow(),
  validTo: timestamp("valid_to", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  keyVersion: smallint("key_version").notNull().default(1),
  ...audit,
}, (t) => [index("guardian_contact_phone_hmac_idx").on(t.phoneHmac), index("guardian_contact_family_idx").on(t.familyGroupId)]);

/** Append-only (no UPDATE/DELETE grant). STOP/HELP/NL opt-out/re-subscribe. 10-year retention pending counsel (§15.4). */
export const consentEvent = identity.table("consent_event", {
  id: pk(), siteId: site(),
  contactToken: uuid("contact_token").notNull(),
  kind: text("kind").notNull(),               // OPT_IN | STOP | HELP | NL_OPT_OUT | START | PERMANENT_TEST_OPT_OUT
  channel: channel("channel").notNull(),
  evidenceMessageId: uuid("evidence_message_id"),
  at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  sourceMode: sourceMode("source_mode").notNull(),
}, (t) => [index("consent_event_contact_idx").on(t.contactToken, t.at)]);

/** Therapists and provider dispatchers are people too: same vault pattern. */
export const externalPersonIdentity = identity.table("external_person_identity", {
  personToken: uuid("person_token").primaryKey(), siteId: siteRef(),
  kind: text("kind").notNull(),               // THERAPIST | PROVIDER_DISPATCHER | DRIVER_DEVICE_HOLDER
  legalName: text("legal_name").notNull(),
  phoneHmac: text("phone_hmac"), phoneEnc: text("phone_enc"),
  ...audit,
}, (t) => [index("external_person_phone_hmac_idx").on(t.phoneHmac)]);

/* ───────────────────────────── ops: tenancy + auth ───────────────────────────── */
export const org = ops.table("org", { id: pk(), name: text("name").notNull(), ...audit });
export const siteT = ops.table("site", {
  id: pk(), orgId: uuid("org_id").references(() => org.id, { onDelete: "restrict" }).notNull(), name: text("name").notNull(),
  timezone: text("timezone").notNull().default("America/New_York"),
  stateProfile: text("state_profile").notNull().default("UNSET"), // ADR 6.3; CA-07 open
  depotLat: doublePrecision("depot_lat").notNull(), depotLng: doublePrecision("depot_lng").notNull(),
  ...audit,
});
/** Auth.js credentials users (POC). Staff only; families/therapists never log in (§1.1). */
export const appUser = ops.table("app_user", {
  id: pk(), email: text("email").notNull(), displayName: text("display_name").notNull(),
  passwordHash: text("password_hash").notNull(), disabledAt: timestamp("disabled_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex("app_user_email_uq").on(t.email)]);
/** Role is per site: a user may be COORDINATOR at site A and nothing at site B. */
export const siteMembership = ops.table("site_membership", {
  userId: uuid("user_id").references(() => appUser.id, { onDelete: "restrict" }).notNull(), siteId: siteRef(), role: staffRole("role").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.userId, t.siteId] })]);
/** Signed single-use dispatcher links (ADR 5.6): store only the hash of the token. */
export const dispatcherLink = ops.table("dispatcher_link", {
  id: pk(), siteId: siteRef(), providerId: uuid("provider_id").references(() => provider.id, { onDelete: "restrict" }).notNull(), vehicleId: uuid("vehicle_id").references(() => vehicle.id, { onDelete: "restrict" }),
  serviceDate: date("service_date").notNull(), purpose: text("purpose").notNull(), // CAPABILITY_VERIFY
  tokenHash: text("token_hash").notNull(), expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  usedAt: timestamp("used_at", { withTimezone: true }), ...audit,
}, (t) => [uniqueIndex("dispatcher_link_token_uq").on(t.tokenHash)]);

/* ───────────────────────────── ops: families, children, needs ───────────────────────────── */
export const familyGroup = ops.table("family_group", {
  id: pk(), siteId: siteRef(), displayLabel: text("display_label").notNull(), // "F4 (Demo)"; masked
  ...audit,
});
export const childProfile = ops.table("child_profile", {
  childToken: uuid("child_token").primaryKey(), siteId: siteRef(), familyGroupId: uuid("family_group_id").references(() => familyGroup.id, { onDelete: "restrict" }).notNull(),
  displayName: text("display_name").notNull(), // first name + initial only (§15.2)
  ...audit,
}, (t) => [index("child_profile_family_idx").on(t.familyGroupId)]);
/** §6.4: contact_person × child × action_scope × channel × validity_window. Phone match = recognized, not authorized. */
export const contactAuthorization = ops.table("contact_authorization", {
  id: pk(), siteId: siteRef(), contactToken: uuid("contact_token").notNull(), childToken: uuid("child_token").references(() => childProfile.childToken, { onDelete: "restrict" }).notNull(),
  scope: authScope("scope").notNull(), channel: channel("channel").notNull(),
  validFrom: timestamp("valid_from", { withTimezone: true }).notNull(), validTo: timestamp("valid_to", { withTimezone: true }),
  ...audit,
}, (t) => [index("contact_auth_lookup_idx").on(t.contactToken, t.childToken, t.scope)]);
export const stopLocation = ops.table("stop_location", {
  id: pk(), siteId: siteRef(), label: text("label").notNull(),   // "Okeeheelee Park (landmark)"; never a home in P1
  lat: doublePrecision("lat").notNull(), lng: doublePrecision("lng").notNull(),
  childToken: uuid("child_token").references(() => childProfile.childToken, { onDelete: "restrict" }), isCenter: boolean("is_center").notNull().default(false), ...audit,
});
export const transportProfile = ops.table("transport_profile", {
  id: pk(), siteId: siteRef(), childToken: uuid("child_token").references(() => childProfile.childToken, { onDelete: "restrict" }).notNull(),
  profileVersion: integer("profile_version").notNull(), status: profileState("status").notNull().default("DRAFT"),
  mobility: mobility("mobility").notNull(),
  wcLengthCm: integer("wc_length_cm"), wcWidthCm: integer("wc_width_cm"), securement: securement("securement"),
  tether: boolean("tether").notNull().default(false), escortRequired: boolean("escort_required").notNull().default(false),
  maxRideMinutes: integer("max_ride_minutes"),
  approvedBy: uuid("approved_by"), approvedAt: timestamp("approved_at", { withTimezone: true }),
  ...audit,
}, (t) => [uniqueIndex("transport_profile_child_ver_uq").on(t.childToken, t.profileVersion),
  uniqueIndex("transport_profile_one_approved_uq").on(t.childToken).where(sql`status = 'APPROVED'`)]);
export const transportNeedItem = ops.table("transport_need_item", {
  id: pk(), siteId: siteRef(), profileId: uuid("profile_id").references(() => transportProfile.id, { onDelete: "restrict" }).notNull(),
  category: text("category").notNull(), // §9 approved-need categories
  value: jsonb("value").notNull(), state: needItemState("state").notNull().default("UNKNOWN"),
  evidenceRef: text("evidence_ref"), ...audit,
}, (t) => [index("need_item_profile_idx").on(t.profileId)]);

/* ───────────────────────────── ops: attendance + therapy ───────────────────────────── */
export const attendancePlan = ops.table("attendance_plan", {
  id: pk(), siteId: siteRef(), childToken: uuid("child_token").references(() => childProfile.childToken, { onDelete: "restrict" }).notNull(),
  rrule: text("rrule").notNull(), amMode: legMode("am_mode").notNull(), pmMode: legMode("pm_mode").notNull(),
  amWindowStart: text("am_window_start").notNull(), pmWindowStart: text("pm_window_start").notNull(), // "07:30" local
  validFrom: date("valid_from").notNull(), validTo: date("valid_to"), ...audit,
});
export const attendanceException = ops.table("attendance_exception", {
  id: pk(), siteId: siteRef(), childToken: uuid("child_token").references(() => childProfile.childToken, { onDelete: "restrict" }).notNull(), serviceDate: date("service_date").notNull(),
  scope: text("scope").notNull(), // FULL_DAY | AM | PM | MODE_CHANGE
  reason: text("reason"), expectedSelfArrival: text("expected_self_arrival"),
  changeRequestId: uuid("change_request_id").references(() => changeRequest.id, { onDelete: "restrict" }), ...audit,
}, (t) => [index("att_exc_child_date_idx").on(t.childToken, t.serviceDate)]);
export const attendanceDay = ops.table("attendance_day", {
  id: pk(), siteId: siteRef(), childToken: uuid("child_token").references(() => childProfile.childToken, { onDelete: "restrict" }).notNull(), serviceDate: date("service_date").notNull(),
  state: attendanceState("state").notNull().default("SCHEDULED"), ...audit,
}, (t) => [uniqueIndex("attendance_day_uq").on(t.childToken, t.serviceDate)]);
export const attendanceEvent = ops.table("attendance_event", {
  id: pk(), siteId: site(), attendanceDayId: uuid("attendance_day_id").notNull(), kind: text("kind").notNull(),
  observedAt: timestamp("observed_at", { withTimezone: true }).notNull(), recordedLate: boolean("recorded_late").notNull().default(false),
  receivingContactToken: uuid("receiving_contact_token"), idempotencyKey: text("idempotency_key").notNull(), ...audit,
}, (t) => [uniqueIndex("attendance_event_idem_uq").on(t.idempotencyKey)]);
export const therapist = ops.table("therapist", {
  id: pk(), siteId: siteRef(), personToken: uuid("person_token").notNull(), displayName: text("display_name").notNull(), ...audit,
});
export const therapySession = ops.table("therapy_session", {
  id: pk(), siteId: siteRef(), therapistId: uuid("therapist_id").references(() => therapist.id, { onDelete: "restrict" }).notNull(), childToken: uuid("child_token").references(() => childProfile.childToken, { onDelete: "restrict" }).notNull(),
  startsAt: timestamp("starts_at", { withTimezone: true }).notNull(), endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
  status: text("status").notNull().default("SCHEDULED"), // SCHEDULED | IMPACTED | THERAPIST_NOTIFIED | CANCELED
  ...audit,
}, (t) => [index("therapy_child_time_idx").on(t.childToken, t.startsAt)]);

/* ───────────────────────────── ops: providers, vehicles, capability ───────────────────────────── */
export const provider = ops.table("provider", {
  id: pk(), siteId: siteRef(), name: text("name").notNull(), dispatchOwnership: dispatchOwnership("dispatch_ownership").notNull(),
  dispatcherPersonToken: uuid("dispatcher_person_token"), ...audit,
});
export const vehicle = ops.table("vehicle", {
  id: pk(), siteId: siteRef(), providerId: uuid("provider_id").references(() => provider.id, { onDelete: "restrict" }), label: text("label").notNull(), // "V1 convertible van"
  liftEquipped: boolean("lift_equipped").notNull(), ...audit,
});
/** Mutually exclusive layouts (§7). Positions as child rows so the solver gets per-position sec/len/wid. */
export const vehicleLayout = ops.table("vehicle_layout", {
  id: pk(), siteId: siteRef(), vehicleId: uuid("vehicle_id").references(() => vehicle.id, { onDelete: "restrict" }).notNull(), code: text("code").notNull(), // "1WC/3A"
  liftRequired: boolean("lift_required").notNull(), ...audit,
}, (t) => [uniqueIndex("vehicle_layout_code_uq").on(t.vehicleId, t.code)]);
export const layoutPosition = ops.table("layout_position", {
  id: pk(), siteId: siteRef(), layoutId: uuid("layout_id").references(() => vehicleLayout.id, { onDelete: "restrict" }).notNull(),
  kind: text("kind").notNull(), // WC | AMB
  securement: securement("securement"), maxLengthCm: integer("max_length_cm"), maxWidthCm: integer("max_width_cm"),
  tetherCapable: boolean("tether_capable").notNull().default(false), ...audit,
}, (t) => [index("layout_position_layout_idx").on(t.layoutId)]);
export const vehicleCapabilityDay = ops.table("vehicle_capability_day", {
  id: pk(), siteId: siteRef(), vehicleId: uuid("vehicle_id").references(() => vehicle.id, { onDelete: "restrict" }).notNull(), serviceDate: date("service_date").notNull(),
  state: capabilityState("state").notNull().default("UNKNOWN"),
  liftOk: boolean("lift_ok"), unavailablePositionIds: uuid("unavailable_position_ids").array().notNull().default(sql`'{}'`),
  observedAt: timestamp("observed_at", { withTimezone: true }), observedBy: text("observed_by"),
  evidenceMessageId: uuid("evidence_message_id").references(() => message.id, { onDelete: "restrict" }), ...audit,
}, (t) => [uniqueIndex("vehicle_capability_day_uq").on(t.vehicleId, t.serviceDate)]);

/* ───────────────────────────── ops: legs + manifests ───────────────────────────── */
export const manifest = ops.table("manifest", {
  id: pk(), siteId: siteRef(), serviceDate: date("service_date").notNull(), direction: legDirection("direction").notNull(),
  providerId: uuid("provider_id").references(() => provider.id, { onDelete: "restrict" }), vehicleId: uuid("vehicle_id").references(() => vehicle.id, { onDelete: "restrict" }), layoutId: uuid("layout_id").references(() => vehicleLayout.id, { onDelete: "restrict" }),
  lockedAt: timestamp("locked_at", { withTimezone: true }), planVersion: integer("plan_version").notNull().default(1), ...audit,
}, (t) => [index("manifest_site_date_idx").on(t.siteId, t.serviceDate)]);
export const tripLeg = ops.table("trip_leg", {
  id: pk(), siteId: siteRef(), childToken: uuid("child_token").references(() => childProfile.childToken, { onDelete: "restrict" }).notNull(), serviceDate: date("service_date").notNull(),
  direction: legDirection("direction").notNull(), mode: legMode("mode").notNull(),
  state: legState("state").notNull().default("SCHEDULED"), priorState: legState("prior_state"),
  manifestId: uuid("manifest_id").references(() => manifest.id, { onDelete: "restrict" }), stopSeq: smallint("stop_seq"), stopLocationId: uuid("stop_location_id").references(() => stopLocation.id, { onDelete: "restrict" }),
  windowStart: timestamp("window_start", { withTimezone: true }), receiverConfirmedAt: timestamp("receiver_confirmed_at", { withTimezone: true }),
  planVersion: integer("plan_version").notNull().default(1), ...audit,
}, (t) => [uniqueIndex("trip_leg_child_date_dir_uq").on(t.childToken, t.serviceDate, t.direction),
  index("trip_leg_board_idx").on(t.siteId, t.serviceDate, t.state), index("trip_leg_manifest_idx").on(t.manifestId, t.stopSeq)]);
export const manifestReservation = ops.table("manifest_reservation", {
  id: pk(), siteId: siteRef(), manifestId: uuid("manifest_id").references(() => manifest.id, { onDelete: "restrict" }).notNull(), tripLegId: uuid("trip_leg_id").references(() => tripLeg.id, { onDelete: "restrict" }).notNull(),
  state: reservationState("state").notNull().default("PROVISIONAL"), positionId: uuid("position_id").references(() => layoutPosition.id, { onDelete: "restrict" }),
  deficit: jsonb("deficit"), ...audit,
}, (t) => [uniqueIndex("manifest_reservation_leg_uq").on(t.manifestId, t.tripLegId)]);

/* ───────────────────────────── ops: location + ETA ───────────────────────────── */
export const device = ops.table("device", {
  id: pk(), siteId: siteRef(), externalDeviceId: text("external_device_id").notNull(), adapter: text("adapter").notNull(), // SIM | OSMAND | JSON
  secretHash: text("secret_hash").notNull(), ...audit,
}, (t) => [uniqueIndex("device_ext_uq").on(t.adapter, t.externalDeviceId)]);
export const deviceBinding = ops.table("device_binding", {
  id: pk(), siteId: siteRef(), deviceId: uuid("device_id").references(() => device.id, { onDelete: "restrict" }).notNull(), vehicleId: uuid("vehicle_id").references(() => vehicle.id, { onDelete: "restrict" }).notNull(),
  manifestId: uuid("manifest_id").references(() => manifest.id, { onDelete: "restrict" }), activeFrom: timestamp("active_from", { withTimezone: true }).notNull(),
  activeTo: timestamp("active_to", { withTimezone: true }), ...audit,
}, (t) => [index("device_binding_active_idx").on(t.deviceId, t.activeFrom)]);
/** Append-only. Unbound points are stored with bound=false and shown nowhere (LOC-01). */
export const telemetryPoint = ops.table("telemetry_point", {
  id: bigserial("id", { mode: "bigint" }).primaryKey(), siteId: site(), deviceId: uuid("device_id").notNull(),
  vehicleId: uuid("vehicle_id"), recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull(),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  lat: doublePrecision("lat").notNull(), lng: doublePrecision("lng").notNull(),
  speedMps: doublePrecision("speed_mps"), headingDeg: doublePrecision("heading_deg"),
  bound: boolean("bound").notNull(), late: boolean("late").notNull().default(false), sourceMode: sourceMode("source_mode").notNull(),
}, (t) => [uniqueIndex("telemetry_dedupe_uq").on(t.deviceId, t.recordedAt), index("telemetry_vehicle_time_idx").on(t.vehicleId, t.recordedAt)]);
export const etaEstimate = ops.table("eta_estimate", {
  id: pk(), siteId: siteRef(), tripLegId: uuid("trip_leg_id").references(() => tripLeg.id, { onDelete: "restrict" }).notNull(), computedAt: timestamp("computed_at", { withTimezone: true }).notNull(),
  etaAt: timestamp("eta_at", { withTimezone: true }).notNull(), uncertaintySec: integer("uncertainty_sec").notNull(),
  windowStart: timestamp("window_start", { withTimezone: true }).notNull(), windowEnd: timestamp("window_end", { withTimezone: true }).notNull(),
  basisTelemetryId: bigint("basis_telemetry_id", { mode: "bigint" }), routingRequestId: text("routing_request_id"),
  consecutiveShiftCount: smallint("consecutive_shift_count").notNull().default(0), notified: boolean("notified").notNull().default(false),
  ...audit,
}, (t) => [index("eta_leg_time_idx").on(t.tripLegId, t.computedAt)]);

/* ───────────────────────────── ops: messaging ───────────────────────────── */
export const conversationThread = ops.table("conversation_thread", {
  id: pk(), siteId: siteRef(), familyGroupId: uuid("family_group_id").references(() => familyGroup.id, { onDelete: "restrict" }), counterpartyToken: uuid("counterparty_token"),
  channel: channel("channel").notNull(), state: threadState("state").notNull().default("OPEN"),
  ownerUserId: uuid("owner_user_id").references(() => appUser.id, { onDelete: "restrict" }), lastActivityAt: timestamp("last_activity_at", { withTimezone: true }).notNull().defaultNow(), ...audit,
}, (t) => [index("thread_family_idx").on(t.familyGroupId, t.lastActivityAt)]);
export const message = ops.table("message", {
  id: pk(), siteId: siteRef(), threadId: uuid("thread_id").references(() => conversationThread.id, { onDelete: "restrict" }).notNull(), direction: text("direction").notNull(), // IN | OUT
  provider: text("provider").notNull(), externalId: text("external_id").notNull(), // SIM-xxxx | Twilio SID
  fromHmac: text("from_hmac").notNull(), isOwnEcho: boolean("is_own_echo").notNull().default(false),
  bodyTokenized: text("body_tokenized").notNull(), bodyEnc: text("body_enc"), // plaintext only encrypted; 90 d (FQ-12 default)
  rawPayloadHash: text("raw_payload_hash").notNull(), providerIndex: bigint("provider_index", { mode: "bigint" }),
  resolvedChildTokens: uuid("resolved_child_tokens").array(), resolveConfidence: doublePrecision("resolve_confidence"),
  idempotencyKey: text("idempotency_key").notNull(), receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(), ...audit,
}, (t) => [uniqueIndex("message_provider_ext_uq").on(t.provider, t.externalId), index("message_thread_idx").on(t.threadId, t.receivedAt)]);
export const changeRequest = ops.table("change_request", {
  id: pk(), siteId: siteRef(), kind: text("kind").notNull(), subjectChildTokens: uuid("subject_child_tokens").array().notNull(),
  basisMessageId: uuid("basis_message_id").references(() => message.id, { onDelete: "restrict" }), confidence: doublePrecision("confidence"), payload: jsonb("payload").notNull(),
  status: text("status").notNull(), // PROPOSED | APPLIED | REJECTED | SUPERSEDED | NEEDS_HUMAN
  supersededBy: uuid("superseded_by"), ...audit,
});
/** The transactional outbox for external sends. Written in the SAME transaction as the state change. */
export const outboundMessage = ops.table("outbound_message", {
  id: pk(), siteId: siteRef(), purpose: text("purpose").notNull(), recipientRule: text("recipient_rule").notNull(),
  recipientToken: uuid("recipient_token"), // resolved at send time by IdentityGateway, never by agent
  channel: channel("channel").notNull(), templateId: text("template_id").notNull(), vars: jsonb("vars").notNull(),
  tripLegId: uuid("trip_leg_id").references(() => tripLeg.id, { onDelete: "restrict" }), therapySessionId: uuid("therapy_session_id").references(() => therapySession.id, { onDelete: "restrict" }),
  planVersionBasis: integer("plan_version_basis").notNull(), notAfter: timestamp("not_after", { withTimezone: true }).notNull(),
  state: outboundState("state").notNull().default("DRAFTED"), blockReason: text("block_reason"),
  providerMessageId: text("provider_message_id"), idempotencyKey: text("idempotency_key").notNull(),
  attempts: smallint("attempts").notNull().default(0), nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
  ...audit,
}, (t) => [uniqueIndex("outbound_idem_uq").on(t.idempotencyKey), index("outbound_drain_idx").on(t.state, t.nextAttemptAt),
  index("outbound_leg_idx").on(t.tripLegId)]);
export const acknowledgment = ops.table("acknowledgment", {
  id: pk(), siteId: siteRef(), outboundMessageId: uuid("outbound_message_id").references(() => outboundMessage.id, { onDelete: "restrict" }).notNull(), contactToken: uuid("contact_token").notNull(),
  state: ackState("state").notNull().default("PENDING"), dueAt: timestamp("due_at", { withTimezone: true }).notNull(),
  timerJobId: uuid("timer_job_id").references(() => job.id, { onDelete: "restrict" }), ...audit,
});
export const suppression = ops.table("suppression", {
  id: pk(), siteId: siteRef(), contactToken: uuid("contact_token").notNull(), scope: text("scope").notNull(), // ALL_NON_SAFETY | ALL
  permanentTest: boolean("permanent_test").notNull().default(false), consentEventId: uuid("consent_event_id").notNull(),
  liftedAt: timestamp("lifted_at", { withTimezone: true }), ...audit,
}, (t) => [index("suppression_contact_idx").on(t.contactToken)]);

/* ───────────────────────────── ops: tasks, approvals, agent ───────────────────────────── */
export const task = ops.table("task", {
  id: pk(), siteId: siteRef(), category: text("category").notNull(), severity: severity("severity").notNull(),
  state: taskState("state").notNull().default("OPEN"), tripLegId: uuid("trip_leg_id").references(() => tripLeg.id, { onDelete: "restrict" }), childToken: uuid("child_token").references(() => childProfile.childToken, { onDelete: "restrict" }),
  priorLegState: legState("prior_leg_state"), summary: text("summary").notNull(), nextStep: text("next_step"),
  ownerUserId: uuid("owner_user_id").references(() => appUser.id, { onDelete: "restrict" }), slaDueAt: timestamp("sla_due_at", { withTimezone: true }),
  snoozeReason: text("snooze_reason"), completionPredicate: text("completion_predicate").notNull(),
  completionEvidence: jsonb("completion_evidence"), ...audit,
}, (t) => [index("task_open_idx").on(t.siteId, t.state, t.severity),
  check("task_closed_needs_evidence", sql`state <> 'CLOSED_VERIFIED' OR completion_evidence IS NOT NULL`)]);
export const approvalRequest = ops.table("approval_request", {
  id: pk(), siteId: siteRef(), taskId: uuid("task_id").references(() => task.id, { onDelete: "restrict" }).notNull(), proposal: jsonb("proposal").notNull(), // structured diff
  decidedBy: uuid("decided_by"), decidedAt: timestamp("decided_at", { withTimezone: true }), decision: text("decision"),
  ...audit,
}); // decision race: UPDATE ... WHERE id=$1 AND decided_at IS NULL RETURNING → 0 rows = 409 ALREADY_DECIDED
export const agentRun = ops.table("agent_run", {
  id: pk(), siteId: siteRef(), triggerType: text("trigger_type").notNull(), triggerId: text("trigger_id").notNull(),
  state: agentRunState("state").notNull().default("QUEUED"), model: text("model"), providerRouted: text("provider_routed"),
  promptHash: text("prompt_hash"), tokensIn: integer("tokens_in"), tokensOut: integer("tokens_out"), ...audit,
}, (t) => [uniqueIndex("agent_run_trigger_uq").on(t.triggerType, t.triggerId)]);
export const agentToolCall = ops.table("agent_tool_call", {
  id: pk(), siteId: siteRef(), runId: uuid("run_id").references(() => agentRun.id, { onDelete: "restrict" }).notNull(), seq: smallint("seq").notNull(), tool: text("tool").notNull(),
  argsHash: text("args_hash").notNull(), args: jsonb("args").notNull(), policyDecision: text("policy_decision").notNull(),
  result: jsonb("result"), committedAt: timestamp("committed_at", { withTimezone: true }), ...audit,
}, (t) => [uniqueIndex("agent_tool_call_seq_uq").on(t.runId, t.seq)]);
export const agentMemory = ops.table("agent_memory", {
  id: pk(), siteId: siteRef(), contactToken: uuid("contact_token").notNull(), key: text("key").notNull(), value: text("value").notNull(),
  approvedBy: uuid("approved_by").notNull(), expiresAt: timestamp("expires_at", { withTimezone: true }), ...audit,
});

/* ───────────────────────────── ops: timers, events, integrations ───────────────────────────── */
/** JobScheduler seam storage: schedule(at,key,payload) / cancel(key) / onFire. Authoritative for every timer. */
export const job = ops.table("job", {
  id: pk(), siteId: siteRef(), key: text("key").notNull(), kind: text("kind").notNull(), payload: jsonb("payload").notNull(),
  dueAt: timestamp("due_at", { withTimezone: true }).notNull(), state: jobState("state").notNull().default("SCHEDULED"),
  claimedAt: timestamp("claimed_at", { withTimezone: true }), claimedBy: text("claimed_by"),
  // Lease (ADR-001): set to now()+60s on claim; the sweeper reclaims CLAIMED rows whose lease has passed.
  claimedUntil: timestamp("claimed_until", { withTimezone: true }),
  firedAt: timestamp("fired_at", { withTimezone: true }), attempts: smallint("attempts").notNull().default(0),
  lastError: text("last_error"), ...audit,
}, (t) => [uniqueIndex("job_key_live_uq").on(t.key).where(sql`state IN ('SCHEDULED','CLAIMED')`),
  index("job_due_idx").on(t.state, t.dueAt)]);
/** Ordered change feed for SSE replay (Last-Event-ID) and audit of board changes. */
export const eventLog = ops.table("event_log", {
  seq: bigserial("seq", { mode: "bigint" }).primaryKey(), siteId: site(), entity: text("entity").notNull(),
  entityId: uuid("entity_id").notNull(), entityVersion: integer("entity_version").notNull(), type: text("type").notNull(),
  at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("event_log_site_seq_idx").on(t.siteId, t.seq)]);
export const teamsConversationRef = ops.table("teams_conversation_ref", {
  id: pk(), siteId: siteRef(), adapter: text("adapter").notNull(), // MOCK | AGENTS_SDK
  ref: jsonb("ref").notNull(), purpose: text("purpose").notNull(), ...audit,
});
export const teamsActivity = ops.table("teams_activity", { // mock Teams card store + future real activity ids
  id: pk(), siteId: siteRef(), approvalRequestId: uuid("approval_request_id").references(() => approvalRequest.id, { onDelete: "restrict" }), cardVersion: integer("card_version").notNull(),
  activityId: text("activity_id").notNull(), payload: jsonb("payload").notNull(), ...audit,
});
export const integrationHealth = ops.table("integration_health", {
  adapter: text("adapter").primaryKey(), mode: sourceMode("mode").notNull(), lastSuccessAt: timestamp("last_success_at", { withTimezone: true }),
  lastEventAt: timestamp("last_event_at", { withTimezone: true }), breaker: text("breaker").notNull().default("CLOSED"),
  errorRate5m: doublePrecision("error_rate_5m"), queueDepth: integer("queue_depth"),
});
export const idempotencyRecord = ops.table("idempotency_record", {
  key: text("key").primaryKey(), scope: text("scope").notNull(), responseCode: smallint("response_code").notNull(),
  responseBody: jsonb("response_body"), createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
export const roiEvent = ops.table("roi_event", {
  id: pk(), siteId: siteRef(), metric: text("metric").notNull(), cohort: roiCohort("cohort").notNull(),
  value: doublePrecision("value").notNull(), refEntity: text("ref_entity"), refId: uuid("ref_id"), ...audit,
}, (t) => [index("roi_metric_idx").on(t.siteId, t.metric, t.cohort)]);
/** NFR-05: who/what/when/why on every state change and send. Append-only grant. Hash-only for message content. */
export const auditEvent = ops.table("audit_event", {
  id: bigserial("id", { mode: "bigint" }).primaryKey(), siteId: site(), actor: text("actor").notNull(), action: text("action").notNull(),
  entity: text("entity").notNull(), entityId: text("entity_id").notNull(), fromVersion: integer("from_version"), toVersion: integer("to_version"),
  reason: text("reason"), detail: jsonb("detail"), at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("audit_entity_idx").on(t.entity, t.entityId, t.at)]);

/* ───────────────────────────── demo + simulation (hidden in production) ───────────────────────────── */
export const scenarioClock = ops.table("scenario_clock", {
  siteId: uuid("site_id").primaryKey().references(() => siteT.id, { onDelete: "restrict" }), scenario: text("scenario").notNull(), anchorReal: timestamp("anchor_real", { withTimezone: true }).notNull(),
  anchorScenario: timestamp("anchor_scenario", { withTimezone: true }).notNull(), speed: doublePrecision("speed").notNull().default(1),
  paused: boolean("paused").notNull().default(false),
}); // scenario_now = anchor_scenario + (now - anchor_real) * speed; never applied to carrier timestamps (§8)
export const simRun = ops.table("sim_run", {
  id: pk(), siteId: siteRef(), track: text("track").notNull(), vehicleId: uuid("vehicle_id").references(() => vehicle.id, { onDelete: "restrict" }).notNull(), speed: doublePrecision("speed").notNull(),
  faults: jsonb("faults").notNull(), cursorIdx: integer("cursor_idx").notNull().default(0), state: text("state").notNull(), ...audit,
});

/** TEST-INF-01 evidence: one row per handler execution (duplicates would show here). Append-only. */
export const jobFireLog = ops.table("job_fire_log", {
  id: bigserial("id", { mode: "bigint" }).primaryKey(), jobId: uuid("job_id").notNull(), deploymentId: text("deployment_id").notNull(),
  firedAt: timestamp("fired_at", { withTimezone: true }).notNull().defaultNow(), lateMs: integer("late_ms").notNull(),
  path: text("path").notNull(), // QUEUE | SWEEPER | LOCAL
}, (t) => [index("job_fire_log_job_idx").on(t.jobId)]);
/** Written by each new deployment's first cron tick; queue consumers on other deployments ack without claiming. */
export const runtimeMarker = ops.table("runtime_marker", {
  id: smallint("id").primaryKey(), activeDeploymentId: text("active_deployment_id").notNull(),
  rearmedAt: timestamp("rearmed_at", { withTimezone: true }).notNull(),
});
