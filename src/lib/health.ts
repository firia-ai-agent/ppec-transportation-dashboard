import { getNeonDb } from "@/db/exec";
import { isReadOnlyDbEnv } from "@/db/read-only";

/**
 * Non-secret Neon endpoint id (e.g. "ep-abc-123") from DATABASE_URL_UNPOOLED, falling back to DATABASE_URL.
 * Returns only the first host label with any "-pooler" suffix removed, and only if it looks like a Neon endpoint.
 * Never returns the user, password, full host or query string.
 */
export function neonEndpointId(env: Record<string, string | undefined>): string | null {
  const raw = env.DATABASE_URL_UNPOOLED || env.DATABASE_URL;
  if (!raw) return null;
  let host: string;
  try { host = new URL(raw).hostname; } catch { return null; }
  const id = host.split(".")[0].replace(/-pooler$/, "");
  return /^ep-[a-z0-9-]{1,60}$/.test(id) ? id : null;
}

/** The one statement `dbRole` is read with: no table, no catalog lookup, nothing to plan. */
export const DB_ROLE_SQL = "SELECT current_user AS role";

/**
 * The shape a Postgres role name has: letters, digits, `_`, `$` and `-`, up to NAMEDATALEN-1.
 * Anything else is answered as `null` rather than printed, so the probe cannot become a way to
 * read back whatever a connection string, a host or an error message happened to put in that
 * column — the field is a role name or it is nothing.
 */
const ROLE_NAME = /^[A-Za-z0-9_$-]{1,63}$/;

/** `current_user` as a role name, or null for anything that is not one. Pure, so it is testable. */
export function roleNameOf(value: unknown): string | null {
  return typeof value === "string" && ROLE_NAME.test(value) ? value : null;
}

/**
 * Which Postgres role this deployment logs in as (DECISION-LEDGER row 53: Preview is switched to
 * the read-only `ppec_preview`, Production keeps the owner role, and a preview built before the
 * switch keeps its old values until it is redeployed — so the deployment has to be asked).
 *
 * One `SELECT current_user`: no table is touched, so it costs a round trip and nothing else, and
 * it goes through the same autocommit path as every other query (`getNeonDb`), which on a preview
 * wraps it in `BEGIN READ ONLY … COMMIT`. It is a plain SELECT, so the read-only guard passes it.
 *
 * Never throws: health is a deployment probe and must answer even when the database cannot. An
 * unset DATABASE_URL, a refused login, a suspended compute and a timeout all read as `null`.
 */
export async function readDbRole(): Promise<string | null> {
  try {
    const { rows } = await getNeonDb().query<{ role: unknown }>(DB_ROLE_SQL, []);
    return roleNameOf(rows[0]?.role);
  } catch {
    return null;
  }
}

/**
 * The probe's body. Pure: `dbRole` is read by the route (`readDbRole`) and passed in, so every
 * other field stays a function of the environment alone and this stays unit-testable.
 */
export function healthPayload(env: Record<string, string | undefined>, dbRole: string | null = null) {
  return {
    ok: true,
    service: "ppec-transportation-dashboard",
    commit: env.VERCEL_GIT_COMMIT_SHA ?? "local",
    branch: env.VERCEL_GIT_COMMIT_REF ?? null,
    deploymentId: env.VERCEL_DEPLOYMENT_ID ?? null,
    environment: env.VERCEL_ENV ?? "development",
    dataClass: env.APP_DATA_CLASS ?? null,
    dbEndpoint: neonEndpointId(env),
    // Previews share the one production DB and open every transaction READ ONLY (DECISION-LEDGER #43).
    dbReadOnly: isReadOnlyDbEnv(env),
    /*
     * The login role the deployment actually got (ledger row 53), as `SELECT current_user` answers
     * it. A role name only — never the credential, the URL or the host it came from — and `null`
     * when the query could not be made, which is not a failure of the probe.
     */
    dbRole,
  };
}
