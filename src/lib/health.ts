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

export function healthPayload(env: Record<string, string | undefined>) {
  return {
    ok: true,
    service: "ppec-transportation-dashboard",
    commit: env.VERCEL_GIT_COMMIT_SHA ?? "local",
    branch: env.VERCEL_GIT_COMMIT_REF ?? null,
    deploymentId: env.VERCEL_DEPLOYMENT_ID ?? null,
    environment: env.VERCEL_ENV ?? "development",
    dataClass: env.APP_DATA_CLASS ?? null,
    dbEndpoint: neonEndpointId(env),
    // Previews share the one production DB and open every session read-only (DECISION-LEDGER #43).
    dbReadOnly: isReadOnlyDbEnv(env),
  };
}
