import bcrypt from "bcryptjs";
import { randomUUID } from "node:crypto";
import type { Exec } from "@/domain/transition";

export type StaffRole = "DIRECTOR" | "COORDINATOR" | "FRONT_DESK"; // ADR-004 roles only
export type Membership = { siteId: string; role: StaffRole };

/** Constant-ish time: unknown emails still run one bcrypt compare against a hash generated at first use (nothing committed). */
let dummyHash: string | undefined;
const getDummyHash = () => (dummyHash ??= bcrypt.hashSync(randomUUID(), 12));

export async function verifyCredentials(db: Exec, email: string, password: string): Promise<{ id: string } | null> {
  const r = await db.query<{ id: string; display_name: string; password_hash: string; disabled_at: string | null }>(
    "SELECT id, display_name, password_hash, disabled_at FROM ops.app_user WHERE lower(email) = lower($1)", [email]);
  const u = r.rows[0];
  const ok = await bcrypt.compare(password, u?.password_hash ?? getDummyHash());
  if (!u || !ok || u.disabled_at) return null;
  return { id: u.id }; // only the id goes into the session token (ADR-004)
}

/** Roles are re-read from the DB on every request (ADR-004); the session carries only userId. */
export async function getMemberships(db: Exec, userId: string): Promise<Membership[]> {
  const r = await db.query<{ site_id: string; role: StaffRole }>(
    "SELECT m.site_id, m.role FROM ops.site_membership m JOIN ops.app_user u ON u.id = m.user_id WHERE m.user_id = $1 AND u.disabled_at IS NULL",
    [userId]);
  return r.rows.map((x) => ({ siteId: x.site_id, role: x.role }));
}

export class Forbidden extends Error {}

/**
 * No usable session at all: no token, or a token whose user is disabled or deleted. A subclass
 * of {@link Forbidden}, so every existing caller still catches it, and separate from it because
 * the two deserve different answers — "sign in" (401) is not "not your role" (403), and a user
 * who was disabled mid-session must be told the first, not the second.
 */
export class Unauthenticated extends Forbidden {}

export type ActiveUser = { id: string; displayName: string };

/** Every protected page/handler: the token's uid must still be an active (not disabled, not deleted) user in the DB. */
export async function getActiveUser(db: Exec, userId: string | undefined): Promise<ActiveUser | null> {
  if (!userId) return null;
  const r = await db.query<{ id: string; display_name: string }>(
    "SELECT id, display_name FROM ops.app_user WHERE id = $1 AND disabled_at IS NULL", [userId]);
  return r.rows[0] ? { id: r.rows[0].id, displayName: r.rows[0].display_name } : null;
}

export async function requireUser(db: Exec, userId: string | undefined): Promise<ActiveUser> {
  const u = await getActiveUser(db, userId);
  if (!u) throw new Unauthenticated("not signed in or inactive");
  return u;
}

export async function requireSiteRole(db: Exec, userId: string | undefined, siteId: string, roles: StaffRole[]): Promise<Membership> {
  const u = await requireUser(db, userId);
  const m = (await getMemberships(db, u.id)).find((x) => x.siteId === siteId);
  if (!m || !roles.includes(m.role)) throw new Forbidden("role not allowed for this site");
  return m;
}

/**
 * A site id the caller holds no membership at: another site's id, a random id, or an id that
 * matches no row at all. Callers answer all three the same way — a uniform **404** — so a
 * response can never be used to find out which sites exist (BUILD-PLAN §4: another site is a
 * 404, not a 403; the ID-swap skill's "prefer uniform 404" rule).
 */
export class SiteNotFound extends Error {}

/**
 * The site-scoped authorization every id-taking handler runs, in the order the answers differ:
 *  1. no session, or a user who is disabled or deleted → {@link Unauthenticated} (the caller
 *     maps it to 401 on an API, or to sign-in on a page);
 *  2. a site this user is not a member of → {@link SiteNotFound} (404, the same for an id that
 *     exists at another site and an id that exists nowhere);
 *  3. a member whose role is not one the surface allows → {@link Forbidden} (403).
 *
 * Membership is read from the database on this request (ADR-004), never from the token, so a
 * removed membership or a disabled user takes effect immediately. `roles` comes from the one
 * access table (src/auth/access.ts) — the caller passes it in rather than naming roles itself.
 */
export async function requireSiteAccess(
  db: Exec,
  userId: string | undefined,
  siteId: string,
  roles: readonly StaffRole[],
): Promise<Membership> {
  const u = await requireUser(db, userId);
  const m = (await getMemberships(db, u.id)).find((x) => x.siteId === siteId);
  if (!m) throw new SiteNotFound("no membership at that site");
  if (!roles.includes(m.role)) throw new Forbidden("role not allowed for this site");
  return m;
}
