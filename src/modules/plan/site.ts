import { DEMO_SITE_ID } from "@/modules/demo/fixtures/standard";

/**
 * The site this caller's board belongs to: their own membership, or the demo site when the
 * session has no membership at all.
 *
 * The demo is one centre (PRD §18.1), and the board is not a multi-site surface yet: a caller who
 * is a member of several sites gets the first, which is the same resolution the demo reset uses
 * when a request does not name one. The membership-less case is the browser check's synthetic
 * session (src/auth/caller.ts), which has a role and no identity.
 */
export function siteOf(caller: { memberships?: readonly { siteId: string }[] }): string {
  return caller.memberships?.[0]?.siteId ?? DEMO_SITE_ID;
}
