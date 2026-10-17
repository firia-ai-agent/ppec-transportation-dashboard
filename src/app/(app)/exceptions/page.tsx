import { requirePage } from "@/auth/page-guard";
import { getNeonDb } from "@/db/exec";
import { approval as approvalCopy, nav } from "@/ui/copy";
import { decideApprovalAction } from "./actions";
import { ApprovalCard } from "./ApprovalCard";
import { bodyOf, pendingApprovals, type PendingApproval } from "@/modules/approvals/decide";
import styles from "./approvals.module.css";

export const metadata = { title: approvalCopy.documentTitle };

/** The guard reads a session, so this route is never statically rendered. */
export const dynamic = "force-dynamic";

/**
 * SURF-05 Exceptions & Approvals (PRD §14 l.1055, §4.1), the approval half of it.
 *
 * This screen was a placeholder until now, and `agent/run/exec/proposals.ts` said why in its own
 * header: the agent has written `ops.approval_request` rows since B-08 slice 4, and "what is still
 * deferred [is] the approval *surface* that would turn a decision into an applied change". So the
 * demo had a §11.2 human tier with no human in it — a proposal nobody could say yes to. This is
 * the yes.
 *
 * Only the proposals at the sites **this caller is a member of**. The sites come off the one
 * session read (`getCaller`, which re-reads `ops.site_membership` on every request — ADR-004), so
 * the list is the tenant boundary itself rather than a filter applied after the fact, and this
 * page adds no membership query of its own. The decision then re-checks the site off the
 * approval's own row (`modules/approvals/decide.ts`), because a list is not a permission.
 *
 * Server-side role guard first, before anything is rendered: /exceptions is in the access table
 * (src/auth/access.ts) and a role that is not in its row gets the no-access page and a 403
 * (forbidden.tsx beside this file), never this frame.
 *
 * ## Why the bodies are rendered here
 *
 * The card lets a coordinator change the time, and the text they are approving has to change with
 * it. Rendering that in the browser would mean shipping the outbox's copy table and its renderer
 * to the client — a second place the family's words live, and the one thing this flow must not
 * have. So the server renders the sentence for every time the control offers and hands down the
 * map; the client picks. One renderer, and the screen cannot drift from the send.
 */
export default async function Page() {
  const caller = await requirePage("/exceptions");
  // The browser-test session is a role with no user and no membership, so it sees an empty list
  // rather than another site's proposals (src/domain/access/map-view.ts).
  const siteIds = caller.memberships.map((m) => m.siteId);
  const items = siteIds.length === 0 ? [] : await pendingApprovals(getNeonDb(), siteIds);

  return (
    <main className={styles.page}>
      <header className={styles.titleRow}>
        {/* The rail's own words for this destination, so the screen has one name. */}
        <h1 className={styles.heading}>{nav.exceptions}</h1>
        <p className={styles.intro}>{approvalCopy.intro}</p>
      </header>

      {items.length === 0 ? (
        <p className={styles.none}>{approvalCopy.none}</p>
      ) : (
        <ol className={styles.list}>
          {items.map((item) => (
            <ApprovalCard key={item.id} item={item} bodyFor={bodiesFor(item)} decide={decideApprovalAction} />
          ))}
        </ol>
      )}
    </main>
  );
}

/**
 * The quarter-hours Edit offers, and the sentence each one produces.
 *
 * Quarter-hours because a drop-off is a window, not a minute (§8: the family is told a 10-minute
 * window and never a promised minute), and because a list a coordinator picks from cannot be
 * mistyped — a free text field here would be a way to put "5pm-ish" into a template var. The
 * proposed time is always in the list even if it is not on a quarter, so the control opens on what
 * the assistant actually suggested.
 */
const EDIT_WINDOW_HOURS = [15, 16, 17, 18] as const;

function bodiesFor(item: PendingApproval): Record<string, string> {
  const times = new Set<string>();
  if (item.requestedTime) times.add(item.requestedTime);
  for (const hour of EDIT_WINDOW_HOURS) {
    for (const minute of ["00", "15", "30", "45"]) times.add(`${String(hour).padStart(2, "0")}:${minute}`);
  }
  const proposal = { template_id: item.templateId, vars: item.vars };
  const out: Record<string, string> = {};
  for (const hhmm of [...times].sort()) out[hhmm] = bodyOf(proposal, hhmm);
  return out;
}
