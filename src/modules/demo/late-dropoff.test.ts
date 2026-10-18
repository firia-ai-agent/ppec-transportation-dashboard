import { describe, expect, it } from "vitest";
import { demoDay } from "@/domain/board/day";
import { formatClock24 } from "@/domain/eta/eta";
import { NOTIFY_MIN_LEAD_SECONDS } from "@/domain/eta/notify-gate";
import { childByKey, stopByKey, RUNS } from "@/modules/demo/fixtures/standard";
import { etaNoticeThresholds } from "@/modules/messaging/eta-notice";
import { UNKNOWN_STOP } from "@/modules/messaging/templates";
import {
  demoLateDropoffFor,
  demoLateDropoffs,
  dueEtaNotices,
  lateDropoffReplay,
  lateDropoffSpec,
  LATE_DIRECTION,
  LATE_RUN_KEY,
} from "./late-dropoff";

/**
 * AT-03 on the afternoon: "live and replayed traffic delay (downstream only, hysteresis,
 * deterministic replay)" (PRD §18.3), from the §18.2 step 7 sentence "one damped 10-min window SMS
 * to downstream families only; jitter suppressed".
 *
 * The morning half of AT-03 is already held from both ends — src/domain/eta/replay.test.ts and
 * src/fixtures/replays.test.ts, over the step 7 stall on the committed morning track. What is new
 * here is the half a *family* actually reads: a late drop-off, the window each downstream family is
 * given, and the fact that the family already at home is told nothing.
 *
 * Pure: no database, no clock, no network. The demo day is the only day in it.
 */

const day = demoDay();
/** The two families still ahead of the stall, in the order the van reaches them. */
const DOWNSTREAM = ["C3", "C2"];
/** The family the van had already set down when it stopped. */
const ALREADY_HOME = "C9";

describe("AT-03 · the afternoon stall tells the families still ahead of it, once each", () => {
  it("texts every downstream family exactly once", () => {
    const texts = demoLateDropoffs(day);
    expect(texts.map((t) => t.childKey)).toEqual(DOWNSTREAM);
  });

  it("says nothing to the family whose child is already home", () => {
    expect(demoLateDropoffFor(ALREADY_HOME, day)).toBeUndefined();
    // …and the van really had served that stop before the stall (otherwise the rule above is
    // vacuous: a family nobody has reached yet is downstream, not served).
    const served = lateDropoffReplay(day).arrivals.map((a) => a.stopId);
    expect(served).toContain(childByKey(ALREADY_HOME).stopKey);
  });

  it("says nothing about the centre, which has no family to tell", () => {
    expect(demoLateDropoffs(day).map((t) => t.stopPlace)).not.toContain("PPEC center");
  });

  /**
   * The promise the text makes: the van arrives inside the 10-minute window the family was given.
   * A damped window that the run then misses would be worse than no text at all.
   */
  it("arrives inside the window each family was given", () => {
    const replay = lateDropoffReplay(day);
    for (const notice of dueEtaNotices(day)) {
      const stopId = childByKey(notice.childKey).stopKey!;
      const arrival = replay.arrivals.find((a) => a.stopId === stopId);
      expect(arrival, notice.childKey).toBeDefined();
      expect(arrival!.atMs, notice.childKey).toBeGreaterThanOrEqual(notice.decision.windowStartMs!);
      expect(arrival!.atMs, notice.childKey).toBeLessThanOrEqual(notice.decision.windowEndMs!);
    }
  });

  it("never texts a family whose van is nearly there (ASM-14's ten-minute lead)", () => {
    for (const notice of dueEtaNotices(day)) {
      const { decision } = notice;
      expect((decision.windowStartMs! - decision.atMs) / 1000, notice.childKey).toBeGreaterThanOrEqual(
        NOTIFY_MIN_LEAD_SECONDS,
      );
    }
  });

  it("replays the same run every time (same seed ⇒ same ETA events)", () => {
    const once = demoLateDropoffs(day);
    const twice = demoLateDropoffs(day, etaNoticeThresholds());
    expect(twice).toEqual(once);
    expect(lateDropoffSpec(day).seed).toBe(lateDropoffSpec(day).seed);
  });

  it("stays silent at a threshold the delay does not reach", () => {
    // The stall costs about eleven minutes, so a half-hour shift is a calibration that does not
    // consider this worth a text — and then nobody is texted, rather than texted differently.
    // (The §8 table's own value is the one the app runs on; this is the rule, not the setting.)
    expect(demoLateDropoffs(day, { ...etaNoticeThresholds(), shiftSeconds: 1800 })).toEqual([]);
  });
});

describe("what the family reads, and what staff read beside it", () => {
  const noah = () => demoLateDropoffFor("C2", day)!;

  /*
   * Firia, 2026-10-17 10:51 PM ET: "the auto late text has no time range and no ETA". So the
   * body is the lateness and the public place, and the panel's own `windowText` stays a *staff*
   * string — it is what the coordinator reads beside the text, which is this suite's title.
   */
  it("is the late-drop-off body, with the lateness and the public place and no time", () => {
    const text = noah();
    expect(text.templateId).toBe("dropoff.late");
    expect(text.body).toContain(`about ${text.delayMinutes} minutes late`);
    expect(text.body).toContain(stopByKey(childByKey("C2").stopKey!).label);
    /*
     * No `[DEMO]` tag and no STOP/HELP footer: this `body` is what a *staff* screen shows — the
     * bubble in the Family texts thread — and those two are the channel's furniture, appended by
     * the send pipeline on their way to a family's phone (Firia, 2026-10-17 10:51 PM ET).
     * `templates.test.ts` holds that every sent body still carries both.
     */
    expect(text.body).not.toContain("[DEMO]");
    expect(text.body).not.toContain("Reply HELP for help");
    // The window is the panel's, not the family's: it is on the staff row and not in the text.
    expect(text.windowText).not.toBe("");
    expect(text.body).not.toContain(text.windowText);
  });

  /**
   * THE CLOCK AND THE PLACE A PARENT READS (Vera's review, 2026-10-17 14:40 ET).
   *
   * The vars this text is rendered from are deliberately developer-facing: `etaNoticeVars` fills
   * `eta` from `formatClock24` ("16:30") and `stopLabel` from the stop's `smsToken`
   * ("OKEE-PARK"), because the outbox only permits constrained values and a place name is not
   * one. `renderTemplate`'s per-var display rules are the single seam that turns those two into
   * words, and nothing held that the seam was still there for *this* text.
   *
   * What was asserted above is not enough on its own. "about N minutes late" is the half of the
   * sentence with no clock and no place in it, and comparing the body against `text.windowText`
   * compares it against the panel's *own* 12-hour string — so the day the 24-hour clock reached a
   * family, that assertion would have failed on a string neither half of the app owns, and read
   * as a window bug rather than as a parent being sent "New drop-off 16:30 at OKEE-PARK".
   *
   * So: the sentence itself, exactly as a parent reads it, and then each of the two raw values
   * named and barred. The time is a 10-minute window rather than the single "4:30 PM" of Vera's
   * note because PRD §8 fixes the notified time as a window and never minute precision — the
   * 12-hour clock and the AM/PM are the part under review, and both ends carry them.
   */
  it("reads the 12-hour clock and the stop's display name, never the vars behind them", () => {
    const text = noah();
    const stop = stopByKey(childByKey("C2").stopKey!);

    // The sentence, whole: no clock at all, and the place a family can stand in (10:51 PM ET).
    expect(text.body).toContain("The drop-off is still at Okeeheelee Park.");
    // …and the place by the name the fixture gives it, so renaming the stop moves this with it.
    expect(stop.label).toBe("Okeeheelee Park");
    expect(text.body).toContain(`at ${stop.label}.`);

    for (const notice of dueEtaNotices(day)) {
      const body = demoLateDropoffFor(notice.childKey, day)!.body;
      const { decision } = notice;

      // 1. The 24-hour clock the vars carry. Named, not inferred: this is the exact string
      //    `etaNoticeVars` puts in `eta`, and "16:30" must not survive into the body.
      expect(formatClock24(decision.windowStartMs!), notice.childKey).toMatch(/^\d{2}:\d{2}$/);
      expect(body).not.toContain(formatClock24(decision.windowStartMs!));
      expect(body).not.toContain(formatClock24(decision.windowEndMs!));
      // No hour of 13–23 anywhere in it, so a *different* 24-hour value cannot slip in either.
      expect(body, notice.childKey).not.toMatch(/\b(?:1[3-9]|2[0-3]):\d{2}/);

      // 2. The stop token the vars carry, and the shape of a stop code in general.
      expect(notice.stopToken, notice.childKey).toMatch(/^[A-Z][A-Z-]+$/);
      expect(body).not.toContain(notice.stopToken);
      expect(body, notice.childKey).not.toMatch(/\b[A-Z]{3,}-[A-Z]{3,}\b/);
      // The place is there under its own name, and it is not the fallback for a token with no copy.
      expect(body).toContain(stopByKey(childByKey(notice.childKey).stopKey!).label);
      expect(body, notice.childKey).not.toContain(UNKNOWN_STOP);

      /*
       * 3. No clock a parent could read as an arrival, in either direction — which is the
       *    stronger form of what this block was written for. Firia, 10:51 PM ET: the late text
       *    carries no time range and no ETA, and `dropoff.late`'s allowlist permits neither, so
       *    there is no value a caller could put one in through.
       */
      expect(body, notice.childKey).not.toMatch(/\d{1,2}:\d{2}/);
      expect(body, notice.childKey).not.toContain("\u2013");
    }
  });

  it("names the child and nothing internal in the body (Veri #12, COPY-GUIDE §2)", () => {
    for (const text of demoLateDropoffs(day)) {
      /*
       * The child **is** named, from their own row, since Firia's 10:51 PM ET ruling of
       * 2026-10-17 ("the model draft is human and uses the child's name"). Veri #12's rule is
       * untouched and is about a name a *caller* chose: no var carries one, and
       * `templates.test.ts` is the lock on that door. Nobody else is named — not the guardian,
       * who is who is holding the phone.
       */
      expect(text.body).toContain(text.childFirstName);
      expect(text.body).not.toContain(text.guardianFirstName);
      expect(text.body).not.toMatch(/\bF\d{1,2}\b|\bC\d{1,2}\b|\bS\d\b|\bR\d\b/);
      expect(text.body).not.toMatch(/ETA|threshold|NOTIFY|SUPPRESS|PM\b.*window/i);
      // The stop token itself never reaches a family; the place name does.
      expect(text.body).not.toContain(stopByKey(childByKey(text.childKey).stopKey!).smsToken);
    }
  });

  it("gives the panel the people and the van by name", () => {
    const text = noah();
    expect(text.childLabel).toBe("Noah O.");
    expect(text.childFirstName).toBe("Noah");
    expect(text.guardianName).toBe("Dara O.");
    expect(text.relationship).toBe("parent");
    // A fiction number from the MOCKS §3 block, and the one this family is reachable on.
    expect(text.phone).toMatch(/^\+1-561-555-01\d\d$/);
    expect(text.vanLabel).toBe("V2 center van");
    // Display-ready: the provider is the company a coordinator names out loud, and the ADR-015
    // `SYN ` marker stays in the fixture row it came from (copy.providerDisplayName).
    expect(text.providerName).toBe("Greenacres center fleet");
  });

  it("is on the run the scenario puts that child on", () => {
    expect(RUNS.find((r) => r.key === LATE_RUN_KEY)!.childKeys).toContain("C2");
    expect(LATE_DIRECTION).toBe("PM");
  });

  it("went out during the demo day, in the afternoon", () => {
    for (const text of demoLateDropoffs(day)) {
      expect(formatClock24(text.atMs) > "12:00", formatClock24(text.atMs)).toBe(true);
      expect(formatClock24(text.atMs) < "17:30").toBe(true);
    }
  });
});

describe("one list, two readers", () => {
  /**
   * The panel renders these decisions and the sweep queues them. If the two lists could differ,
   * the demo would show a text the message log does not hold — which is the one thing a founder
   * walking the thread would catch.
   */
  it("hands the sweep exactly the crossings the panel shows", () => {
    const panel = demoLateDropoffs(day);
    const sweep = dueEtaNotices(day);
    expect(sweep.map((d) => d.childKey)).toEqual(panel.map((t) => t.childKey));
    expect(sweep.map((d) => d.decision.windowText)).toEqual(panel.map((t) => t.windowText));
    for (const d of sweep) {
      expect(d.direction).toBe(LATE_DIRECTION);
      expect(d.stopToken).toBe(stopByKey(childByKey(d.childKey).stopKey!).smsToken);
      expect(d.decision.outcome).toBe("NOTIFY");
    }
  });
});
