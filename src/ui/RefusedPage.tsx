import { getCaller } from "@/auth/caller";
import { ConsoleShell } from "./ConsoleShell";
import { NoAccess } from "./NoAccess";
import { shellComesFromLayout } from "./refused-frame";

/**
 * THE REFUSAL, INSIDE THE APP FRAME — every `forbidden.tsx` in the app renders this and
 * nothing else.
 *
 * Vera's review, 2026-10-17 4:19 PM ET: "This page isn't part of your role" must never be a
 * bare page whose only exit is the "Go to …" link. A refusal is a screen like any other, so it
 * carries the furniture every screen carries — the page header bar with that screen's title in
 * it, the account block, and the menu this person's own role holds (the bottom tab bar on a
 * phone, the left rail at a desk). One line of the card says where you may go; the frame around
 * it is how you actually go there, and how you reach Sign out when the answer is "this account
 * is wrong" (the account block opens /whoami, where Sign out is).
 *
 * It replaces twelve copies of the same decision with one. Before this, src/app/forbidden.tsx
 * mounted the shell itself and the eleven boundaries beside the pages rendered a bare
 * `<NoAccess />`, which left "does this refusal have a frame?" to be answered once per file —
 * and four of them answered it wrong. Which of the two shapes a boundary needs is
 * `shellComesFromLayout`, read from the access table in ./refused-frame.ts, so no boundary
 * holds shell wiring of its own and none can be framed twice; src/ui/refused-frame.test.ts
 * states that as a property over all twelve, and e2e/one-menu.spec.ts measures the painted
 * frame at 390 and 1440 px on a front-desk session.
 *
 * **Who is refused does not change here.** The access table and `requirePage` are untouched:
 * this is only what a refusal *looks like*. A staff role that types the URL of a page their
 * menu does not carry is still sent to their own home with the "Not on your menu" toast (307,
 * src/auth/page-guard.ts), and the APIs still answer 403 to the same caller.
 */
export async function RefusedPage({ path }: { path?: string }) {
  const card = <NoAccess path={path} />;
  if (shellComesFromLayout(path)) return card;
  return (
    <ConsoleShell caller={await getCaller()}>
      {card}
    </ConsoleShell>
  );
}
