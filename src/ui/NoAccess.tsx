import Link from "next/link";
import { UserLock } from "lucide-react";
import { homePathFor, pageLabel, whoCanOpenLine } from "@/auth/access";
import { getCaller } from "@/auth/caller";
import { fill, noAccess } from "./copy";
import { icon } from "./tokens";
import styles from "./NoAccess.module.css";

/**
 * A page that exists, is open to staff, and is not open to *this* person.
 *
 * What it says, and nothing more (COPY-GUIDE §1–§2):
 *  - one icon, so the card reads as a state of the product rather than a wall of text. `user-lock`
 *    is a person and a lock: it is about who is asking, not about the page being broken. It is not
 *    an icon DESIGN-DIRECTION §3 gives a *state* meaning to, nor a §7.1 source mode, so it cannot
 *    read as a live alert (the same rule the nav rail follows);
 *  - the heading, exactly "This page isn't part of your role" — their role, not their mistake;
 *  - one line naming who the page *is* for, generated from the access table in the roles' own
 *    human words, so the sentence cannot drift from the guard that refused;
 *  - one way out: the first page this person's own role can open.
 *
 * What it must never show: the status code, the role key the database stores, or the route path.
 * `no-codes.test.ts` and `no-internals.test.ts` hold the general line, and no-access.test.ts
 * holds this page's own.
 *
 * The DEMO bar and the one Simulated chip are above it, from the root layout, on this route as on
 * every other (§7, §7.1, NFR-09) — this card must not mount a second pair.
 *
 * It is a card, not a page: every boundary that renders it is inside the app shell, so the menu,
 * the header and Sign out are on screen around it and a refusal is not the dead end the
 * founder's walk of production found (Vera's review, 2026-10-17). That is also why there is no
 * `<main>` here — the shell's `#content` is the landmark, and two would be one too many.
 *
 * It is rendered by a `forbidden.tsx` boundary, which is what makes the response a real 403
 * (src/auth/page-guard.ts calls `forbidden()`), and `path` is the page that was asked for. The
 * root boundary passes none.
 *
 * One caller gets different words: someone signed in who holds no role at any site at all. Their
 * refusal is not about this page — every page refuses them — so "This page isn't part of your
 * role" and a line naming the roles that could open it would both be beside the point. They get
 * Vera's two lines instead (`noAccess.noRoleHeading` / `noRoleLine`): what is true of their
 * account, and who can change it. Everyone else keeps the role card above, page line included.
 */
export async function NoAccess({ path }: { path?: string }) {
  const caller = await getCaller();
  const home = homePathFor(caller);
  const noRole = caller.kind === "NO_ROLE";
  return (
    <div className={styles.page}>
      <div className={styles.card}>
        <p className={styles.icon}>
          <UserLock size={icon.nav} aria-hidden="true" />
        </p>
        <h1 className={styles.heading}>{noRole ? noAccess.noRoleHeading : noAccess.heading}</h1>
        {noRole ? <p className={styles.line}>{noAccess.noRoleLine}</p> : null}
        {!noRole && path ? <p className={styles.line}>{whoCanOpenLine(path)}</p> : null}
        <Link className={styles.link} href={home}>
          {fill(noAccess.back, { page: pageLabel(home) })}
        </Link>
      </div>
    </div>
  );
}
