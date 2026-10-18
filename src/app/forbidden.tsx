/**
 * The last-resort 403 boundary, for a refusal with no page of its own to name — a signed-in user
 * who holds no membership at any site, whose refusal can happen above a page (in a layout).
 * Every guarded page has its own boundary next to it, which is the one that says who that page
 * is for; access.test.ts holds that.
 *
 * It renders the same framed card as every other boundary (src/ui/RefusedPage.tsx), with no
 * page named: the shell gives it the menu this person's role carries (none, for the one caller
 * who reaches this boundary) and, more to the point for them, the header's account menu with
 * Sign out in it. Nothing above this file mounts that frame — src/app/layout.tsx is the
 * document shell, fonts and the DEMO bar — so here it comes from the shared component.
 *
 * A role that *does* have a menu is not sent here at all any more: a typed URL for a page that
 * is not on it lands on their own home with the "Not on your menu" toast (src/auth/page-guard.ts).
 */
import { RefusedPage } from "@/ui/RefusedPage";

export default function Forbidden() {
  return <RefusedPage />;
}
