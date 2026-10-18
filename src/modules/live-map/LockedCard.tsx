import Link from "next/link";
import { Lock } from "lucide-react";
import { liveMap } from "@/ui/copy";
import { icon } from "@/ui/tokens";
import styles from "./live-map.module.css";

/**
 * NO ROUTES YET — the Live map before a plan is saved.
 *
 * REDESIGN-SPEC §9.1 makes "Plan saved → Live map" a **hard** gate: "No saved plan = no routes".
 * And §9.5's empty-state table is specific about what that looks like, which is why this is a
 * card over the map rather than a screen instead of it: "Map tiles with depot pin only + centred
 * card `No routes yet`" with a `Plan routes` action. The acceptance walk puts it plainly —
 * "On Live map with no saved plan, the centred `No routes yet` card and `Plan routes` button
 * show over the map, never a blank map."
 *
 * The action is offered only to a role whose own row in the access table opens Plan routes. The
 * front desk's does not — their menu is Live map + Ramp iPad (Firia, 2026-10-17 3:08 PM ET) —
 * so they get the same card with the sentence that is true for them: a coordinator saves the
 * plan. Hiding the link is a courtesy; /plan-routes checks the table again on the server, as
 * every page does.
 */
export function LockedCard({ canPlan }: { canPlan: boolean }) {
  return (
    <div className={styles.locked} role="status">
      <h2 className={styles.lockedHeading}>
        <Lock size={icon.inline} aria-hidden="true" />
        {liveMap.lockedHeading}
      </h2>
      <p className={styles.lockedBody}>
        {canPlan ? liveMap.lockedBody : liveMap.lockedBodyNoPlanAccess}
      </p>
      {canPlan ? (
        <Link href="/plan-routes" className={styles.lockedAction}>
          {liveMap.lockedAction}
        </Link>
      ) : null}
    </div>
  );
}
