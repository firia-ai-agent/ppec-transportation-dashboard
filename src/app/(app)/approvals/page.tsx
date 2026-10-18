import { permanentRedirect } from "next/navigation";
import { FAMILY_TEXTS_FOR_YOU } from "@/auth/access";
import { requirePage } from "@/auth/page-guard";

/** The guard reads a session, so this route is never statically rendered. */
export const dynamic = "force-dynamic";

/**
 * `/approvals` → `/family-texts?tab=for-you`, permanently (308). REDESIGN-SPEC §9.2 has said
 * what this page is from the start — "Approvals is the For you tab inside Family texts, not a
 * menu item" — and Firia's 8:36 PM ET ruling makes the address say it too, rather than keeping
 * a second screen that is the same queue.
 *
 * The guard runs first, for the reason the sibling redirect spells out
 * (src/app/(app)/exceptions/page.tsx): signed out goes to sign-in and never learns the address
 * exists, and a role that may not decide is answered by this page's own row — `APPROVAL_ROLES`
 * — rather than by the page it would have been sent to. The front desk therefore ends on the
 * live map, their home, and never on "For you".
 */
export default async function Page() {
  await requirePage("/approvals");
  permanentRedirect(FAMILY_TEXTS_FOR_YOU);
}
