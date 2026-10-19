/**
 * A TEAMMATE'S WORDS, READ AGAINST TODAY'S BOARD (ledger #77).
 *
 * The teammate tools name a van as the board does ("Van 2") and a child by the prompt's token, which
 * the loop has already resolved to the child's id. This turns those arguments into a `PlanChange`
 * over the board's own van ids — for `get_plan`'s preview and for `propose_plan_change`'s card
 * alike, so what was previewed is what is proposed. A van the board does not run today is named
 * back, never guessed at.
 */
import type { Bucket } from "@/domain/day/source";
import type { PlanChange } from "@/modules/actions/draft";
import type { loadBoard } from "@/modules/plan/store";
import { serviceDateIso } from "@/ui/service-date";

type BoardView = Awaited<ReturnType<typeof loadBoard>>;

const BUCKET_PLACES: ReadonlySet<string> = new Set(["UNASSIGNED", "FAMILY_DRIVES", "ABSENT"]);

/** Today, the only day a teammate works on: the service date of the run's own clock. */
export const todayOf = (now: Date) => serviceDateIso(now);

/** The leg a teammate named, or null. */
export const legOf = (v: unknown): "AM" | "PM" | null => (v === "AM" || v === "PM" ? v : null);

export function teamPlanChange(
  view: BoardView,
  args: { readonly replan?: unknown; readonly moves?: unknown; readonly departures?: unknown },
): { readonly change: PlanChange; readonly unknownVans: readonly string[] } {
  const unknownVans: string[] = [];
  const vanId = (name: unknown) => {
    const van = view.day.vans.find((v) => v.name === name);
    if (!van) unknownVans.push(String(name));
    return van?.id ?? null;
  };
  type Move = NonNullable<PlanChange["moves"]>[number];
  const moves = (Array.isArray(args.moves) ? args.moves : []).flatMap((m: { child?: unknown; place?: unknown }): Move[] => {
    const token = String(m.child ?? "");
    const place = String(m.place ?? "");
    if (BUCKET_PLACES.has(place)) return [{ token, bucket: place as Bucket, vanId: null }];
    const id = vanId(place);
    return id ? [{ token, bucket: "VAN", vanId: id }] : [];
  });
  const departures: Record<string, string> = {};
  for (const d of Array.isArray(args.departures) ? (args.departures as { van?: unknown; leaves?: unknown }[]) : []) {
    const id = vanId(d.van);
    if (id && typeof d.leaves === "string") departures[id] = d.leaves;
  }
  return { change: { replan: args.replan === true, moves, departures }, unknownVans };
}
