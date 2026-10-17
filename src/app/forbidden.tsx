/**
 * The last-resort 403 boundary, for a refusal with no page of its own to name — a signed-in user
 * who holds no membership at any site, whose refusal can happen above a page (in a layout).
 * Every guarded page has its own boundary next to it, which is the one that says who that page
 * is for; access.test.ts holds that.
 *
 * It renders **inside the shell**, like every other screen in the app (Vera's review,
 * 2026-10-17): the founder's walk of production found the refusal page was a dead end — a card,
 * a sentence, and no menu, no header, nothing but the browser's Back button. The shell gives it
 * the menu this person's role carries (none, for the one caller who reaches this boundary) and,
 * more to the point for them, the header's account menu with Sign out in it.
 *
 * A role that *does* have a menu is not sent here at all any more: a typed URL for a page that
 * is not on it lands on their own home with the "Not on your menu" toast (src/auth/page-guard.ts).
 */
import { getCaller } from "@/auth/caller";
import { ConsoleShell } from "@/ui/ConsoleShell";
import { NoAccess } from "@/ui/NoAccess";

export default async function Forbidden() {
  return (
    <ConsoleShell caller={await getCaller()}>
      <NoAccess />
    </ConsoleShell>
  );
}
