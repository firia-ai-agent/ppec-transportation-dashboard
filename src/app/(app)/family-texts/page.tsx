import Link from "next/link";
import { redirect } from "next/navigation";
import {
  FAMILY_TEXTS_FOR_YOU,
  FOR_YOU_TAB,
  canOpenForYou,
  homePathFor,
} from "@/auth/access";
import { requirePage } from "@/auth/page-guard";
import { stub } from "@/ui/copy";
import { NOT_ON_YOUR_MENU, withNotice } from "@/ui/notice";
import { StubPage } from "@/ui/StubPage";

/** The guard reads a session, so this route is never statically rendered. */
export const dynamic = "force-dynamic";

/**
 * Family texts (REDESIGN-SPEC §0, menu item 5): the thread this day sent to each family and what
 * they sent back. Its title is the frame's (src/ui/PageHeader.tsx) and it holds no data at all —
 * the messages are the agent and outbox work, and a list of invented texts on a screen a parent
 * is quoted from would be the worst thing in this app to fake.
 *
 * The one link on it is the "For you" half — the approvals queue, which §9.2 keeps off the menu
 * ("Approvals is the For you tab inside Family texts, not a menu item") and which `/approvals`
 * is a 308 to. So this is the way there, inside the frame, rather than a sixth rail item.
 *
 * TWO GUARDS, AND THEY ANSWER TWO QUESTIONS.
 *  1. `requirePage` — may you open Family texts at all? That is this page's row.
 *  2. `canOpenForYou` — may you *decide*? That is `APPROVAL_ROLES` (src/auth/access.ts), and it
 *     is asked here, on the server, before any markup exists, because `?tab=for-you` is a URL a
 *     person can type. A tab that is merely not drawn is hiding, not denying (the ID-swap
 *     skill, rule 6), and the front desk must never land on this queue — they land on their own
 *     home, the live map, with the §9.3 notice.
 * The two are independent on purpose: widening the row that opens the page must not quietly
 * hand the approvals queue to a role that may not approve.
 */
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const caller = await requirePage("/family-texts");
  const { tab } = await searchParams;
  if (tab === FOR_YOU_TAB && !canOpenForYou(caller)) {
    redirect(withNotice(homePathFor(caller), NOT_ON_YOUR_MENU));
  }
  return (
    <StubPage>
      <p>
        <Link href={FAMILY_TEXTS_FOR_YOU}>{stub.approvalsLink}</Link>
      </p>
    </StubPage>
  );
}
