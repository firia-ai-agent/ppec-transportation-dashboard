import Link from "next/link";
import { MessagesSquare } from "lucide-react";
import type { LateDropoff } from "@/modules/demo/late-dropoff";
import { fill, phonePanel, places } from "@/ui/copy";
import { SourceBadge } from "@/ui/SourceBadge";
import { StateChip } from "@/ui/StateChip";
import { icon } from "@/ui/tokens";
import { phoneLabel, type Bubble, type Thread } from "./thread";
import styles from "./phone.module.css";

/**
 * The parent phone panel (DESIGN-DIRECTION §6.3): a phone-shaped frame, one tab per family the
 * day texted, and the thread inside it as a family reads it.
 *
 * What it is for: the founder clicks from a child on the board to the text that went out, and
 * reads the actual words. So the bubbles are the real bodies — rendered by the outbox's own
 * renderer, "your child" and all (Veri #12) — while everything *around* them names people, the
 * way every other staff screen does (COPY-GUIDE §1, D-3): the adult who holds the phone, the
 * child the texts are about, the van and the provider that drives it.
 *
 * Three rules it keeps, each one a thing that would make the panel dishonest if it broke:
 *  - it says **where the thread came from** (the message log, or the demo day's own replay), in a
 *    sentence rather than a badge nobody can expand (`thread.ts` chooses, this renders);
 *  - a message that did not leave the center is **never drawn as if it arrived** — a blocked or
 *    out-of-date row keeps its §3 state and loses the "delivered" styling (demo step 10);
 *  - the DEMO bar and the one source chip in the header are the **root layout's** (§7, §7.1), so
 *    this screen mounts neither. The Simulated chip here is the §7.1 *record* chip — a phone is a
 *    record — beside the §6.3 "Simulated phone" banner the panel carries of its own.
 */
export function PhonePanel({
  phones,
  selected,
  thread,
  dayLabel,
  composer,
}: {
  /** One per family the day has a text for; the tabs. */
  phones: readonly LateDropoff[];
  selected: LateDropoff;
  thread: Thread;
  /** The service day the thread is from, as the board names it. */
  dayLabel: string;
  /** Where a staff-typed message goes, when that half of the demo is on screen. */
  composer?: React.ReactNode;
}) {
  return (
    <main className={styles.page}>
      <header className={styles.titleRow}>
        <h1 className={styles.heading}>{phonePanel.heading}</h1>
        <p className={styles.intro}>{phonePanel.intro}</p>
      </header>

      {phones.length > 1 ? (
        <nav className={styles.tabs} aria-label={phonePanel.pickPhone}>
          {phones.map((phone) => (
            <Link
              key={phone.childKey}
              href={`?child=${phone.childKey}`}
              className={styles.tab}
              aria-current={phone.childKey === selected.childKey ? "page" : undefined}
            >
              {fill(phonePanel.tab, { adult: phone.guardianName, child: phone.childFirstName })}
            </Link>
          ))}
        </nav>
      ) : null}

      <div className={styles.columns}>
      {/* §6.3: an iPhone-shaped panel with no Apple marks — a frame, a notch bar, a thread. */}
      <section className={styles.phone} aria-label={phonePanel.simulatedPhone}>
        <div className={styles.simBanner}>
          <MessagesSquare size={icon.inline} aria-hidden="true" />
          <span>{phonePanel.simulatedPhone}</span>
          {/* §7.1: a record carries its source. A phone is a record. */}
          <SourceBadge mode="SIMULATED" className={styles.simChip} />
        </div>

        <header className={styles.threadHeader}>
          <h2 className={styles.threadHeading}>
            {fill(phonePanel.threadHeading, {
              adult: selected.guardianName,
              phone: phoneLabel(selected),
            })}
          </h2>
          <p className={styles.threadWho}>
            {fill(phonePanel.threadWho, {
              adult: selected.guardianName,
              child: selected.childFirstName,
              relationship: selected.relationship,
            })}
          </p>
          <p className={styles.threadRide}>
            {fill(phonePanel.rideLine, {
              child: selected.childFirstName,
              van: selected.vanLabel,
              provider: selected.providerName,
              place: selected.stopPlace,
            })}
          </p>
          <p className={styles.threadDay}>{fill(phonePanel.dayLine, { date: dayLabel })}</p>
        </header>

        <ol className={styles.thread}>
          {thread.bubbles.length === 0 ? (
            <li className={styles.empty}>{phonePanel.empty}</li>
          ) : (
            thread.bubbles.map((bubble) => (
              <Bubble key={bubble.id} bubble={bubble} adult={selected.guardianName} />
            ))
          )}
        </ol>

        {/* Which of the two sources this thread is, in a sentence (see thread.ts). */}
        <p className={styles.source} data-source={thread.source}>
          {thread.source === "log" ? phonePanel.fromLog : phonePanel.fromScenario}
        </p>
      </section>

      {/*
        The assistant's side, beside the phone rather than inside it: the thread is the family's
        and this is the centre's. Typing happens here because a coordinator is standing in for the
        family, and the composer says whose phone it is writing from.
      */}
      {composer}
      </div>
    </main>
  );
}

/**
 * One message. The center's side is aligned one way and the family's the other, and the side is
 * never the only cue: each bubble says who it is from above the words, because "whose message is
 * this" is the one thing a screenshot of a thread has to answer on its own (§9).
 */
function Bubble({ bubble, adult }: { bubble: Bubble; adult: string }) {
  // The center's side of a thread says the center, never a person (COPY-GUIDE §7: the centre is
  // named and never addressed), and the words are the ones every other screen uses for it.
  const who = bubble.direction === "OUT" ? places.center : adult;
  return (
    <li className={styles.bubbleRow} data-direction={bubble.direction} data-reached={bubble.reachedPhone}>
      <p className={styles.bubbleWho}>{who}</p>
      <p className={styles.bubble}>{bubble.body}</p>
      <p className={`${styles.bubbleMeta} tabularNums`}>
        <span className="srOnly">{fill(phonePanel.timeLabel, { time: bubble.timeLabel })}</span>
        <span aria-hidden="true">{bubble.timeLabel}</span>
        {/* §6.3: the ticks under the bubble — Queued → Sent → Delivered, in §3's own words. */}
        {bubble.delivery ? <StateChip state={bubble.delivery} /> : null}
      </p>
    </li>
  );
}
