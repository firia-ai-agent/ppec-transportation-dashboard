import Link from "next/link";
import { requirePage } from "@/auth/page-guard";
import { nav, stub } from "@/ui/copy";
import { StubPage } from "@/ui/StubPage";

/** The guard reads a session, so this route is never statically rendered. */
export const dynamic = "force-dynamic";

/**
 * Family texts (REDESIGN-SPEC §0, menu item 5): the thread this day sent to each family and
 * what they sent back. Its title and one line, and no data at all — the messages are the agent
 * and outbox work, and a list of invented texts on a screen a parent is quoted from would be
 * the worst thing in this app to fake.
 *
 * It is on the menu because nothing on the menu may 404 (§0): `/family-texts` answered 404 on
 * production during the founder's walk, which is the gap this page closes. The screen behind it
 * arrives with the texts themselves.
 *
 * The one link on it is the "For you" half — the approvals queue, which §9.2 keeps off the menu
 * on purpose ("Approvals is the For you tab inside Family texts, not a menu item"). So this is
 * the way there, inside the frame, rather than an eighth rail item.
 *
 * Server-side role guard first, before anything is rendered: /family-texts is in the access
 * table (src/auth/access.ts), and a role that is not in its row gets the no-access page and a
 * 403 (forbidden.tsx beside this file), never this frame.
 */
export default async function Page() {
  await requirePage("/family-texts");
  return (
    <StubPage title={nav.familyTexts} line={stub.familyTexts}>
      <p>
        <Link href="/approvals">{stub.approvalsLink}</Link>
      </p>
    </StubPage>
  );
}
