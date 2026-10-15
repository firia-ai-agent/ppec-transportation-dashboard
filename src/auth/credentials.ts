import { z } from "zod";
import type { Exec } from "@/domain/transition";
import { verifyCredentials } from "./core";

/**
 * What the Credentials provider accepts as a sign-in attempt, kept out of src/auth.ts so the
 * real authorize path can be tested without loading next-auth (which reaches for next/server).
 *
 * `min(1)`: the length of a password is the deployment's business, not this schema's. The
 * shared demo password is four characters (`DEMO_SHARED_PASSWORD`, founder decision,
 * DECISION-LEDGER row 59) and is accepted as it stands — there is no minimum here to relax,
 * and none should be added, because a floor here would lock out an account the sign-in page
 * itself offers. The ceiling stays: bcrypt only reads the first 72 bytes, and a megabyte of
 * "password" should not reach it.
 */
export const credentialsSchema = z.object({
  email: z.string().email().max(200),
  password: z.string().min(1).max(200),
});

/**
 * The provider's authorize step: shape-check, then one bcrypt compare in `verifyCredentials`
 * (src/auth/core.ts), which is also what makes an unknown email cost the same as a known one.
 * Returns the user id only (ADR-004), or null for anything that did not add up.
 */
export async function authorizeCredentials(db: Exec, raw: unknown): Promise<{ id: string } | null> {
  const parsed = credentialsSchema.safeParse(raw);
  if (!parsed.success) return null;
  return verifyCredentials(db, parsed.data.email, parsed.data.password);
}
