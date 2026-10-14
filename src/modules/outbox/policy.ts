import type { Exec } from "@/db/exec";

/** Purposes that bypass ALL_NON_SAFETY suppression (PRD §10). Scope ALL still blocks them. */
export const SAFETY_PURPOSES = new Set(["SAFETY_ALERT", "CHILD_NOT_RECEIVED"]);

/** IdentityGateway seam: is this recipient token currently allowed to get this purpose? ops never reads identity directly. */
export interface RecipientAuthorizer {
  authorize(a: { siteId: string; recipientToken: string; purpose: string; at: Date }): Promise<{ ok: true } | { ok: false; reason: string }>;
}

/** Reads identity.guardian_contact. In deployed envs it runs on the identity_gateway connection (0001_roles). */
export function dbRecipientAuthorizer(identityDb: Exec): RecipientAuthorizer {
  return {
    async authorize({ siteId, recipientToken, purpose, at }) {
      const r = await identityDb.query<{ ok_updates: boolean; ok_emergency: boolean }>(
        `SELECT can_receive_updates ok_updates, is_emergency ok_emergency FROM identity.guardian_contact
         WHERE contact_token = $1 AND site_id = $2 AND revoked_at IS NULL
           AND valid_from <= $3 AND (valid_to IS NULL OR valid_to > $3)`, [recipientToken, siteId, at.toISOString()]);
      const c = r.rows[0];
      if (!c) return { ok: false, reason: "recipient not found, revoked, expired or other site" };
      if (c.ok_updates || (SAFETY_PURPOSES.has(purpose) && c.ok_emergency)) return { ok: true };
      return { ok: false, reason: "recipient not authorized for this purpose" };
    },
  };
}

/** Active suppression for this contact and purpose (ops.suppression, written from consent events). */
export async function activeSuppression(db: Exec, a: { siteId: string; recipientToken: string; purpose: string }) {
  const r = await db.query<{ scope: string }>(
    `SELECT scope FROM ops.suppression WHERE site_id = $1 AND contact_token = $2 AND lifted_at IS NULL`, [a.siteId, a.recipientToken]);
  return r.rows.find((s) => s.scope === "ALL" || (s.scope === "ALL_NON_SAFETY" && !SAFETY_PURPOSES.has(a.purpose)))?.scope ?? null;
}
