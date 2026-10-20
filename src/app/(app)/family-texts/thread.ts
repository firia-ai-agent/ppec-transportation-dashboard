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
 * (`familyTexts.fromScenario`).
 */
import type { Db } from "@/db/exec";
import { formatClock } from "@/domain/eta/eta";
import { demoHandoffNotices, type HandoffNotice } from "@/modules/demo/handoff-notice";
import { demoLateDropoffs, type LateDropoff } from "@/modules/demo/late-dropoff";

/**
 * One family the day has texted, whatever the day texted them about.
 *
 * The two kinds today are the afternoon's late notice and the handoff the day recorded, and they
 * have everything this screen reads in common: whose ride, which adult, which phone, which
 * template, the words, and when. A screen that asked which kind a row was would be a screen with
 * two layouts for one list.
 */
export type DayPhone = LateDropoff | HandoffNotice;
import { personaMailboxResponse, type PersonaMessage } from "@/modules/messaging/mailbox";
import { normalizeE164 } from "@/modules/identity/phone";
import { identityGateway } from "@/modules/identity/gateway";
import { isAutoSend } from "@/modules/messaging/auto-sends";
import { fill, familyTexts } from "@/ui/copy";
import { outboundStates } from "@/ui/states";
import type { StateDescriptor } from "@/ui/states";

/**
 * Who wrote a bubble. Three answers, because the thread has to be able to say which, and
 * "Auto · Delivered" is a claim that only one of them earns (Firia's gate 4).
 *
 *  - `PARENT` — the family's own words, inbound.
 *  - `AUTO` — a templated follow-up the day sent by itself (`messaging/auto-sends.ts`).
 *  - `STAFF` — anything outbound that is not on that allow-list: an approved reply, which a
 *    person signed, and anything a person wrote. Never labelled auto, on purpose.
 */
export type BubbleAuthor = "PARENT" | "AUTO" | "STAFF";

/** One bubble: who it is from, when, what it said, and what became of it. */
export type Bubble = {
  readonly id: string;
  readonly direction: "IN" | "OUT";
  readonly author: BubbleAuthor;
  /** "4:08 PM" in the site's timezone — a real time, never a relative one. */
  readonly timeLabel: string;
  /** The rendered body. Outbound text is the outbox's own copy; inbound is as received. */
  readonly body: string;
  /** The §3 outbound state, when it is known. Null on a projected bubble (nothing was sent). */
  readonly delivery: StateDescriptor | null;
  /** False for a message that never left the center: it must never be drawn as if it arrived. */
  readonly reachedPhone: boolean;
  /**
   * A family's text the fast model read as nothing to change (ledger #85; PRD SURF-03): said under
   * the bubble, so a coordinator sees why no card came. Absent for anything else.
   */
  readonly triage?: "FYI" | "NOISE";
};

/**
 * Where the bubbles came from — and the third one is the point of this being a union of three.
 *
 *  - `log` — the message log answered, and the thread is the real thing.
 *  - `scenario` — there is nothing in the log for this family *and nothing went wrong*: the demo
 *    day has not run on this deployment, so the panel shows what it will send.
 *  - `logUnreadable` — the log could not be asked. A database that is not configured, not
 *    reachable, or that refused. The bubbles are still the projection, because a blank screen
 *    helps nobody, but this is **not** the same fact as `scenario` and the panel must not say it
 *    is: "the demo day hasn't run yet" is a claim about the day, and saying it when the truth is
 *    "we could not read the log" is the screen telling a coordinator something false about their
 *    own data (Veri's S3 note — the error used to be swallowed into `scenario`).
 */
export type ThreadSource = "log" | "scenario" | "logUnreadable";

export type Thread = {
  readonly source: ThreadSource;
  readonly bubbles: readonly Bubble[];
};

/** The sim persona number as the mailbox route spells it (E.164), from the fixture's own form. */
export function e164Of(dropoff: Pick<DayPhone, "phone">): string {
  return normalizeE164(dropoff.phone) ?? dropoff.phone;
}

/**
 * The same number as a person reads it: "(561) 555-0102". The fixtures hold a dialling form and
 * the mailbox route wants E.164; neither is something a screen prints (COPY-GUIDE §3).
 */
export function phoneLabel(dropoff: Pick<DayPhone, "phone">): string {
  const digits = e164Of(dropoff).replace(/\D/g, "").slice(-10);
  if (digits.length !== 10) return dropoff.phone;
  return fill(familyTexts.phoneFormat, {
    area: digits.slice(0, 3),
    prefix: digits.slice(3, 6),
    line: digits.slice(6),
  });
}

/**
 * The thread for one family, log first.
 *
 * Three answers, not two, and the difference is the whole of Veri's S3 note. The read model can
 * refuse for reasons that mean "there is nothing here" — no session (the browser check's synthetic
 * role has a role and no user), a phone at another site, an empty mailbox — and the projection is
 * the right answer for all of those. But it can also **fail**: no `DATABASE_URL`, an unreachable
 * host, a query that threw. That used to land in the same `catch` and come back as `scenario`, so
 * the panel told a coordinator "the demo day hasn't run yet" when the truth was "we could not read
 * your message log". One of those is a fact about the day and the other is a fault in the system,
 * and a screen that says the first when it means the second is lying to the person reading it.
 *
 * So a thrown read is `logUnreadable` and says so on screen. The bubbles are still the projection
 * — a blank thread helps nobody, and the words in them are the same outbox copy either way — but
 * the sentence under them is different, and it is the one that tells the truth.
 *
 * The error's own text is never rendered. A connection error can carry a host and a database name,
 * and a coordinator has no use for either; the words they read live in `ui/copy.ts`. It goes to
 * the server log, where a fault belongs, through `message` alone rather than the whole object, so
 * nothing attached to the error can ride along with it.
 */
export async function threadFor(
  db: () => Db,
  a: { dropoff: DayPhone; pepper: string | undefined; userId: string | undefined },
): Promise<Thread> {
  const logged = await loggedThread(db, a);
  if (logged.kind === "unreadable") return { source: "logUnreadable", bubbles: [projected(a.dropoff)] };
  if (logged.bubbles.length > 0) return { source: "log", bubbles: logged.bubbles };
  return { source: "scenario", bubbles: [projected(a.dropoff)] };
}

/** What the log could say: some bubbles (possibly none), or that it could not be asked at all. */
type LoggedThread =
  | { readonly kind: "read"; readonly bubbles: readonly Bubble[] }
  | { readonly kind: "unreadable" };

async function loggedThread(
  db: () => Db,
  a: { dropoff: DayPhone; pepper: string | undefined; userId: string | undefined },
): Promise<LoggedThread> {
  // Not a fault: the browser check's synthetic role holds a role and no user, and the read model
  // needs both. There is nothing to read, which is what the projection is for.
  if (!a.pepper || !a.userId) return { kind: "read", bubbles: [] };
  try {
    const answer = await personaMailboxResponse(db(), {
      number: e164Of(a.dropoff),
      pepper: a.pepper,
      userId: a.userId,
      // Who holds this number is the gateway's answer. Asking `db()` for it is `permission
      // denied for schema identity` (src/db/schema.ts:104), which is the fault this `catch`
      // used to turn into "the message log could not be read" on every single render.
      gateway: identityGateway(),
    });
    // A refusal the read model *can* answer with — another site's phone, a caller it will not
    // serve. It answered, so this is a fact about the data and not a fault.
    if (answer.status !== 200) return { kind: "read", bubbles: [] };
    return { kind: "read", bubbles: answer.body.messages.map(bubbleOf) };
  } catch (e) {
    // The log could not be asked. Said on screen (`logUnreadable`) rather than swallowed, and
    // recorded here — through `faultLine`, which is where the credential rule lives.
    console.error(`[family-texts] the message log could not be read: ${faultLine(e)}`);
    return { kind: "unreadable" };
  }
}

/**
 * One line about a fault, safe to put in a log.
 *
 * A database error's message is the one place a connection string turns up by accident: a driver
 * that cannot reach its host will happily quote the whole DSN back, password and all. So the
 * message is taken (never the error object, which can carry a `cause` with the same string in it),
 * any `scheme://user:password@host` is reduced to its scheme and host, and the result is bounded.
 *
 * The error's class name comes first because it is the part that is always safe and is usually
 * what identifies the fault.
 */
export function faultLine(e: unknown): string {
  const name = e instanceof Error ? e.constructor.name : typeof e;
  const text = e instanceof Error ? e.message : String(e);
  return `${name}: ${text.replace(/([a-z][a-z0-9+.-]*:\/\/)[^/\s@]*@/gi, "$1[redacted]@").slice(0, 200)}`;
}

/**
 * One logged message, as a bubble.
 *
 * Exported for the suite that reads a *real* drained row back onto the screen
 * (`messaging/eta-notice.test.ts`, Veri's run-8 gate 4): the two claims the thread makes about an
 * outbound text — who sent it, and what became of it — are both made here, off the row's own
 * `template_id` and `state`, and a test that re-implemented this mapping would prove nothing
 * about the screen.
 */
export function bubbleOf(message: PersonaMessage): Bubble {
  return {
    id: message.id,
    direction: message.direction,
    author: message.direction === "IN" ? "PARENT" : isAutoSend(message.templateId) ? "AUTO" : "STAFF",
    timeLabel: formatClock(Date.parse(message.at)),
    body: message.body ?? "",
    delivery: message.state ? outboundStates[message.state as keyof typeof outboundStates] ?? null : null,
    reachedPhone: message.reachedPhone,
    ...(message.direction === "IN" && (message.triage === "FYI" || message.triage === "NOISE") ? { triage: message.triage } : {}),
  };
}

/** The demo day's own text, as a bubble. No delivery state: nothing has been sent. */
function projected(dropoff: DayPhone): Bubble {
  return {
    id: `${dropoff.childKey}-${dropoff.atMs}`,
    direction: "OUT",
    // The §8 notice, which is on the auto allow-list: the day sends it with nobody in the loop.
    author: isAutoSend(dropoff.templateId) ? "AUTO" : "STAFF",
    timeLabel: formatClock(dropoff.atMs),
    body: dropoff.body,
    delivery: null,
    reachedPhone: true,
  };
}

/** The families the demo day has a text for, in the order the van reaches them. */
export function phonesForDay(...args: Parameters<typeof demoLateDropoffs>): readonly DayPhone[] {
  const late = demoLateDropoffs(...args);
  /*
   * The day's five threads (Firia, 2026-10-17 10:51 PM ET), all of them fixture facts: the two
   * afternoon late texts, and the families whose child the day recorded as *received* at their
   * stop. The late families are excluded from the second list — a family is one thread, and the
   * newest thing that happened to them is what the row shows.
   */
  const handed = demoHandoffNotices(args[0], THREADS - late.length, late.map((t) => t.childKey));
  return [...late, ...handed].sort((a, b) => b.atMs - a.atMs);
}

/** How many threads the day's list holds (mockups/family-texts.html, approvals.html: five). */
export const THREADS = 5;
