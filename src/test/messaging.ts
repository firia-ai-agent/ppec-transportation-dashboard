/** Synthetic messaging fixtures for tests (ADR-015: 555-01xx numbers, SYN names only). Test-only. */
import { uuidv7 } from "uuidv7";
import type { Db } from "@/db/exec";
import { phoneHmac } from "@/modules/identity/phone";
import { SIM_PERSONA_NUMBERS, simPersonaLabel } from "@/modules/messaging/sim-numbers";
import { fixtureValidFrom, TEST_NOW } from "./clock";
import { ORG, SITE as DEFAULT_SITE } from "./pglite";

export const PEPPER = "syn-test-pepper-0123456789abcdef";
export const [F1_NUMBER, F2_NUMBER] = SIM_PERSONA_NUMBERS;
/** A persona phone for the *other* site, so a cross-site read has something real to ask for. */
export const F3_NUMBER = SIM_PERSONA_NUMBERS[2];
/** A 555-01xx number that belongs to no contact (AT-09 unknown sender). */
export const UNKNOWN_NUMBER = SIM_PERSONA_NUMBERS[7];

/**
 * The second site, with the id the other ID-swap tests use (src/auth/idswap.test.ts,
 * src/modules/demo/reset.test.ts), so "the other site" means the same thing everywhere.
 */
export const SITE_B = "00000000-0000-7000-8000-0000000000b1";

/** The second site in the same org: the "another tenant" half of every site-scoping test. */
export async function seedSecondSite(db: Db, siteId: string = SITE_B): Promise<string> {
  await db.query(
    `INSERT INTO ops.site (id,org_id,name,depot_lat,depot_lng,created_by,updated_by)
     VALUES ($1,$2,'SYN Second Site',26.645352,-80.145541,'test','test')`, [siteId, ORG]);
  return siteId;
}

export type Persona = { number: string; hmac: string; contactToken: string; familyGroupId: string; childToken: string };

/**
 * One synthetic family: family group, guardian contact keyed by the persona's blind index, child,
 * authorization.
 *
 * `now` is the clock the test runs on — the authorization opens a day before it, so a message the
 * test seeds at that clock is inside the window no matter what the real clock says (see
 * `src/test/clock.ts`). A suite that runs on the real clock passes it; everything else gets the
 * pinned `TEST_NOW`.
 */
export async function seedPersona(db: Db, number: string, opts: { canReceiveUpdates?: boolean; siteId?: string; now?: Date } = {}): Promise<Persona> {
  const familyGroupId = uuidv7(); const contactToken = uuidv7(); const childToken = uuidv7();
  const hmac = phoneHmac(number, PEPPER);
  const site = opts.siteId ?? DEFAULT_SITE;
  const validFrom = fixtureValidFrom(opts.now ?? TEST_NOW).toISOString();
  await db.query("INSERT INTO ops.family_group (id,site_id,display_label,created_by,updated_by) VALUES ($1,$2,$3,'test','test')",
    [familyGroupId, site, `${simPersonaLabel(number) ?? "F?"} (Demo)`]);
  await db.query(
    `INSERT INTO identity.guardian_contact (contact_token,site_id,family_group_id,legal_name,phone_hmac,phone_enc,relationship,
       can_receive_updates,valid_from,created_by,updated_by)
     VALUES ($1,$2,$3,'SYN Guardian',$4,'enc','parent',$5,$6,'test','test')`,
    [contactToken, site, familyGroupId, hmac, opts.canReceiveUpdates ?? true, validFrom]);
  await db.query("INSERT INTO ops.child_profile (child_token,site_id,family_group_id,display_name,created_by,updated_by) VALUES ($1,$2,$3,'Syn C.','test','test')",
    [childToken, site, familyGroupId]);
  await db.query(
    `INSERT INTO ops.contact_authorization (id,site_id,contact_token,child_token,scope,channel,valid_from,created_by,updated_by)
     VALUES ($1,$2,$3,$4,'RECEIVE_TRANSPORT_UPDATES','SMS_1TO1',$5,'test','test')`,
    [uuidv7(), site, contactToken, childToken, validFrom]);
  return { number, hmac, contactToken, familyGroupId, childToken };
}

/**
 * A staff user with one membership, at SITE unless another is named, for the session-guarded read
 * API. `siteId: null` gives a real, active, signed-in user who is a member of nowhere.
 */
export async function seedStaff(
  db: Db,
  role: "DIRECTOR" | "COORDINATOR" | "FRONT_DESK" = "COORDINATOR",
  siteId: string | null = DEFAULT_SITE,
): Promise<string> {
  const id = uuidv7();
  await db.query("INSERT INTO ops.app_user (id,email,display_name,password_hash) VALUES ($1,$2,'Syn Staff','x')",
    // The whole id, not a prefix: uuidv7's leading bytes are the clock, so two users seeded in the
    // same millisecond would collide on the unique email.
    [id, `syn.staff.${id}@example.com`]);
  if (siteId) await db.query("INSERT INTO ops.site_membership (user_id,site_id,role) VALUES ($1,$2,$3)", [id, siteId, role]);
  return id;
}
