import { timingSafeEqual } from "node:crypto";

/**
 * Fail-closed check for cron/sweep routes (TOKOS-REUSE: the old route failed open when CRON_SECRET was unset).
 * Vercel Cron sends `Authorization: Bearer <CRON_SECRET>`; preview harnesses send the same header.
 */
export function cronAuthorized(header: string | null, secret: string | undefined): boolean {
  if (!secret || secret.length < 16 || !header) return false;
  const want = Buffer.from(`Bearer ${secret}`);
  const got = Buffer.from(header);
  return want.length === got.length && timingSafeEqual(want, got);
}
