/**
 * THE CARD'S TICKS, COMPUTED — Firia's S1-2 (2026-10-17 11:00 PM ET): "the Same van / Fits /
 * on-file ticks are COMPUTED from real data (fit.ts and the roster), not hardcoded".
 *
 * They were hardcoded. `conversations.proposalChecks` returned the same three chips for every
 * proposal there could ever be — "Same van", "Fits", "{adult} on file" — which made them
 * decoration rather than checks, and the third of them was not merely unverified but *wrong* for
 * at least one family the demo ships: F2 holds every authorization scope except `RECEIVE_CHILD`
 * (src/modules/demo/fixtures/standard.ts, AT-13), so a card for that family claimed an adult was
 * on file to collect the child when the file says the opposite. A green tick on a card somebody
 * is about to approve is the worst possible place for a guess.
 *
 * So each of the three is answered here, from the same sources the rest of the product answers it
 * from, and a check that cannot be answered **is not shown**:
 *
 *  - **Same van** — the child is on a run this leg, in a van the day's own source
 *    (`demoDaySource`, which is what the board reads) has on the road. An approved drop-off change
 *    moves the stop and the time; it does not move the child between vans, so "same van" is a
 *    statement about the plan as it stands and is false for a child on no run at all.
 *  - **Fits** — `fits(setup, riders)` from src/domain/plan/fit.ts, over that van's own setup and
 *    the riders already aboard it. The board's arithmetic and not a second copy of it: a nurse
 *    riding along takes a seat, a child in their own chair does not, and this card must agree with
 *    the board about both.
 *  - **{adult} on file** — the family's own file says this adult may receive this child
 *    (`RECEIVE_CHILD`, PRD §6.4). Nothing else counts as being on file *for a drop-off*: being
 *    reachable by text is a different permission.
 *
 * The pick-up row is the same read, which is why it is here too: a card may only say "{adult} ·
 * same" when the file actually puts that adult at the end of the ride.
 *
 * Pure apart from the day source's two reads. It opens no connection to `identity` — the adult's
 * name comes off the roster fixture, which is the gateway's own answer in this data class
 * (src/modules/identity/gateway.ts) and not a read of the restricted schema (schema.ts:104).
 */
import type { ServiceDay } from "@/domain/board/day";
import { fits } from "@/domain/plan/fit";
import {
  CENTER_STOP,
  CHILDREN,
  FAMILIES,
  SPARE_STOP,
  STOPS,
  childByKey,
  childKeyOfToken,
  runOfChild,
  vehicleIdOf,
} from "@/modules/demo/fixtures/standard";
import { approval, fill } from "@/ui/copy";
import { afternoonVanOf } from "./plan-van";

/** Everything the card says about a proposal that is a *fact* rather than a field of the row. */
export type ProposalFacts = {
  /**
   * The fixture child key this proposal's `child_token` reads back to — what `?thread=` names and
   * what the thread pane is keyed by — or null for a token this roster cannot name.
   */
  readonly threadKey: string | null;
  /** "Lee W." — the adult on the family's file, or "" when the roster cannot name one. */
  readonly adultName: string;
  /** The child as a staff screen names them, or "" when this day has no such child. */
  readonly childLabel: string;
  /** "{adult} · same", or "" when the file does not say this adult collects the child. */
  readonly pickupLabel: string;
  /** "Palm Beach State College, Lake Worth" — the place the proposal's own stop token names. */
  readonly stopLabel: string;
  /** The checks that actually passed, in the order the mockup reads them. */
  readonly checks: readonly string[];
  /**
   * "Van 2" — the van this child rides on the leg the proposal is about, or "" when the plan has
   * them on none.
   *
   * On the card for one reason: Approve moves the plan, and the line that says so has to name the
   * van it leaves them on (Firia, 11:11 AM ET 2026-10-18). It is the same read "Same van" is
   * answered from, so the line and the tick cannot disagree.
   */
  readonly vanName: string;
};

const NOTHING: ProposalFacts = {
  threadKey: null, adultName: "", childLabel: "", pickupLabel: "", stopLabel: "", checks: [], vanName: "",
};

/**
 * The facts behind one proposal, for the child it names and the stop it proposes.
 *
 * `childToken` is the row's own `proposal ->> 'child_token'`. A token this deployment's roster
 * cannot read back is not an error and not a guess: the card renders with no ticks, which is the
 * honest shape for a row whose child nobody here can name.
 */
export async function proposalFacts(a: {
  /** The centre the proposal belongs to: the van comes from its saved plan (`plan-van.ts`). */
  readonly siteId: string;
  readonly childToken: string;
  readonly stopToken: string;
  readonly day: ServiceDay;
}): Promise<ProposalFacts> {
  const childKey = childKeyOfToken(a.childToken);
  if (childKey === null) return { ...NOTHING, stopLabel: stopLabelOf(a.stopToken) };
  const child = childByKey(childKey);
  if (!child) return { ...NOTHING, stopLabel: stopLabelOf(a.stopToken) };

  const family = FAMILIES.find((f) => f.key === child.familyKey);
  const adultName = family ? `${family.guardian.firstName} ${family.guardian.lastInitial}.` : "";

  /*
   * The file, for this child and this adult. `RECEIVE_CHILD` is the scope that says an adult may
   * be handed the child at the end of a ride (PRD §6.4) — it is what the seed writes as
   * `can_receive_child` and what the outbox's own policy reads — and it is per *child*, which is
   * why this is the child's own row rather than the family's.
   */
  const onFile = adultName !== "" && child.scopes.includes("RECEIVE_CHILD");

  const checks: string[] = [];
  let vanName = "";
  // The van the saved plan has them on this afternoon, with today's confirmed setup (plan-van.ts).
  const onVan = await afternoonVanOf(a.siteId, a.childToken);
  if (onVan) {
    vanName = onVan.van.name;
    // The change keeps the child in the van they already ride: that is what "same van" says.
    checks.push(approval.checkSameVan);
    // src/domain/plan/fit.ts §1.4, over this van's own setup. Not a second answer to "does it fit".
    if (fits(onVan.van.setup, onVan.aboard)) checks.push(approval.checkFits);
  }
  if (onFile) checks.push(fill(approval.checkOnFile, { adult: adultName }));

  return {
    threadKey: childKey,
    adultName,
    childLabel: child.label,
    pickupLabel: onFile ? fill(approval.pickupSame, { adult: adultName }) : "",
    stopLabel: stopLabelOf(a.stopToken),
    checks,
    vanName,
  };
}

/**
 * The place a stop token names, as a person reads it.
 *
 * The token is what an outbound message carries in its vars (`stopLabel`, the outbox's `stopToken`
 * rule); the landmark is what a coordinator reads (COPY-GUIDE §3: a landmark, never an address).
 * A token nothing here knows renders as nothing rather than as the token, because a card that
 * printed `PBSC-LW` at somebody would be showing them a code (§9.3).
 */
function stopLabelOf(stopToken: string): string {
  if (stopToken === "") return "";
  return [...STOPS, CENTER_STOP, SPARE_STOP].find((s) => s.smsToken === stopToken)?.label ?? "";
}

/** The roster rows this module reads, named once so a test can assert against the same list. */
export const ROSTER_CHILDREN = CHILDREN;
