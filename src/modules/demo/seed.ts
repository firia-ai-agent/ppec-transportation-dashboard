/**
 * Standard-scenario seed (PRD §18.1 l.1330, MOCKS-AND-DEMO §6 "Reset & seed", ADR-014).
 *
 * seedStandardScenario() does the whole reset in ONE transaction: truncate the demo/ops data,
 * reload the §18.1 fixtures, rewind the scenario clock to 06:00 site-local today, and emit SYSTEM_RESET.
 * It is idempotent: ids are deterministic (fixtures/standard.ts) and every run truncates first, so two
 * runs leave identical row counts.
 *
 * Deliberately NOT reset: ops.org / ops.site (tenancy config), ops.app_user / ops.site_membership (auth),
 * ops.integration_health and ops.runtime_marker (runtime, not scenario data), and — per PRD l.1330 —
 * permanent test opt-outs: suppression rows with permanent_test and the consent events that carry them.
 *
 * Entry points are only POST /api/demo/reset (DIRECTOR, ADR-014 flags) and scripts/demo-reset.ts
 * (--confirm). Never called from a build step; src/modules/demo/build-isolation.test.ts enforces that.
 */
import { createCipheriv, createHash, createHmac, randomBytes } from "node:crypto";
import type { Db, Exec } from "@/db/exec";
import {
  CHILDREN, DATE_EXCEPTION, EXTERNAL_PEOPLE, FAMILIES, KIND, PROVIDERS, RUNS, SCENARIO_NAME,
  SCENARIO_START_LOCAL, STOPS, THERAPISTS, THERAPY_SESSIONS, VEHICLES, WEEKDAY_RRULE,
  DEMO_SITE_ID, childTokenOf, demoId, demoLegId, synLegalLastName, synLegalName, vehicleIdOf,
  type AuthScope, type Child,
} from "./fixtures/standard";


export class SeedRefused extends Error {}

/** Written to created_by / updated_by on every seeded row (schema convention: "demo"). */
const BY = "demo";
const MODE = "SIMULATED";

/* ───────────────────────── tables ───────────────────────── */

/**
 * Cleared by a reset, in one TRUNCATE (so foreign keys do not dictate an order).
 * Every identity/ops table is either here or in PRESERVED_TABLES; a test asserts the two lists
 * cover the live schema, so a new migration cannot quietly add a table the reset forgets.
 */
export const RESET_TABLES = [
  // Approved availability (0015) first: it points at the approval and the change request it came from.
  "ops.availability",
  "ops.teams_activity", "ops.approval_request", "ops.task", "ops.acknowledgment", "ops.outbound_message",
  "ops.change_request", "ops.message", "ops.conversation_thread", "ops.teams_conversation_ref",
  "ops.agent_tool_call", "ops.agent_run", "ops.agent_memory",
  "ops.eta_estimate", "ops.telemetry_point", "ops.device_binding", "ops.device",
  "ops.manifest_reservation", "ops.trip_leg", "ops.manifest",
  // The plan board's three tables (migration 0009). A reset clears every saved plan and every
  // van setup and writes none back — the §9 reset contract as re-cut on 2026-10-17 6:00 PM ET: a
  // fresh day reads "Using default setup" on every van, no plan is saved, and the live map stays
  // locked until one is.
  "ops.plan_assignment", "ops.plan_run", "ops.vehicle_setup_day",
  "ops.vehicle_capability_day", "ops.layout_position", "ops.vehicle_layout", "ops.vehicle",
  "ops.dispatcher_link", "ops.provider",
  "ops.attendance_event", "ops.attendance_day", "ops.attendance_exception", "ops.attendance_plan",
  "ops.therapy_session", "ops.therapist",
  "ops.transport_need_item", "ops.transport_profile", "ops.stop_location", "ops.contact_authorization",
  "ops.child_profile", "ops.family_group",
  "ops.sim_run", "ops.scenario_clock", "ops.job_fire_log", "ops.job", "ops.event_log", "ops.audit_event",
  "ops.roi_event", "ops.idempotency_record",
  "identity.child_identity", "identity.guardian_contact", "identity.external_person_identity",
] as const;

/** Never truncated by a reset. `suppression` and `consent_event` are pruned instead (permanent opt-outs stay). */
export const PRESERVED_TABLES = [
  "ops.org", "ops.site", "ops.app_user", "ops.site_membership",
  "ops.integration_health", "ops.runtime_marker",
  "ops.suppression", "identity.consent_event",
  // Staff feedback is about the app, not the day: Restart demo day keeps it (ledger #82).
  "ops.feedback",
] as const;

/** Tables the seed writes rows into; the reset reports a count for each. */
export const SEEDED_TABLES = [
  "ops.family_group", "ops.child_profile", "ops.contact_authorization", "ops.stop_location",
  "ops.transport_profile", "ops.transport_need_item", "ops.therapist", "ops.therapy_session",
  "ops.provider", "ops.vehicle", "ops.vehicle_layout", "ops.layout_position", "ops.vehicle_capability_day",
  "ops.attendance_plan", "ops.attendance_exception", "ops.attendance_day",
  "ops.manifest", "ops.trip_leg", "ops.manifest_reservation", "ops.scenario_clock",
  "ops.event_log", "ops.audit_event",
  "identity.child_identity", "identity.guardian_contact", "identity.external_person_identity",
  "identity.consent_event",
] as const;

const IDENT = /^[a-z_]+\.[a-z_]+$/;
const table = (t: string) => {
  if (!IDENT.test(t)) throw new SeedRefused(`bad table name: ${t}`);
  return t;
};

/* ───────────────────────── identity sealing (interim, see PR body / B-07) ───────────────────────── */

/**
 * B-07 (IdentityGateway) owns the real AES-GCM + HMAC implementation; it does not exist yet, so the seed
 * seals its own synthetic phones here with the documented P1 scheme (DATA-MODEL §1): an HMAC-SHA256 blind
 * index for inbound resolution and AES-256-GCM ciphertext for the stored value. Keys come from the
 * environment; synthetic fallbacks keep local runs and tests working (the data is fiction either way).
 */
const phoneHmac = (pepper: string, e164: string) => createHmac("sha256", pepper).update(e164).digest("hex");
const sealPhone = (key: string, e164: string) => {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", createHash("sha256").update(key).digest(), iv);
  const ct = Buffer.concat([c.update(e164, "utf8"), c.final()]);
  return `v1:${iv.toString("base64url")}:${c.getAuthTag().toString("base64url")}:${ct.toString("base64url")}`;
};

/* ───────────────────────── insert helper ───────────────────────── */

const CHUNK = 400;

async function insert(tx: Exec, t: string, cols: string[], rows: unknown[][]): Promise<number> {
  const name = table(t);
  for (let i = 0; i < rows.length; i += CHUNK) {
    const batch = rows.slice(i, i + CHUNK);
    const values = batch
      .map((r, ri) => `(${r.map((_, ci) => `$${ri * cols.length + ci + 1}`).join(",")})`)
      .join(",");
    await tx.query(`INSERT INTO ${name} (${cols.join(",")}) VALUES ${values}`, batch.flat());
  }
  return rows.length;
}

/* ───────────────────────── ids ───────────────────────── */

const idx = <T extends { key: string }>(xs: readonly T[], key: string) => {
  const i = xs.findIndex((x) => x.key === key);
  if (i < 0) throw new SeedRefused(`unknown fixture key ${key}`);
  return i;
};

const familyId = (key: string) => demoId(KIND.family, idx(FAMILIES, key) + 1);
const contactId = (familyKey: string) => demoId(KIND.contact, idx(FAMILIES, familyKey) + 1);
const childId = childTokenOf;
const profileId = (key: string) => demoId(KIND.profile, idx(CHILDREN, key) + 1);
const personId = (key: string) => demoId(KIND.person, idx(EXTERNAL_PEOPLE, key) + 1);
const therapistId = (key: string) => demoId(KIND.therapist, idx(THERAPISTS, key) + 1);
const providerId = (key: string) => demoId(KIND.provider, idx(PROVIDERS, key) + 1);
// The two ids the plan board also has to build, so there is one formula and not two
// (fixtures/standard.ts; the board reads a plan back by these ids).
const vehicleId = vehicleIdOf;
/** Child landmark stop; the center and the fault-detour stop sit above the per-child range. */
const stopId = (childKey: string) => demoId(KIND.stop, idx(CHILDREN, childKey) + 1);
const CENTER_STOP_ID = demoId(KIND.stop, 0xc0);
const SPARE_STOP_ID = demoId(KIND.stop, 0xc1);
const legId = demoLegId;
const manifestId = (runKey: string, dir: "AM" | "PM") => demoId(KIND.manifest, idx(RUNS, runKey) * 2 + (dir === "AM" ? 1 : 2));

type LayoutRef = { id: string; code: string; vehicleKey: string; positions: { id: string; kind: "WC" | "AMB" }[] };

/** Layout and position ids, numbered in fixture order so they are stable across resets. */
function layoutRefs(): LayoutRef[] {
  const out: LayoutRef[] = [];
  let layoutN = 0; let posN = 0;
  for (const v of VEHICLES) {
    for (const l of v.layouts) {
      const id = demoId(KIND.layout, ++layoutN);
      out.push({ id, code: l.code, vehicleKey: v.key, positions: l.positions.map((p) => ({ id: demoId(KIND.position, ++posN), kind: p.kind })) });
    }
  }
  return out;
}

/* ───────────────────────── time ───────────────────────── */

type Clock = { tz: string; serviceDate: string; planFrom: string; exceptionDate: string; at: (hhmm: string) => Date };

/** One round trip for every date and local time the fixtures need; Postgres does the DST-correct math. */
async function clockFor(tx: Exec, siteId: string, now: Date): Promise<Clock> {
  const site = await tx.query<{ timezone: string }>("SELECT timezone FROM ops.site WHERE id = $1", [siteId]);
  if (!site.rows[0]) throw new SeedRefused("unknown site");
  const tz = site.rows[0].timezone;
  const d = await tx.query<{ service_date: string; plan_from: string; exception_date: string }>(
    `SELECT (($1::timestamptz AT TIME ZONE $2)::date)::text AS service_date,
            (($1::timestamptz AT TIME ZONE $2)::date - 30)::text AS plan_from,
            (($1::timestamptz AT TIME ZONE $2)::date + $3::int)::text AS exception_date`,
    [now.toISOString(), tz, DATE_EXCEPTION.daysFromToday],
  );
  const { service_date: serviceDate, plan_from: planFrom, exception_date: exceptionDate } = d.rows[0];
  const wanted = [...new Set([
    SCENARIO_START_LOCAL,
    ...CHILDREN.flatMap((c) => [c.amWindow, c.pmWindow]),
    ...THERAPY_SESSIONS.flatMap((s) => [s.start, s.end]),
  ])];
  const t = await tx.query<{ hhmm: string; ts: Date | string }>(
    `SELECT v.hhmm, ($1::date + v.hhmm::time) AT TIME ZONE $2 AS ts
     FROM (VALUES ${wanted.map((_, i) => `($${i + 3}::text)`).join(",")}) AS v(hhmm)`,
    [serviceDate, tz, ...wanted],
  );
  const map = new Map(t.rows.map((r) => [r.hhmm, new Date(r.ts)]));
  return {
    tz, serviceDate, planFrom, exceptionDate,
    at: (hhmm) => {
      const v = map.get(hhmm);
      if (!v) throw new SeedRefused(`no local time for ${hhmm}`);
      return v;
    },
  };
}

/* ───────────────────────── seed ───────────────────────── */

export type SeedOptions = {
  now: Date;
  siteId?: string;
  /** Defaults to HMAC_PEPPER / DATA_KEY; synthetic constants when unset (ADR-015: fiction either way). */
  env?: Record<string, string | undefined>;
};

export type SeedResult = {
  scenario: string; siteId: string; timezone: string; serviceDate: string; scenarioNow: string;
  boardRows: number; counts: Record<string, number>;
};

/**
 * Site used when the caller does not name one: the synthetic demo site from src/auth/seed.ts.
 *
 * The id itself is in the fixtures (`DEMO_SITE_ID`), so a surface that needs it does not have to
 * import this module to get it — importing the seed is what build-isolation.test.ts bars.
 */
export const DEFAULT_DEMO_SITE = DEMO_SITE_ID;

export async function seedStandardScenario(db: Db, opts: SeedOptions): Promise<SeedResult> {
  const siteId = opts.siteId ?? DEFAULT_DEMO_SITE;
  const env = opts.env ?? process.env;
  const pepper = env.HMAC_PEPPER || "SYN-DEMO-PEPPER";
  const dataKey = env.DATA_KEY || "SYN-DEMO-DATA-KEY";
  const now = opts.now;
  const contactValidFrom = new Date(now.getTime() - 24 * 3600_000);

  return db.tx(async (tx) => {
    const clock = await clockFor(tx, siteId, now);
    const scenarioNow = clock.at(SCENARIO_START_LOCAL);

    // 1. Clear the demo/ops data. RESTART IDENTITY so event_log.seq (the SSE event id) starts over.
    await tx.query(`TRUNCATE TABLE ${RESET_TABLES.map(table).join(", ")} RESTART IDENTITY`, []);
    // Suppression and the consent ledger keep permanent test opt-outs only (PRD l.1330).
    await tx.query("DELETE FROM ops.suppression WHERE site_id = $1 AND permanent_test = false", [siteId]);
    await tx.query("DELETE FROM identity.consent_event WHERE site_id = $1 AND kind <> 'PERMANENT_TEST_OPT_OUT'", [siteId]);

    const layouts = layoutRefs();
    const audit = [BY, BY, MODE];

    // 2. Families, children, contacts, consent, authorizations.
    await insert(tx, "ops.family_group", ["id", "site_id", "display_label", "created_by", "updated_by", "source_mode"],
      FAMILIES.map((f) => [familyId(f.key), siteId, f.label, ...audit]));

    await insert(tx, "ops.child_profile", ["child_token", "site_id", "family_group_id", "display_name", "created_by", "updated_by", "source_mode"],
      CHILDREN.map((c) => [childId(c.key), siteId, familyId(c.familyKey), c.label, ...audit]));

    await insert(tx, "identity.child_identity",
      ["child_token", "site_id", "external_ehr_id", "legal_first_name", "legal_last_name", "dob", "created_by", "updated_by", "source_mode"],
      // No surname exists even here (row 31): the vault holds the last initial plus the SYN marker,
      // so "Mia R. (SYN)" is the strongest name any identity read can return.
      CHILDREN.map((c) => [childId(c.key), siteId, `SYN-EHR-${c.key}`, c.firstName, synLegalLastName(c.lastInitial), c.dob, ...audit]));

    const scopesOfFamily = (familyKey: string): AuthScope[] =>
      [...new Set(CHILDREN.filter((c) => c.familyKey === familyKey).flatMap((c) => c.scopes))];
    await insert(tx, "identity.guardian_contact",
      ["contact_token", "site_id", "family_group_id", "legal_name", "phone_hmac", "phone_enc", "relationship",
        "can_receive_updates", "can_request_changes", "can_receive_child", "is_emergency", "valid_from",
        "created_by", "updated_by", "source_mode"],
      FAMILIES.map((f) => {
        const s = scopesOfFamily(f.key);
        return [contactId(f.key), siteId, familyId(f.key), synLegalName(f.guardian.firstName, f.guardian.lastInitial),
          phoneHmac(pepper, f.guardian.phone), sealPhone(dataKey, f.guardian.phone), f.guardian.relationship,
          s.includes("RECEIVE_TRANSPORT_UPDATES") || s.includes("RECEIVE_ATTENDANCE_UPDATES"),
          s.includes("CANCEL_LEG") || s.includes("CHANGE_PICKUP_INSTRUCTIONS"),
          s.includes("RECEIVE_CHILD"), true, contactValidFrom, ...audit];
      }));

    await insert(tx, "identity.consent_event", ["id", "site_id", "contact_token", "kind", "channel", "at", "source_mode"],
      FAMILIES.map((f, i) => [demoId(KIND.consent, i + 1), siteId, contactId(f.key), "OPT_IN", "SMS_1TO1", contactValidFrom, MODE]));

    let authN = 0;
    await insert(tx, "ops.contact_authorization",
      ["id", "site_id", "contact_token", "child_token", "scope", "channel", "valid_from", "created_by", "updated_by", "source_mode"],
      CHILDREN.flatMap((c) => c.scopes.map((s) =>
        [demoId(KIND.auth, ++authN), siteId, contactId(c.familyKey), childId(c.key), s, "SMS_1TO1", contactValidFrom, ...audit])));

    // 3. Stops: the MOCKS §1 landmarks, the center, and the fault-scenario detour target.
    const stopRows: unknown[][] = CHILDREN.filter((c) => c.stopKey).map((c) => {
      const s = STOPS.find((x) => x.key === c.stopKey)!;
      return [stopId(c.key), siteId, s.label, s.lat, s.lng, childId(c.key), false, ...audit];
    });
    const center = STOPS.find((s) => s.key === "CENTER")!;
    const spare = STOPS.find((s) => s.key === "SPARE")!;
    stopRows.push([CENTER_STOP_ID, siteId, center.label, center.lat, center.lng, null, true, ...audit]);
    stopRows.push([SPARE_STOP_ID, siteId, spare.label, spare.lat, spare.lng, null, false, ...audit]);
    await insert(tx, "ops.stop_location",
      ["id", "site_id", "label", "lat", "lng", "child_token", "is_center", "created_by", "updated_by", "source_mode"], stopRows);

    // 4. Approved transport profiles + need items (one APPROVED profile per child, PRD §6.1).
    await insert(tx, "ops.transport_profile",
      ["id", "site_id", "child_token", "profile_version", "status", "mobility", "wc_length_cm", "wc_width_cm",
        "securement", "tether", "escort_required", "max_ride_minutes", "approved_at", "created_by", "updated_by", "source_mode"],
      // approved_by stays NULL: the fixture is pre-approved by the seed, not by a staff user.
      CHILDREN.map((c) => [profileId(c.key), siteId, childId(c.key), 1, "APPROVED", c.mobility,
        c.wcLengthCm ?? null, c.wcWidthCm ?? null, c.securement ?? null, c.tether ?? false,
        c.escortRequired ?? false, c.maxRideMinutes ?? null, now, ...audit]));

    let needN = 0;
    await insert(tx, "ops.transport_need_item",
      ["id", "site_id", "profile_id", "category", "value", "state", "evidence_ref", "created_by", "updated_by", "source_mode"],
      CHILDREN.flatMap((c) => c.needs.map((n) =>
        [demoId(KIND.need, ++needN), siteId, profileId(c.key), n.category, JSON.stringify(n.value), n.state, n.evidenceRef ?? null, ...audit])));

    // 5. Therapists and today's appointments (PRD l.1327: T1 09:30, T2 PM).
    await insert(tx, "identity.external_person_identity",
      ["person_token", "site_id", "kind", "legal_name", "phone_hmac", "phone_enc", "created_by", "updated_by", "source_mode"],
      EXTERNAL_PEOPLE.map((p) => [personId(p.key), siteId, p.kind, synLegalName(p.firstName, p.lastInitial),
        phoneHmac(pepper, p.phone), sealPhone(dataKey, p.phone), ...audit]));
    await insert(tx, "ops.therapist", ["id", "site_id", "person_token", "display_name", "created_by", "updated_by", "source_mode"],
      THERAPISTS.map((t) => [therapistId(t.key), siteId, personId(t.personKey), t.label, ...audit]));
    await insert(tx, "ops.therapy_session",
      ["id", "site_id", "therapist_id", "child_token", "starts_at", "ends_at", "status", "created_by", "updated_by", "source_mode"],
      THERAPY_SESSIONS.map((s, i) => [demoId(KIND.session, i + 1), siteId, therapistId(s.therapistKey), childId(s.childKey),
        clock.at(s.start), clock.at(s.end), "SCHEDULED", ...audit]));

    // 6. Providers, vehicles, layouts, positions; capability starts UNKNOWN each day (MOCKS §2).
    await insert(tx, "ops.provider",
      ["id", "site_id", "name", "dispatch_ownership", "dispatcher_person_token", "created_by", "updated_by", "source_mode"],
      PROVIDERS.map((p) => [providerId(p.key), siteId, p.name, p.dispatchOwnership, p.dispatcher ? personId(p.dispatcher) : null, ...audit]));
    await insert(tx, "ops.vehicle", ["id", "site_id", "provider_id", "label", "lift_equipped", "created_by", "updated_by", "source_mode"],
      VEHICLES.map((v) => [vehicleId(v.key), siteId, providerId(v.providerKey), v.label, v.liftEquipped, ...audit]));
    await insert(tx, "ops.vehicle_layout", ["id", "site_id", "vehicle_id", "code", "lift_required", "created_by", "updated_by", "source_mode"],
      VEHICLES.flatMap((v) => v.layouts.map((l) =>
        [layouts.find((x) => x.vehicleKey === v.key && x.code === l.code)!.id, siteId, vehicleId(v.key), l.code, l.liftRequired, ...audit])));
    await insert(tx, "ops.layout_position",
      ["id", "site_id", "layout_id", "kind", "securement", "max_length_cm", "max_width_cm", "tether_capable", "created_by", "updated_by", "source_mode"],
      VEHICLES.flatMap((v) => v.layouts.flatMap((l) => {
        const ref = layouts.find((x) => x.vehicleKey === v.key && x.code === l.code)!;
        return l.positions.map((p, i) => [ref.positions[i].id, siteId, ref.id, p.kind, p.securement ?? null,
          p.maxLengthCm ?? null, p.maxWidthCm ?? null, p.tetherCapable, ...audit]);
      })));
    await insert(tx, "ops.vehicle_capability_day",
      ["id", "site_id", "vehicle_id", "service_date", "state", "created_by", "updated_by", "source_mode"],
      VEHICLES.map((v, i) => [demoId(KIND.capability, i + 1), siteId, vehicleId(v.key), clock.serviceDate, "UNKNOWN", ...audit]));

    // 6b. **No** `ops.vehicle_setup_day` row is written, for yesterday or for today.
    //     Firia/Veri, 2026-10-17 6:00 PM ET: an unconfirmed van is planned on its DEFAULT counts
    //     from the shared config (src/config/vans.ts) and there is no carry-over of any kind, so
    //     a seeded "yesterday was checked" row would be a fact the product does not have. A fresh
    //     day therefore reads the way the demo is walked: every van column says "Using default
    //     setup", nothing is confirmed until the front desk confirms it on the ramp, and no plan
    //     exists, so the live map stays locked until one is saved (§9.1).

    // 7. Mon–Fri plans, the single date exception, and today's attendance row per child.
    await insert(tx, "ops.attendance_plan",
      ["id", "site_id", "child_token", "rrule", "am_mode", "pm_mode", "am_window_start", "pm_window_start",
        "valid_from", "created_by", "updated_by", "source_mode"],
      CHILDREN.map((c, i) => [demoId(KIND.plan, i + 1), siteId, childId(c.key), WEEKDAY_RRULE, c.amMode, c.pmMode,
        c.amWindow, c.pmWindow, clock.planFrom, ...audit]));
    await insert(tx, "ops.attendance_exception",
      ["id", "site_id", "child_token", "service_date", "scope", "reason", "created_by", "updated_by", "source_mode"],
      [[demoId(KIND.exception, 1), siteId, childId(DATE_EXCEPTION.childKey), clock.exceptionDate,
        DATE_EXCEPTION.scope, DATE_EXCEPTION.reason, ...audit]]);
    await insert(tx, "ops.attendance_day",
      ["id", "site_id", "child_token", "service_date", "state", "created_by", "updated_by", "source_mode"],
      CHILDREN.map((c, i) => [demoId(KIND.attendanceDay, i + 1), siteId, childId(c.key), clock.serviceDate, "SCHEDULED", ...audit]));

    // 8. Today's manifests, legs and reservations. At 06:00 the roster is provisional and capability is
    //    UNKNOWN (PRD §9 "Provisional (T−24h): PROVISIONAL_ASSIGNED, capability UNKNOWN").
    const dirs = ["AM", "PM"] as const;
    await insert(tx, "ops.manifest",
      ["id", "site_id", "service_date", "direction", "provider_id", "vehicle_id", "layout_id", "created_by", "updated_by", "source_mode"],
      RUNS.flatMap((r) => dirs.map((d) => {
        const v = VEHICLES.find((x) => x.key === r.vehicleKey)!;
        return [manifestId(r.key, d), siteId, clock.serviceDate, d, providerId(v.providerKey), vehicleId(v.key),
          layouts.find((x) => x.vehicleKey === v.key && x.code === r.layoutCode)!.id, ...audit];
      })));

    const runOf = (c: Child) => RUNS.find((r) => r.childKeys.includes(c.key));
    const stopSeq = (c: Child, d: "AM" | "PM") => {
      const r = runOf(c);
      if (!r) return null;
      const i = r.childKeys.indexOf(c.key);
      return (d === "AM" ? i : r.childKeys.length - 1 - i) + 1; // PM runs the stops in reverse
    };
    await insert(tx, "ops.trip_leg",
      ["id", "site_id", "child_token", "service_date", "direction", "mode", "state", "manifest_id", "stop_seq",
        "stop_location_id", "window_start", "created_by", "updated_by", "source_mode"],
      CHILDREN.flatMap((c) => dirs.map((d) => {
        const r = runOf(c);
        return [legId(c.key, d), siteId, childId(c.key), clock.serviceDate, d, d === "AM" ? c.amMode : c.pmMode,
          r ? "PROVISIONAL_ASSIGNED" : "SCHEDULED", r ? manifestId(r.key, d) : null, stopSeq(c, d),
          c.stopKey ? stopId(c.key) : null, clock.at(d === "AM" ? c.amWindow : c.pmWindow), ...audit];
      })));

    // One position per reserved leg: wheelchair riders take WC positions, everyone else ambulatory seats.
    const reservations: unknown[][] = [];
    let resN = 0;
    for (const r of RUNS) {
      for (const d of dirs) {
        const ref = layouts.find((x) => x.vehicleKey === r.vehicleKey && x.code === r.layoutCode)!;
        const free = { WC: ref.positions.filter((p) => p.kind === "WC"), AMB: ref.positions.filter((p) => p.kind === "AMB") };
        for (const ck of r.childKeys) {
          const c = CHILDREN.find((x) => x.key === ck)!;
          const pos = free[c.mobility === "WC" ? "WC" : "AMB"].shift();
          if (!pos) throw new SeedRefused(`${r.key} ${r.layoutCode} has no ${c.mobility} position for ${ck}`);
          reservations.push([demoId(KIND.reservation, ++resN), siteId, manifestId(r.key, d), legId(ck, d), "PROVISIONAL", pos.id, ...audit]);
        }
      }
    }
    await insert(tx, "ops.manifest_reservation",
      ["id", "site_id", "manifest_id", "trip_leg_id", "state", "position_id", "created_by", "updated_by", "source_mode"], reservations);

    /*
     * 8b. THE DAY'S ONE PROPOSAL IS NOT WRITTEN HERE ANY MORE (Firia, 2026-10-18 11:04 AM ET).
     *
     *     It used to be: `seedDemoChangeRequest` wrote the row in this transaction, with the fixed
     *     `dropoff.changed` sentence on it. That sentence is the founder's complaint — it answers a
     *     question Dara did not ask — and the fix is that the **model** writes the reply. A model
     *     call cannot be in here: this is the reset's own transaction, and Restart must finish on
     *     time whatever the vendor is doing.
     *
     *     So the drafting is a step of its own, after the commit, with its own timeout and its own
     *     fallback: `demo/draft-proposal.ts`, run by the reset route and again on the first Family
     *     texts load, idempotent on the demo's one approval id so the day has exactly one card.
     *     `ops.approval_request` is still in `RESET_TABLES`, so the row a previous day left is
     *     truncated here and the drafting step writes the new one.
     */

    // 9. Rewind the scenario clock to 06:00 site-local today (MOCKS §6), paused so the demo starts on cue.
    await insert(tx, "ops.scenario_clock", ["site_id", "scenario", "anchor_real", "anchor_scenario", "speed", "paused"],
      [[siteId, SCENARIO_NAME, now, scenarioNow, 1, true]]);

    // 10. SYSTEM_RESET (PRD l.1330) on the SSE change feed, plus the audit row (NFR-05).
    await insert(tx, "ops.event_log", ["site_id", "entity", "entity_id", "entity_version", "type", "at"],
      [[siteId, "site", siteId, 1, "SYSTEM_RESET", now]]);
    await insert(tx, "ops.audit_event", ["site_id", "actor", "action", "entity", "entity_id", "reason", "detail", "at"],
      [[siteId, `${BY}:reset`, "SYSTEM_RESET", "site", siteId, `scenario ${SCENARIO_NAME}`,
        JSON.stringify({ scenario: SCENARIO_NAME, serviceDate: clock.serviceDate, scenarioNow: scenarioNow.toISOString() }), now]]);

    // 11. Counts, read back from the database so the response describes what is actually there.
    const counts: Record<string, number> = {};
    const q = await tx.query<Record<string, number>>(
      `SELECT ${SEEDED_TABLES.map((t, i) => `(SELECT count(*) FROM ${table(t)}) AS c${i}`).join(", ")}`, []);
    SEEDED_TABLES.forEach((t, i) => { counts[t] = Number(q.rows[0][`c${i}`]); });
    const board = await tx.query<{ n: number }>(
      "SELECT count(DISTINCT child_token)::int AS n FROM ops.attendance_day WHERE site_id = $1 AND service_date = $2",
      [siteId, clock.serviceDate]);

    return {
      scenario: SCENARIO_NAME, siteId, timezone: clock.tz, serviceDate: clock.serviceDate,
      scenarioNow: scenarioNow.toISOString(), boardRows: board.rows[0].n, counts,
    };
  });
}
