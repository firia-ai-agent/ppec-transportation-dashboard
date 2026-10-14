import bcrypt from "bcryptjs";
import type { Exec } from "@/domain/transition";

export type StaffRole = "DIRECTOR" | "COORDINATOR" | "FRONT_DESK" | "PLATFORM_ADMIN";
export type Membership = { siteId: string; role: StaffRole };

/** Constant-ish time: always runs one bcrypt compare, even for unknown emails. */
const DUMMY_HASH = "$2b$12$xfnDFQ2PFbfAgxc6y9ZFlenVzSiUE8KwuSboaRpBjyp2eFaTVonXW"; // hash of a random throwaway string, used only to equalize timing

export async function verifyCredentials(db: Exec, email: string, password: string): Promise<{ id: string; name: string } | null> {
  const r = await db.query<{ id: string; display_name: string; password_hash: string; disabled_at: string | null }>(
    "SELECT id, display_name, password_hash, disabled_at FROM ops.app_user WHERE lower(email) = lower($1)", [email]);
  const u = r.rows[0];
  const ok = await bcrypt.compare(password, u?.password_hash ?? DUMMY_HASH);
  if (!u || !ok || u.disabled_at) return null;
  return { id: u.id, name: u.display_name };
}

/** Roles are re-read from the DB on every request (ADR-004); the session carries only userId. */
export async function getMemberships(db: Exec, userId: string): Promise<Membership[]> {
  const r = await db.query<{ site_id: string; role: StaffRole }>(
    "SELECT m.site_id, m.role FROM ops.site_membership m JOIN ops.app_user u ON u.id = m.user_id WHERE m.user_id = $1 AND u.disabled_at IS NULL",
    [userId]);
  return r.rows.map((x) => ({ siteId: x.site_id, role: x.role }));
}

export class Forbidden extends Error {}

export async function requireSiteRole(db: Exec, userId: string | undefined, siteId: string, roles: StaffRole[]): Promise<Membership> {
  if (!userId) throw new Forbidden("not signed in");
  const m = (await getMemberships(db, userId)).find((x) => x.siteId === siteId);
  if (!m || !roles.includes(m.role)) throw new Forbidden("role not allowed for this site");
  return m;
}
