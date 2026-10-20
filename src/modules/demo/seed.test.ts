import { NEED_CATEGORY } from "@/config/equipment";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import type { Db } from "@/db/exec";
import { freshDb, SITE } from "@/test/pglite";
import { PRESERVED_TABLES, RESET_TABLES, SEEDED_TABLES, seedStandardScenario, type SeedResult } from "./seed";
import {
  ALLOWED_COORDS, BOARD_CENSUS, CHILDREN, DATE_EXCEPTION, EXTERNAL_PEOPLE, FAMILIES, RUNS, STOPS, VEHICLES,
  WEEKDAY_RRULE, vehicleIdOf,
} from "./fixtures/standard";
import { VANS } from "@/config/vans";

const env = { APP_DATA_CLASS: "SYNTHETIC", DEMO_MODE: "1", HMAC_PEPPER: "test-pepper", DATA_KEY: "test-data-key" };
// A Tuesday 13:45 local, so "today" is a weekday and the 06:00 rewind is a real rewind.
const NOW = new Date("2026-10-13T17:45:00.000Z");

let pg: PGlite; let db: Db;
let r: SeedResult;
const one = async <T>(sql: string, params: unknown[] = []) =>
  (await db.query<T>(sql, params)).rows[0];
const rows = async <T>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows;

beforeAll(async () => {
  ({ pg, db } = await freshDb());
  r = await seedStandardScenario(db, { now: NOW, siteId: SITE, env });
}, 120_000);

// One PGlite for the file: close it, so the instance is not held for the whole run.
afterAll(async () => { await pg.close(); });

describe("standard scenario seed (PRD §18.1)", () => {
  it("writes the expected number of rows in every table it touches", () => {
    expect(r.counts).toEqual({
      "ops.family_group": 11,
      "ops.child_profile": 12,
      // 50, plus CONFIRM_AVAILABILITY_TO_RECEIVE for each of the nine scenario children (ledger #83).
      "ops.contact_authorization": 59,
      "ops.stop_location": 11,
      "ops.transport_profile": 12,
      "ops.transport_need_item": 13,
      "ops.therapist": 2,
      "ops.therapy_session": 2,
      "ops.provider": 3,
      // Three vans, all of one generic kind (Firia 8:02 PM seed ruling): V1's three layouts,
      // V2's one and V3's two, which is 6 + 5 + 4 + 6 + 4 = 28 positions between them.
      "ops.vehicle": 3,
      "ops.vehicle_layout": 6,
      "ops.layout_position": 28,
      "ops.vehicle_capability_day": 3,
      // One CHECKED setup per van on the board, dated yesterday (the §9 reset contract).
      "ops.attendance_plan": 12,
      "ops.attendance_exception": 1,
      "ops.attendance_day": 12,
      "ops.manifest": 6,
      "ops.trip_leg": 24,
      "ops.manifest_reservation": 18,
      "ops.scenario_clock": 1,
      "ops.event_log": 1,
      "ops.audit_event": 1,
      "identity.child_identity": 12,
      "identity.guardian_contact": 11,
      "identity.external_person_identity": 4,
      "identity.consent_event": 11,
    });
  });

  it("running twice gives identical row counts and the same ids", async () => {
    const ids = await rows<{ child_token: string }>("SELECT child_token FROM ops.child_profile ORDER BY child_token");
    const again = await seedStandardScenario(db, { now: NOW, siteId: SITE, env });
    expect(again.counts).toEqual(r.counts);
    expect(await rows("SELECT child_token FROM ops.child_profile ORDER BY child_token")).toEqual(ids);
    expect(again.serviceDate).toBe(r.serviceDate);
  }, 120_000);

  it("has one attendance row per child today, for the whole twelve-child roster", async () => {
    expect(r.boardRows).toBe(BOARD_CENSUS);
    expect(CHILDREN.length).toBe(BOARD_CENSUS);
    const n = await one<{ n: number }>(
      "SELECT count(*)::int n FROM ops.attendance_day WHERE site_id=$1 AND service_date=$2 AND state='SCHEDULED'",
      [SITE, r.serviceDate]);
    expect(n.n).toBe(BOARD_CENSUS);
    // Nine scenario children, the rest are the census pad.
    expect(CHILDREN.filter((c) => !c.censusPad).length).toBe(9);
  });

  it("carries no surname at all: labels are first name + initial, vault names add the SYN marker (row 31)", async () => {
    for (const c of CHILDREN) {
      expect({ key: c.key, label: c.label }).toEqual({ key: c.key, label: `${c.firstName} ${c.lastInitial}.` });
      expect(c.lastInitial).toMatch(/^[A-Z]$/);
    }
    const labels = await rows<{ display_name: string }>("SELECT display_name FROM ops.child_profile");
    expect(labels.length).toBe(BOARD_CENSUS);
    for (const l of labels) expect(l.display_name).toMatch(/^[A-Z][a-z]+ [A-Z]\.$/);
    // The identity vault is the one place a legal name could hide; it holds an initial too.
    const kids = await rows<{ legal_first_name: string; legal_last_name: string }>(
      "SELECT legal_first_name, legal_last_name FROM identity.child_identity");
    for (const k of kids) {
      expect(k.legal_first_name).toMatch(/^[A-Z][a-z]+$/);
      expect(k.legal_last_name).toMatch(/^[A-Z]\. \(SYN\)$/);
    }
    const adults = await rows<{ legal_name: string }>(`
      SELECT legal_name FROM identity.guardian_contact
      UNION ALL SELECT legal_name FROM identity.external_person_identity`);
    expect(adults.length).toBe(FAMILIES.length + EXTERNAL_PEOPLE.length);
    for (const a of adults) expect(a.legal_name).toMatch(/^[A-Z][a-z]+ [A-Z]\. \(SYN\)$/);
  });

  it("gives every child an AM and a PM leg today; assigned legs are provisional, the pad is scheduled", async () => {
    const byDir = await rows<{ direction: string; n: number }>(
      "SELECT direction, count(*)::int n FROM ops.trip_leg WHERE service_date=$1 GROUP BY direction ORDER BY direction", [r.serviceDate]);
    expect(byDir).toEqual([
      { direction: "AM", n: BOARD_CENSUS },
      { direction: "PM", n: BOARD_CENSUS },
    ]);
    const byState = await rows<{ state: string; n: number }>(
      "SELECT state::text state, count(*)::int n FROM ops.trip_leg GROUP BY state ORDER BY 1");
    // 18 legs are on a run (three vans × three children × two legs); the rest — the children
    // whose family drives them — are scheduled and unassigned.
    expect(byState).toEqual([
      { state: "PROVISIONAL_ASSIGNED", n: 18 },
      { state: "SCHEDULED", n: BOARD_CENSUS * 2 - 18 },
    ]);
    // Every assigned leg holds exactly one reservation, on a position of the right kind.
    const mismatched = await one<{ n: number }>(`
      SELECT count(*)::int n FROM ops.manifest_reservation mr
      JOIN ops.trip_leg l ON l.id = mr.trip_leg_id
      JOIN ops.transport_profile p ON p.child_token = l.child_token
      JOIN ops.layout_position pos ON pos.id = mr.position_id
      WHERE pos.kind <> (CASE WHEN p.mobility = 'WC' THEN 'WC' ELSE 'AMB' END)`);
    expect(mismatched.n).toBe(0);
  });

  it("C2 needs a wheelchair position with L-track securement and a lift, and rides a lift-equipped vehicle", async () => {
    const c2 = await one<{ child_token: string; display_name: string }>(
      "SELECT child_token, display_name FROM ops.child_profile WHERE display_name = 'Noah O.'");
    const p = await one<{ mobility: string; securement: string; wc_length_cm: number; wc_width_cm: number; status: string }>(
      "SELECT mobility, securement, wc_length_cm, wc_width_cm, status FROM ops.transport_profile WHERE child_token=$1", [c2.child_token]);
    expect(p).toMatchObject({ mobility: "WC", securement: "L_TRACK", status: "APPROVED" });
    const needs = await rows<{ category: string; state: string }>(
      "SELECT ni.category, ni.state FROM ops.transport_need_item ni JOIN ops.transport_profile tp ON tp.id = ni.profile_id WHERE tp.child_token=$1 ORDER BY ni.category",
      [c2.child_token]);
    expect(needs).toEqual([
      { category: "EQUIPMENT_DIMENSIONS", state: "APPROVED" },
      { category: "LIFT_OR_RAMP", state: "APPROVED" },
      { category: NEED_CATEGORY.wheelchair, state: "APPROVED" },
    ]);
    const seat = await rows<{ lift_equipped: boolean; lift_required: boolean; securement: string; max_length_cm: number; max_width_cm: number }>(`
      SELECT v.lift_equipped, vl.lift_required, pos.securement, pos.max_length_cm, pos.max_width_cm
      FROM ops.manifest_reservation mr
      JOIN ops.trip_leg l ON l.id = mr.trip_leg_id
      JOIN ops.layout_position pos ON pos.id = mr.position_id
      JOIN ops.vehicle_layout vl ON vl.id = pos.layout_id
      JOIN ops.vehicle v ON v.id = vl.vehicle_id
      WHERE l.child_token = $1`, [c2.child_token]);
    expect(seat.length).toBe(2); // AM and PM
    for (const s of seat) {
      expect(s).toMatchObject({ lift_equipped: true, lift_required: true, securement: "L_TRACK" });
      expect(s.max_length_cm).toBeGreaterThanOrEqual(p.wc_length_cm);
      expect(s.max_width_cm).toBeGreaterThanOrEqual(p.wc_width_cm);
    }
  });

  it("F4 is one phone for two children (AT-06)", async () => {
    const f4 = FAMILIES.find((f) => f.key === "F4")!;
    const contacts = await rows<{ contact_token: string; phone_hmac: string }>(`
      SELECT gc.contact_token, gc.phone_hmac FROM identity.guardian_contact gc
      JOIN ops.family_group fg ON fg.id = gc.family_group_id WHERE fg.display_label = $1`, [f4.label]);
    expect(contacts.length).toBe(1);
    const kids = await rows<{ display_name: string }>(`
      SELECT cp.display_name FROM ops.child_profile cp JOIN ops.family_group fg ON fg.id = cp.family_group_id
      WHERE fg.display_label = $1 ORDER BY cp.display_name`, [f4.label]);
    expect(kids.map((k) => k.display_name)).toEqual(["Ava N.", "Eli N."]);
    // Both children are reachable through that single number, so an inbound text is ambiguous by design.
    const auth = await rows<{ child_token: string }>(
      "SELECT DISTINCT child_token FROM ops.contact_authorization WHERE contact_token=$1 AND scope='RECEIVE_TRANSPORT_UPDATES'",
      [contacts[0].contact_token]);
    expect(auth.length).toBe(2);
    // One shared phone across the fixture set: 27 families, 27 distinct blind indexes.
    const distinct = await one<{ n: number }>("SELECT count(DISTINCT phone_hmac)::int n FROM identity.guardian_contact");
    expect(distinct.n).toBe(FAMILIES.length);
    expect(await one<{ n: number }>("SELECT count(*)::int n FROM identity.guardian_contact WHERE phone_enc LIKE 'v1:%'"))
      .toEqual({ n: FAMILIES.length });
  });

  /**
   * **Every need item is APPROVED** (Firia, 2026-10-17 8:02 PM ET).
   *
   * The seed used to carry one `REPORTED` item — Zoe B.'s portable suction — so VEH-01's
   * "a need nobody approved changes nothing" could be seen on screen. The fresh seed holds only
   * what the six goals need, and a need the day does not plan against is not one of them. The
   * *rule* is unchanged and still tested where it lives (src/domain/plan/needs.ts takes approved
   * categories only, and the planner never sees another kind).
   */
  it("carries no unapproved need item: every one of them is APPROVED", async () => {
    const unapproved = await rows<{ display_name: string; category: string; state: string }>(`
      SELECT cp.display_name, ni.category, ni.state FROM ops.transport_need_item ni
      JOIN ops.transport_profile tp ON tp.id = ni.profile_id
      JOIN ops.child_profile cp ON cp.child_token = tp.child_token
      WHERE ni.state <> 'APPROVED'`);
    expect(unapproved).toEqual([]);
  });

  it("F2 has no authorized receiving adult (AT-13) while still getting transport updates", async () => {
    const c2 = await one<{ child_token: string }>("SELECT child_token FROM ops.child_profile WHERE display_name='Noah O.'");
    const scopes = await rows<{ scope: string }>("SELECT scope::text scope FROM ops.contact_authorization WHERE child_token=$1 ORDER BY 1", [c2.child_token]);
    // F2 may still say when someone will be home (ledger #83), without being a receiver.
    expect(scopes.map((s) => s.scope)).toEqual(["CANCEL_LEG", "CHANGE_PICKUP_INSTRUCTIONS", "CONFIRM_AVAILABILITY_TO_RECEIVE", "RECEIVE_ATTENDANCE_UPDATES", "RECEIVE_TRANSPORT_UPDATES"]);
    const gc = await one<{ can_receive_child: boolean }>(`
      SELECT gc.can_receive_child FROM identity.guardian_contact gc
      JOIN ops.family_group fg ON fg.id = gc.family_group_id WHERE fg.display_label='F2 (Demo)'`);
    expect(gc.can_receive_child).toBe(false);
  });

  it("uses only landmark stops from MOCKS §1, with the center flagged", async () => {
    const stops = await rows<{ label: string; lat: number; lng: number; is_center: boolean }>("SELECT label, lat, lng, is_center FROM ops.stop_location");
    const labels = new Set(STOPS.map((s) => s.label));
    for (const s of stops) {
      expect(labels.has(s.label)).toBe(true);
      expect(ALLOWED_COORDS).toContain(s.lat);
      expect(ALLOWED_COORDS).toContain(s.lng);
    }
    expect(stops.filter((s) => s.is_center).length).toBe(1);
    // C4 and C5 share John Prince Park, one stop row each.
    expect(stops.filter((s) => s.label === "John Prince Park").length).toBe(2);
  });

  it("schedules Mon–Fri plans with exactly one date exception", async () => {
    const plans = await rows<{ rrule: string; n: number }>("SELECT rrule, count(*)::int n FROM ops.attendance_plan GROUP BY rrule");
    expect(plans).toEqual([{ rrule: WEEKDAY_RRULE, n: BOARD_CENSUS }]);
    const exc = await one<{ display_name: string; service_date: string; scope: string }>(`
      SELECT cp.display_name, ae.service_date::text, ae.scope FROM ops.attendance_exception ae
      JOIN ops.child_profile cp ON cp.child_token = ae.child_token`);
    expect(exc.scope).toBe(DATE_EXCEPTION.scope);
    expect(exc.display_name).toBe("Ivy H.");
    expect(exc.service_date > r.serviceDate).toBe(true); // a week out; today's board is untouched
  });

  it("books T1 at 09:30 and T2 in the afternoon, site-local", async () => {
    const s = await rows<{ label: string; local_start: string; child: string }>(`
      SELECT t.display_name label, to_char(ts.starts_at AT TIME ZONE $1, 'HH24:MI') local_start, cp.display_name child
      FROM ops.therapy_session ts JOIN ops.therapist t ON t.id = ts.therapist_id
      JOIN ops.child_profile cp ON cp.child_token = ts.child_token ORDER BY ts.starts_at`, [r.timezone]);
    expect(s).toEqual([
      { label: "Tasha L.", local_start: "09:30", child: "Liam D." },
      { label: "Devon P.", local_start: "14:15", child: "Zoe B." },
    ]);
  });

  it("rewinds the scenario clock to 06:00 site-local today, paused", async () => {
    const c = await one<{ scenario: string; local: string; speed: number; paused: boolean; service_date: string }>(`
      SELECT scenario, to_char(anchor_scenario AT TIME ZONE $1, 'YYYY-MM-DD HH24:MI') local, speed, paused,
             (anchor_scenario AT TIME ZONE $1)::date::text service_date
      FROM ops.scenario_clock WHERE site_id = $2`, [r.timezone, SITE]);
    expect(c).toMatchObject({ scenario: "standard", speed: 1, paused: true, service_date: r.serviceDate });
    expect(c.local).toBe(`${r.serviceDate} 06:00`);
    expect(r.timezone).toBe("America/New_York");
  });

  it("emits SYSTEM_RESET on the change feed and in the audit log", async () => {
    const ev = await rows<{ type: string; seq: string }>("SELECT type, seq::text FROM ops.event_log");
    expect(ev.map((e) => e.type)).toEqual(["SYSTEM_RESET"]);
    expect(ev[0].seq).toBe("1"); // the feed restarts, so SSE Last-Event-ID has a clean slate
    const a = await one<{ actor: string; action: string }>("SELECT actor, action FROM ops.audit_event");
    expect(a).toMatchObject({ actor: "demo:reset", action: "SYSTEM_RESET" });
  });

  it("every seeded row is marked SIMULATED and written by the demo seed (NFR-09)", async () => {
    for (const t of SEEDED_TABLES) {
      const cols = await rows<{ column_name: string }>(
        "SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2 AND column_name IN ('source_mode','created_by')",
        t.split("."));
      if (!cols.some((c) => c.column_name === "source_mode")) continue;
      const bad = await one<{ n: number }>(`SELECT count(*)::int n FROM ${t} WHERE source_mode <> 'SIMULATED'`);
      expect({ [t]: bad.n }).toEqual({ [t]: 0 });
      if (cols.some((c) => c.column_name === "created_by")) {
        const by = await one<{ n: number }>(`SELECT count(*)::int n FROM ${t} WHERE created_by <> 'demo'`);
        expect({ [t]: by.n }).toEqual({ [t]: 0 });
      }
    }
  });

  it("vehicles and layouts match PRD l.1328 / MOCKS §2", async () => {
    const v = await rows<{ label: string; code: string; wc: number; amb: number; lift_equipped: boolean }>(`
      SELECT v.label, vl.code,
             count(*) FILTER (WHERE pos.kind = 'WC')::int wc,
             count(*) FILTER (WHERE pos.kind = 'AMB')::int amb,
             v.lift_equipped
      FROM ops.vehicle v JOIN ops.vehicle_layout vl ON vl.vehicle_id = v.id
      JOIN ops.layout_position pos ON pos.layout_id = vl.id
      GROUP BY v.label, vl.code, v.lift_equipped ORDER BY v.label, vl.code`);
    /*
     * Three vans, and every one of them the same generic kind — lift-equipped, with an
     * all-ambulatory layout and a wheelchair layout (Firia's 8:02 PM ET seed ruling;
     * Vera/Athena/Veri with Firia's sign-off, 2026-10-18 12:13 AM ET). There is no sedan, no
     * reserve and no fourth vehicle: a van that cannot take a chair today is a van whose spot
     * is already used, which is a count the ramp can change.
     */
    expect(v).toEqual([
      { label: "Van 1", code: "0WC/6A", wc: 0, amb: 6, lift_equipped: true },
      { label: "Van 1", code: "1WC/3A", wc: 1, amb: 3, lift_equipped: true },
      { label: "Van 1", code: "2WC/1A", wc: 2, amb: 1, lift_equipped: true },
      { label: "Van 2", code: "1WC/4A", wc: 1, amb: 4, lift_equipped: true },
      { label: "Van 3", code: "0WC/6A", wc: 0, amb: 6, lift_equipped: true },
      { label: "Van 3", code: "1WC/3A", wc: 1, amb: 3, lift_equipped: true },
    ]);
    // Capability is unknown until arrival, every day (MOCKS §2).
    const cap = await rows<{ state: string; n: number }>("SELECT state, count(*)::int n FROM ops.vehicle_capability_day GROUP BY state");
    expect(cap).toEqual([{ state: "UNKNOWN", n: VEHICLES.length }]);
  });

  /**
   * EXACTLY THREE VEHICLES, and they are all the same van — "Firia 8:02 PM seed ruling", with
   * Vera/Athena/Veri's 12:13 AM ET addition that Van 3 is not a weaker vehicle.
   */
  it("seeds exactly three vehicles, all of one generic type, each with a run", async () => {
    const seeded = await rows<{ label: string; lift_equipped: boolean }>(
      "SELECT label, lift_equipped FROM ops.vehicle ORDER BY label",
    );
    expect(seeded).toEqual([
      { label: "Van 1", lift_equipped: true },
      { label: "Van 2", lift_equipped: true },
      { label: "Van 3", lift_equipped: true },
    ]);
    // Slot N is vehicle V<N>, and every one of them is on the road with a run of its own.
    expect(VANS.map((van) => van.vehicleKey)).toEqual(["V1", "V2", "V3"]);
    expect(VANS.every((van) => van.onRoadToday)).toBe(true);
    expect([...RUNS].map((run) => run.vehicleKey).sort()).toEqual(["V1", "V2", "V3"]);
    // One generic van: the same counts for all three, so no van is weaker by construction.
    expect(VANS.map((van) => van.defaultSetup)).toEqual([
      VANS[0].defaultSetup,
      VANS[0].defaultSetup,
      VANS[0].defaultSetup,
    ]);
    expect(VANS[0].defaultSetup.hasLift).toBe(true);
    // And nothing in the fixture is a fourth vehicle or a kind of vehicle.
    expect(VEHICLES).toHaveLength(3);
    expect(JSON.stringify(VEHICLES)).not.toMatch(/sedan|convertible|cent(?:er|re) van|substitute/i);
  });

  /**
   * The reset contract as re-cut on 2026-10-17 6:00 PM ET (Firia/Veri): a fresh day has **no**
   * van setup at all, for today or for any earlier day, and no saved plan.
   *
   * There is no carry-over in the product, so there is none in the seed either: every van is
   * planned on its shared-config defaults and every column says "Using default setup" until the
   * front desk confirms it at the ramp, and the live map stays locked until a plan is saved.
   */
  it("starts the day with no van setup and no plan, for any date", async () => {
    const setups = await rows<{ n: number }>("SELECT count(*)::int AS n FROM ops.vehicle_setup_day");
    expect(setups).toEqual([{ n: 0 }]);
    const counts = await one<{ setups_today: number; runs: number; assignments: number }>(`
      SELECT (SELECT count(*)::int FROM ops.vehicle_setup_day WHERE service_date = $1::date) AS setups_today,
             (SELECT count(*)::int FROM ops.plan_run) AS runs,
             (SELECT count(*)::int FROM ops.plan_assignment) AS assignments`, [r.serviceDate]);
    expect(counts).toEqual({ setups_today: 0, runs: 0, assignments: 0 });
  });

  it("keeps permanent test opt-outs and clears everything else a reset owns", async () => {
    const contact = await one<{ contact_token: string; site_id: string }>("SELECT contact_token, site_id FROM identity.guardian_contact LIMIT 1");
    await db.query(
      `INSERT INTO identity.consent_event (id, site_id, contact_token, kind, channel, source_mode)
       VALUES ('01900000-0000-7000-8000-00000000ff01', $1, $2, 'PERMANENT_TEST_OPT_OUT', 'SMS_1TO1', 'SIMULATED'),
              ('01900000-0000-7000-8000-00000000ff02', $1, $2, 'STOP', 'SMS_1TO1', 'SIMULATED')`,
      [contact.site_id, contact.contact_token]);
    await db.query(
      `INSERT INTO ops.suppression (id, site_id, contact_token, scope, permanent_test, consent_event_id, created_by, updated_by)
       VALUES ('01900000-0000-7000-8000-00000000ff03', $1, $2, 'ALL', true, '01900000-0000-7000-8000-00000000ff01', 'test', 'test'),
              ('01900000-0000-7000-8000-00000000ff04', $1, $2, 'ALL_NON_SAFETY', false, '01900000-0000-7000-8000-00000000ff02', 'test', 'test')`,
      [contact.site_id, contact.contact_token]);
    // A stale job and a stale message must not survive the reset.
    await db.query(
      `INSERT INTO ops.job (id, site_id, key, kind, payload, due_at, created_by, updated_by)
       VALUES ('01900000-0000-7000-8000-00000000ff05', $1, 'stale', 'noop', '{}', now(), 'test', 'test')`, [contact.site_id]);

    const after = await seedStandardScenario(db, { now: NOW, siteId: SITE, env });
    // Identical everywhere except the consent ledger, which keeps the one permanent opt-out on top of the 27 OPT_INs.
    expect(after.counts).toEqual({ ...r.counts, "identity.consent_event": BOARD_CENSUS });
    const supp = await rows<{ scope: string; permanent_test: boolean }>("SELECT scope, permanent_test FROM ops.suppression");
    expect(supp).toEqual([{ scope: "ALL", permanent_test: true }]);
    const consent = await rows<{ kind: string; n: number }>("SELECT kind, count(*)::int n FROM identity.consent_event GROUP BY kind ORDER BY kind");
    expect(consent).toEqual([
      { kind: "OPT_IN", n: BOARD_CENSUS - 1 },
      { kind: "PERMANENT_TEST_OPT_OUT", n: 1 },
    ]);
    expect(await one<{ n: number }>("SELECT count(*)::int n FROM ops.job")).toEqual({ n: 0 });
  }, 120_000);

  it("accounts for every identity/ops table: either reset or deliberately preserved", async () => {
    const live = await rows<{ t: string }>(`
      SELECT table_schema || '.' || table_name AS t FROM information_schema.tables
      WHERE table_schema IN ('identity','ops') AND table_type = 'BASE TABLE' ORDER BY 1`);
    const known = new Set<string>([...RESET_TABLES, ...PRESERVED_TABLES]);
    expect(live.map((x) => x.t).filter((t) => !known.has(t))).toEqual([]);
    // And nothing is in both lists.
    expect([...RESET_TABLES].filter((t) => (PRESERVED_TABLES as readonly string[]).includes(t))).toEqual([]);
    expect(known.size).toBe(live.length);
  });

  it("refuses an unknown site and leaves the data alone", async () => {
    await expect(seedStandardScenario(db, { now: NOW, siteId: "01900000-0000-7000-8000-00000000dead", env }))
      .rejects.toThrow(/unknown site/);
    expect(await one<{ n: number }>("SELECT count(*)::int n FROM ops.child_profile")).toEqual({ n: BOARD_CENSUS });
  });
});
