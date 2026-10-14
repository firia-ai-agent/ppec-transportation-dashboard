import bcrypt from "bcryptjs";
import type { Exec } from "@/domain/transition";

/**
 * Synthetic demo staff (synthetic-seed-data-rules, ADR-004). Passwords come ONLY from env vars,
 * one per role per environment; nothing is hardcoded, printed or returned.
 * Seed declaration: 1 org, 2 sites (A with 3 users, B with none, for ID-swap 404 cases),
 * 3 users director@ / coordinator@ / frontdesk@example.com.
 */
export const DEMO_ORG = "01900000-0000-7000-8000-000000000001";
export const DEMO_SITE_A = "01900000-0000-7000-8000-00000000000a";
export const DEMO_SITE_B = "01900000-0000-7000-8000-00000000000b";
export const DEMO_USERS = [
  { id: "01900000-0000-7000-8000-0000000000d1", email: "director@example.com", name: "SYN Dana Director", role: "DIRECTOR", env: "DEMO_DIRECTOR_PASSWORD" },
  { id: "01900000-0000-7000-8000-0000000000c1", email: "coordinator@example.com", name: "SYN Casey Coordinator", role: "COORDINATOR", env: "DEMO_COORDINATOR_PASSWORD" },
  { id: "01900000-0000-7000-8000-0000000000f1", email: "frontdesk@example.com", name: "SYN Frankie FrontDesk", role: "FRONT_DESK", env: "DEMO_FRONT_DESK_PASSWORD" },
] as const;

export class SeedRefused extends Error {}

export async function seedDemoUsers(db: Exec, env: Record<string, string | undefined>, opts: { dryRun: boolean }) {
  if (env.APP_DATA_CLASS !== "SYNTHETIC") throw new SeedRefused("APP_DATA_CLASS must be SYNTHETIC");
  const missing = DEMO_USERS.filter((u) => !env[u.env] || (env[u.env] as string).length < 16).map((u) => u.env);
  if (missing.length) throw new SeedRefused(`missing or too short (<16 chars): ${missing.join(", ")}`);
  const plan = { org: 1, sites: 2, users: DEMO_USERS.map((u) => `${u.email} (${u.role}, site A)`) };
  if (opts.dryRun) return { dryRun: true, plan };
  const by = "'seed:demo-users'";
  await db.query("BEGIN", []);
  try {
    await db.query(`INSERT INTO ops.org (id, name, created_by, updated_by, source_mode) VALUES ($1, 'SYN PPEC Demo Org', ${by}, ${by}, 'SIMULATED') ON CONFLICT (id) DO NOTHING`, [DEMO_ORG]);
    for (const [id, name] of [[DEMO_SITE_A, "SYN Greenacres Center (2216 Jog Rd area)"], [DEMO_SITE_B, "SYN Second Site (ID-swap tests)"]]) {
      await db.query(`INSERT INTO ops.site (id, org_id, name, depot_lat, depot_lng, created_by, updated_by, source_mode)
        VALUES ($1, $2, $3, 26.645352, -80.145541, ${by}, ${by}, 'SIMULATED') ON CONFLICT (id) DO NOTHING`, [id, DEMO_ORG, name]);
    }
    for (const u of DEMO_USERS) {
      const hash = await bcrypt.hash(env[u.env] as string, 12);
      await db.query(`INSERT INTO ops.app_user (id, email, display_name, password_hash) VALUES ($1, $2, $3, $4)
        ON CONFLICT (id) DO UPDATE SET password_hash = EXCLUDED.password_hash, display_name = EXCLUDED.display_name`, [u.id, u.email, u.name, hash]);
      await db.query(`INSERT INTO ops.site_membership (user_id, site_id, role) VALUES ($1, $2, $3)
        ON CONFLICT (user_id, site_id) DO UPDATE SET role = EXCLUDED.role`, [u.id, DEMO_SITE_A, u.role]);
    }
    await db.query("COMMIT", []);
  } catch (e) {
    await db.query("ROLLBACK", []);
    throw e;
  }
  return { dryRun: false, plan };
}
