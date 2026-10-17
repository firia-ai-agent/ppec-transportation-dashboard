import { requirePage } from "@/auth/page-guard";
import { getNeonDb } from "@/db/exec";
import { demoDay } from "@/domain/board/day";
import { modelReach } from "@/modules/agent/run/deps";
import { familyTexts } from "@/ui/copy";
import { Placeholder } from "@/ui/Placeholder";
import { nav } from "@/ui/copy";
import { LiveTurnProvider } from "./LiveTurnProvider";
import { PhoneComposer } from "./PhoneComposer";
import { PhonePanel } from "./PhonePanel";
import { phonesForDay, threadFor } from "./thread";

export const metadata = { title: familyTexts.documentTitle };

/** The guard reads a session, so this route is never statically rendered. */
export const dynamic = "force-dynamic";

/**
 * /family-texts — the parent phone panel (DESIGN-DIRECTION §6.3), where the founder reads the
 * text that went out. The screen is PhonePanel.tsx and the thread is chosen in thread.ts; this
 * file is the guard and the wiring.
 *
 * Behind staff sign-in and behind the two console roles, which is the same row the persona-phone
 * endpoint already carries and for the same reasons: PRD §1.1 gives the web console to the
 * coordinator and the director, PRD §6.2 lists messages as written by adapters only and puts the
 * front desk down as the writer of actual attendance and custody alone, and §12 is
 * minimum-necessary — a family's thread is PHI-adjacent, so a role with no task that needs it does
 * not get it. A role the row omits gets the no-access page and a 403 (forbidden.tsx beside this
 * file), never this frame.
 *
 * `?child=` picks which family's phone is open. It names a *fixture child* and is matched against
 * the day's own list, so a value from outside is either one of today's threads or the first one —
 * there is no id here a request could use to reach a family the day did not text.
 *
 * The DEMO banner and the one NFR-09 source chip come from the root layout, on every route; this
 * page mounts neither. The Simulated chip inside the frame is the §7.1 *record* chip.
 *
 * Inside the console shell (the `(app)` group), unlike the other preview routes: this one is in
 * the nav rail (src/ui/nav-items.ts), and a destination a coordinator can reach from the rail has
 * to be a destination they can leave the same way. The shell checks there is a session; this row
 * checks the role.
 */
export default async function PhonePreviewPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const caller = await requirePage("/family-texts");
  const params = await searchParams;
  const asked = Array.isArray(params.child) ? params.child[0] : params.child;

  const day = demoDay();
  const phones = phonesForDay(day);
  // A day with no family text has nothing to show and says so, rather than rendering an empty
  // phone that reads as "the text failed".
  if (phones.length === 0) return <Placeholder page={nav.today} body={familyTexts.emptyDay} />;

  const selected = phones.find((p) => p.childKey === asked) ?? phones[phones.length - 1];
  const thread = await threadFor(getNeonDb, {
    dropoff: selected,
    pepper: process.env.HMAC_PEPPER,
    userId: caller.kind === "STAFF" ? caller.userId : undefined,
  });

  /*
   * One turn, two places (`live-turn.ts`): the bubbles it produces belong *in* the thread, inside
   * the phone frame, and the controls that produce it belong beside the phone (§6.3). The provider
   * is mounted here, above both, and wraps the server-rendered panel untouched.
   */
  return (
    <LiveTurnProvider>
    <PhonePanel
      phones={phones}
      selected={selected}
      thread={thread}
      dayLabel={day.label}
      composer={
        <PhoneComposer
          childKey={selected.childKey}
          childFirstName={selected.childFirstName}
          guardianName={selected.guardianName}
          modelReachKind={modelReach().kind}
        />
      }
    />
    </LiveTurnProvider>
  );
}
