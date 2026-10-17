/**
 * What the phone panel renders, and where it came from.
 *
 * The panel has two possible sources for the same thread, and this module is the one place that
 * chooses between them — so the screen never has to:
 *
 *  1. **the message log** (`personaMailboxResponse`, the read model behind the persona-phone
 *     endpoint): the inbound messages this family sent and the outbound rows addressed to them,
 *     with the state each one reached. This is the real thing, and it is what the panel shows
 *     wherever the messages exist — including a preview, which reads the one shared database
 *     read-only (DECISION-LEDGER #43) and so can see what production's sweep queued and sent.
 *  2. **the demo day's own replay** (`demoLateDropoffs`): the same texts, computed from the
 *     committed geometry and the §8 notify gate, rendered through the same outbox template. No
 *     database at all, so the panel still shows the demo on a deployment that has not run the
 *     day yet, and on a laptop with no `DATABASE_URL`.
 *
 * The *words in a bubble* are identical either way — both come from `renderTemplate` over the
 * outbox's own copy (src/ui/copy.ts `outboundSms`) — which is what makes the fallback honest
 * rather than a mock-up. What differs is what can be said about *delivery*: the log knows, the
 * replay does not, so a projected bubble carries no delivery state and the panel says why
 * (`phonePanel.fromScenario`).
 */
import type { Db } from "@/db/exec";
import { formatClock } from "@/domain/eta/eta";
import { demoLateDropoffs, type LateDropoff } from "@/modules/demo/late-dropoff";
import { personaMailboxResponse, type PersonaMessage } from "@/modules/messaging/mailbox";
import { normalizeE164 } from "@/modules/identity/phone";
import { fill, phonePanel } from "@/ui/copy";
import { outboundStates } from "@/ui/states";
import type { StateDescriptor } from "@/ui/states";

/** One bubble: who it is from, when, what it said, and what became of it. */
export type Bubble = {
  readonly id: string;
  readonly direction: "IN" | "OUT";
  /** "4:08 PM" in the site's timezone — a real time, never a relative one. */
  readonly timeLabel: string;
  /** The rendered body. Outbound text is the outbox's own copy; inbound is as received. */
  readonly body: string;
  /** The §3 outbound state, when it is known. Null on a projected bubble (nothing was sent). */
  readonly delivery: StateDescriptor | null;
  /** False for a message that never left the center: it must never be drawn as if it arrived. */
  readonly reachedPhone: boolean;
};

export type ThreadSource = "log" | "scenario";

export type Thread = {
  readonly source: ThreadSource;
  readonly bubbles: readonly Bubble[];
};

/** The sim persona number as the mailbox route spells it (E.164), from the fixture's own form. */
export function e164Of(dropoff: Pick<LateDropoff, "phone">): string {
  return normalizeE164(dropoff.phone) ?? dropoff.phone;
}

/**
 * The same number as a person reads it: "(561) 555-0102". The fixtures hold a dialling form and
 * the mailbox route wants E.164; neither is something a screen prints (COPY-GUIDE §3).
 */
export function phoneLabel(dropoff: Pick<LateDropoff, "phone">): string {
  const digits = e164Of(dropoff).replace(/\D/g, "").slice(-10);
  if (digits.length !== 10) return dropoff.phone;
  return fill(phonePanel.phoneFormat, {
    area: digits.slice(0, 3),
    prefix: digits.slice(3, 6),
    line: digits.slice(6),
  });
}

/**
 * The thread for one family, log first.
 *
 * Every refusal the read model can answer with lands in the same place — no session (the browser
 * check's synthetic role has a role and no user), a phone at another site, a database that is not
 * configured or not reachable — because for this panel they all mean the same thing: the log
 * cannot tell us, so show the day the scenario would send. The refusal is never rendered: a
 * coordinator reading a family's thread has no use for a status code.
 */
export async function threadFor(
  db: () => Db,
  a: { dropoff: LateDropoff; pepper: string | undefined; userId: string | undefined },
): Promise<Thread> {
  const logged = await loggedThread(db, a);
  if (logged && logged.length > 0) return { source: "log", bubbles: logged };
  return { source: "scenario", bubbles: [projected(a.dropoff)] };
}

async function loggedThread(
  db: () => Db,
  a: { dropoff: LateDropoff; pepper: string | undefined; userId: string | undefined },
): Promise<readonly Bubble[] | null> {
  if (!a.pepper || !a.userId) return null;
  try {
    const answer = await personaMailboxResponse(db(), {
      number: e164Of(a.dropoff),
      pepper: a.pepper,
      userId: a.userId,
    });
    if (answer.status !== 200) return null;
    return answer.body.messages.map(bubbleOf);
  } catch {
    // No database on this deployment, or it refused. The scenario is the answer either way.
    return null;
  }
}

function bubbleOf(message: PersonaMessage): Bubble {
  return {
    id: message.id,
    direction: message.direction,
    timeLabel: formatClock(Date.parse(message.at)),
    body: message.body ?? "",
    delivery: message.state ? outboundStates[message.state as keyof typeof outboundStates] ?? null : null,
    reachedPhone: message.reachedPhone,
  };
}

/** The demo day's own text, as a bubble. No delivery state: nothing has been sent. */
function projected(dropoff: LateDropoff): Bubble {
  return {
    id: `${dropoff.childKey}-${dropoff.atMs}`,
    direction: "OUT",
    timeLabel: formatClock(dropoff.atMs),
    body: dropoff.body,
    delivery: null,
    reachedPhone: true,
  };
}

/** The families the demo day has a text for, in the order the van reaches them. */
export function phonesForDay(...args: Parameters<typeof demoLateDropoffs>): readonly LateDropoff[] {
  return demoLateDropoffs(...args);
}
