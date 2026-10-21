/**
 * WHY A CHANGE COULD NOT BE MADE, CARRIED WHOLE (ledger #80).
 *
 * The board's writer (`plan/place.ts writePlan`) already says why it refuses — a reason code, and
 * the van and child it is about. A `Refusal` is that answer, unchanged, with the day and leg it
 * was about: the agent reads it as feedback, the panel shows it, the "needs a person" card holds
 * it, the log prints it. Nothing here decides anything; it only keeps what the writer said.
 *
 * The words come from one table keyed by the reason (`ui/copy.ts refusal`), filled with the names
 * of the van and child it names, and the way to fix it is derived from what it names: a van opens
 * that van on Plan routes, a child that child's family, anything else the leg's plan.
 */
import { familyThreadHref } from "@/auth/access";
import type { Direction } from "@/domain/day/leg";
import { demoTokenForId } from "@/modules/agent/run/scope-tokens";
import { boardHref, PLAN_ROUTES_PATH } from "@/modules/plan/when";
import { fill, refusal as words } from "@/ui/copy";

export type Refusal = {
  /** The writer's own code: `NOT_STARTED`, `CHANGED`, `VAN_LEFT`, a fit reason (`SEAT`, …), … */
  readonly reason: string;
  readonly date: string;
  readonly leg: Direction;
  readonly vanId?: string | null;
  readonly childToken?: string | null;
  /** The names the board knew them by when it refused — so any screen can say it as written. */
  readonly vanName?: string | null;
  readonly childName?: string | null;
};

type NamingBoard = {
  readonly day: {
    readonly vans: readonly { id: string; name: string }[];
    readonly riders: readonly { token: string; name: string }[];
    readonly others: readonly { token: string; name: string }[];
  };
};

/** The writer's refusal — its reason and the van and child it names — with their names off the board. */
export function refusalOf(
  refused: { readonly reason: string; readonly vanId?: string | null; readonly childToken?: string | null },
  at: { readonly date: string; readonly leg: Direction },
  board?: NamingBoard | null,
): Refusal {
  const vanId = refused.vanId ?? null;
  const childToken = refused.childToken ?? null;
  return {
    reason: refused.reason,
    date: at.date,
    leg: at.leg,
    vanId,
    childToken,
    vanName: board?.day.vans.find((v) => v.id === vanId)?.name ?? null,
    childName: board ? [...board.day.riders, ...board.day.others].find((c) => c.token === childToken)?.name ?? null : null,
  };
}

export type RefusalWords = { readonly says: string; readonly fix: { readonly label: string; readonly href: string } };

/** One plain sentence saying what is in the way, and the one place to go and fix it. */
export function refusalWords(r: Refusal): RefusalWords {
  const leg = r.leg === "AM" ? words.legWord.AM : words.legWord.PM;
  const values = { van: r.vanName ?? words.aVan, child: r.childName ?? words.aChild, leg };
  const known = (words.says as Readonly<Record<string, string>>)[r.reason];
  // A sentence that would have to name somebody it cannot falls back to the plain one.
  const needs = (template: string) => (template.includes("{van}") && !r.vanName) || (template.includes("{child}") && !r.childName);
  const says = known && !needs(known) ? fill(known, values) : fill(words.says.OTHER, values);
  // A stale agent plan card: who it was about, and Plan routes — never a version or a code.
  if (r.reason === "STALE_CARD") {
    return {
      says: fill(r.childName ? words.says.STALE_CARD : words.says.STALE_CARD_NO_CHILD, values),
      fix: { label: words.fix.planRoutes, href: PLAN_ROUTES_PATH },
    };
  }
  const childKey = r.childToken ? demoTokenForId(r.childToken) : null;
  const fix =
    r.vanId && r.vanName
      ? { label: fill(words.fix.van, values), href: boardHref(PLAN_ROUTES_PATH, { date: r.date, leg: r.leg, van: r.vanId }) }
      : childKey && r.childName && r.reason === "NO_CONTACT"
        ? { label: fill(words.fix.child, values), href: familyThreadHref(childKey) }
        : { label: fill(words.fix.plan, values), href: boardHref(PLAN_ROUTES_PATH, { date: r.date, leg: r.leg }) };
  return { says, fix };
}

/** One line for the log: the code and the ids it names, never a name or a sentence. */
export function refusalLogLine(where: string, r: Refusal): string {
  return `[${where}] refused ${r.reason} date=${r.date} leg=${r.leg}${r.vanId ? ` van=${r.vanId}` : ""}${r.childToken ? ` child=${r.childToken}` : ""}`;
}
