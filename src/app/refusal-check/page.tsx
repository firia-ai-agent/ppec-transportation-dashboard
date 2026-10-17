/**
 * THE ONE ADDRESS THAT RENDERS THE REFUSAL CARD.
 *
 * "This page isn't part of your role" is a screen in this app that no staff role can reach, by
 * design: §9.3 and the founder's walk of production turned a wrong-role URL into a 307 to that
 * person's own home with the "Not on your menu" toast (src/auth/page-guard.ts), so the card is
 * left for the one caller who has no home to be sent to — someone signed in who holds no
 * membership at any site. Nobody can sign in as that person in a browser check, which left the
 * card as the one screen in the app that could not be *looked at*: Vera found it was a dead end
 * on production, and the fix (a frame around it, src/ui/RefusedPage.tsx) could be asserted from
 * the source and from nowhere else.
 *
 * So this route is the card, for whoever is signed in. It reads nothing, renders nothing and
 * answers 403 to every session: the page body is `forbidden()`, which throws to the boundary
 * above it (src/app/forbidden.tsx — this folder has none of its own, and the card with no page
 * to name is the honest one here). Any role can ask for it and see their own refusal, with
 * their own menu around it, which is what e2e/one-menu.spec.ts measures at 390 and 1440 px.
 *
 * It is not a screen: no row in src/ui/nav-items.ts, so it is on no menu and no role's home,
 * and `requirePage` runs first so a signed-out visitor is sent to sign-in exactly as on every
 * other page rather than being told this address exists.
 */
import { forbidden } from "next/navigation";
import { requirePage } from "@/auth/page-guard";

export const dynamic = "force-dynamic";

export default async function RefusalCheck() {
  // Signed out is sign-in, as on every page in the app; a session is all this one asks for.
  await requirePage("/refusal-check");
  // ...and every session that gets past it is refused. That is the whole page.
  forbidden();
}
