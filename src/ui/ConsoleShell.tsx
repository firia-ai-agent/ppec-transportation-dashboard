import type { ReactNode } from "react";
import { canOpenForYou } from "@/auth/access";
import type { ResolvedCaller } from "@/auth/caller";
import { getNeonDb } from "@/db/exec";
import { readAgentThreadOrEmpty } from "@/modules/agent/ask/thread";
import { modelReach } from "@/modules/agent/run/deps";
import { decideApprovalAction } from "@/app/(app)/family-texts/actions";
import type { ProposalView } from "@/app/(app)/family-texts/conversations";
import { approvalQueue } from "@/app/(app)/family-texts/queue";
import { demoDay } from "@/domain/board/day";
import { siteOf } from "@/modules/plan/api";
import { AgentBubble } from "./AgentBubble";
import { AgentCompose } from "./AgentCompose";
import { RefreshWhileAgentWorks } from "./RefreshWhileAgentWorks";
import { AppShell } from "./AppShell";
import { fill, identity, roleNames } from "./copy";
import { accountLines, initialsOf } from "./display-name";
import type { RailAccount } from "./NavRail";

/** The account page, which is where both identity entry points go (src/auth/access.ts). */
const ACCOUNT_PATH = "/whoami";

/**
 * The console shell as a layout mounts it: one place that turns the caller its guard just
 * returned into the two things the shell needs — the name in the identity menu, and the role the
 * nav is filtered by.
 *
 * Four layouts mount it (src/app/(app)/layout.tsx and one each in the three route folders that
 * sit outside that group), and this file is why none of them holds its own opinion about either.
 * A second mapping of caller → nav role is exactly how a menu ends up different on one screen,
 * which is the bug the founder found on 2026-10-17: the three screens outside the group had no
 * menu at all, and the way to be sure they now have *the same* one is for there to be a single
 * expression producing it.
 *
 * It takes the caller rather than calling the guard, so each layout still names its own row in
 * the access table in its own file (`requirePage(LAYOUT.…)`) and src/auth/access.test.ts can
 * read it there.
 *
 * The name is the person's, not the database row's: the helpers in src/ui/display-name.ts drop
 * the synthetic `SYN` prefix and the role and shorten what is left to "Dana M." (Vera's review,
 * 2026-10-17; the founder's mockups). Applied here, the one place a caller becomes what the
 * shell renders, so the rail's account block, the phone's avatar and /whoami cannot disagree
 * about who is signed in — and `accountLines` is the one that decides a session whose whole
 * name *is* a role says that role once rather than twice.
 *
 * THE AGENT BUBBLE IS MOUNTED HERE, and here only (src/ui/AgentBubble.tsx). The founder asked for
 * it "on every screen", and this is the one component every app route's layout renders — so one
 * mount is every route, by the same argument src/ui/one-menu.test.ts makes about the menu. It
 * also has to be *one* mount rather than four: the panel's open/closed state lives in the
 * component, and a bubble mounted per layout would close itself every time somebody changed tab.
 *
 * It is given `canOpenForYou(caller)` — the server's own answer, from the same function the For
 * you page guards itself with — rather than a role, because the bubble shows proposals waiting
 * for a decision and the front desk may not decide. The function is asked here for the same
 * reason the nav role is: one expression, so no screen can hold a different opinion.
 *
 * The thread is read here too, and only for somebody who may see it: one read, in the one place
 * the bubble is mounted, so a tab change costs the same query rather than a different one per
 * screen. It is fail-soft (`readAgentThreadOrEmpty`) — a panel that cannot list today's proposals
 * is a far smaller problem than a console that will not render, and the proposals are still on
 * their own screen, which is where the panel's own buttons go.
 */
export async function ConsoleShell({
  caller,
  title,
  pageOwnsMain,
  children,
}: {
  caller: ResolvedCaller;
  /**
   * Passed through to {@link AppShell}: the page header bar's title, for the one screen whose
   * path has no row in the access table to read one from — the refusal (src/ui/RefusedPage.tsx).
   */
  title?: string;
  /** Passed through to {@link AppShell}: the screen inside already has a `main` landmark. */
  pageOwnsMain?: boolean;
  children: ReactNode;
}) {
  const role = caller.kind === "STAFF" ? caller.role : null;
  const canDecide = canOpenForYou(caller);
  const thread = canDecide ? await readAgentThreadOrEmpty(getNeonDb, siteOf(caller)) : null;
  const cards = canDecide && (thread?.waiting ?? 0) > 0 ? await cardsOrEmpty(siteOf(caller)) : [];
  const working = canDecide ? await agentWorking(siteOf(caller)) : false;
  const lines = accountLines(caller.displayName, role ? roleNames[role].one : null);
  const account: RailAccount | null = lines.name
    ? {
        ...lines,
        initials: initialsOf(lines.name),
        label: lines.role
          ? fill(identity.account, { name: lines.name, role: lines.role })
          : fill(identity.accountRoleOnly, { role: lines.name }),
        href: ACCOUNT_PATH,
      }
    : null;
  return (
    <>
      <AppShell account={account} role={role} title={title} pageOwnsMain={pageOwnsMain}>
        {children}
      </AppShell>
      <AgentBubble
        canDecide={canDecide}
        waiting={thread?.waiting ?? 0}
        items={thread?.items ?? []}
        compose={<AgentCompose />}
        cards={cards}
        decide={decideApprovalAction}
      />
      <RefreshWhileAgentWorks working={working} />
    </>
  );
}

/**
 * The pending proposals as the cards Family texts draws — the same queue (`family-texts/queue.ts`),
 * so the bubble and the screen show one card, not two drafts of one. Gated the way Family texts
 * gates it: with no model there is nothing to approve. Fail-soft like the thread above.
 */
async function cardsOrEmpty(siteId: string): Promise<readonly ProposalView[]> {
  if (modelReach().kind !== "model") return [];
  try {
    return await approvalQueue({ db: getNeonDb(), siteIds: [siteId], day: demoDay(), editedTime: null });
  } catch {
    return [];
  }
}

/**
 * Is an agent run at this site still on its way to an answer? Read so the screens can catch up
 * when it lands (`RefreshWhileAgentWorks`). Fail-soft: a read that fails is "not working".
 */
async function agentWorking(siteId: string): Promise<boolean> {
  try {
    const r = await getNeonDb().query<{ n: number }>(
      "SELECT count(*)::int AS n FROM ops.agent_run WHERE site_id = $1 AND state IN ('QUEUED', 'RUNNING')",
      [siteId],
    );
    return (r.rows[0]?.n ?? 0) > 0;
  } catch {
    return false;
  }
}
