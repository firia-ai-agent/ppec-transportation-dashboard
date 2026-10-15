/** Synthetic messaging fixtures for tests (ADR-015: 555-01xx numbers, SYN names only). Test-only. */
import { uuidv7 } from "uuidv7";
import type { Db } from "@/db/exec";
import { phoneHmac } from "@/modules/identity/phone";
import { SIM_PERSONA_NUMBERS, simPersonaLabel } from "@/modules/messaging/sim-numbers";
import { SITE } from "./pglite";

export const PEPPER = "syn-test-pepper-0123456789abcdef";
export const [F1_NUMBER, F2_NUMBER] = SIM_PERSONA_NUMBERS;
/** A 555-01xx number that belongs to no contact (AT-09 unknown sender). */
export const UNKNOWN_NUMBER = SIM_PERSONA_NUMBERS[7];

export type Persona = { number: string; hmac: string; contactToken: string; familyGroupId: string; childToken: string };

/** One synthetic family: family group, guardian contact keyed by the persona's blind index, child, authorization. */
export async function seedPersona(db: Db, number: string, opts: { canReceiveUpdates?: boolean } = {}): Promise<Persona> {
  const familyGroupId = uuidv7(); const contactToken = uuidv7(); const childToken = uuidv7();
  const hmac = phoneHmac(number, PEPPER);
  await db.query("INSERT INTO ops.family_group (id,site_id,display_label,created_by,updated_by) VALUES ($1,$2,$3,'test','test')",
    [familyGroupId, SITE, `${simPersonaLabel(number) ?? "F?"} (Demo)`]);
  await db.query(
    `INSERT INTO identity.guardian_contact (contact_token,site_id,family_group_id,legal_name,phone_hmac,phone_enc,relationship,
       can_receive_updates,valid_from,created_by,updated_by)
     VALUES ($1,$2,$3,'SYN Guardian',$4,'enc','parent',$5, now() - interval '1 day','test','test')`,
    [contactToken, SITE, familyGroupId, hmac, opts.canReceiveUpdates ?? true]);
  await db.query("INSERT INTO ops.child_profile (child_token,site_id,family_group_id,display_name,created_by,updated_by) VALUES ($1,$2,$3,'Syn C.','test','test')",
    [childToken, SITE, familyGroupId]);
  await db.query(
    `INSERT INTO ops.contact_authorization (id,site_id,contact_token,child_token,scope,channel,valid_from,created_by,updated_by)
     VALUES ($1,$2,$3,$4,'RECEIVE_TRANSPORT_UPDATES','SMS_1TO1', now() - interval '1 day','test','test')`,
    [uuidv7(), SITE, contactToken, childToken]);
  return { number, hmac, contactToken, familyGroupId, childToken };
}

/** A staff user with a membership at SITE, for the session-guarded read API. */
export async function seedStaff(db: Db, role: "DIRECTOR" | "COORDINATOR" | "FRONT_DESK" = "COORDINATOR"): Promise<string> {
  const id = uuidv7();
  await db.query("INSERT INTO ops.app_user (id,email,display_name,password_hash) VALUES ($1,$2,'Syn Staff','x')",
    [id, `syn.staff.${id.slice(0, 8)}@example.com`]);
  await db.query("INSERT INTO ops.site_membership (user_id,site_id,role) VALUES ($1,$2,$3)", [id, SITE, role]);
  return id;
}
