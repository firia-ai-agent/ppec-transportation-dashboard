import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { demoDay } from "@/domain/board/day";
import { buildBoard } from "@/domain/board/board";
import { demoLateDropoffs } from "@/modules/demo/late-dropoff";
import { drawer, fill, familyTexts, places, sourceMode } from "@/ui/copy";
import { outboundStates } from "@/ui/states";
import { LegDrawer } from "../today/LegDrawer";
import { PhonePanel } from "./PhonePanel";
import { LiveTurnContext, type LiveTurn } from "./live-turn";
import phoneStyles from "./phone.module.css";
import { e164Of, faultLine, phoneLabel, threadFor, type Thread } from "./thread";

/**
 * The parent phone panel as markup (DESIGN-DIRECTION §6.3), and the one click that reaches it.
 *
 * Rendered rather than described: the whole point of this screen is that a founder reads the text
 * a family got, so what is asserted is the words on it — the real names around the thread, the
 * real body inside it, the real time under it, and the sentence that says which source the
 * bubbles came from. No browser and no database: the projection is pure.
 */

const day = demoDay();
const phones = demoLateDropoffs(day);
const noah = phones.find((p) => p.childKey === "C2")!;

const scenarioThread: Thread = {
  source: "scenario",
  bubbles: [
    {
      id: "one",
      direction: "OUT",
      timeLabel: "4:08 PM",
      body: noah.body,
      delivery: null,
      reachedPhone: true,
    },
  ],
};

/** React escapes an apostrophe in text; the copy has several, so compare on the escaped form. */
const esc = (text: string): string => text.replace(/'/g, "&#x27;");

/**
 * An idle turn, which is what the panel has before anybody types. The provider is mounted by the
 * page in production (`page.tsx`), so every render of the panel has one above it — and the thread's
 * live half reads it rather than guessing (`live-turn.ts`).
 */
const IDLE: LiveTurn = {
  turnState: { status: "idle" },
  submitTurn: () => {},
  turnPending: false,
  approval: { status: "idle" },
  submitApproval: () => {},
  approvalPending: false,
  declined: false,
  decline: () => {},
};

const panelHtml = (thread: Thread = scenarioThread): string =>
  renderToStaticMarkup(
    createElement(
      LiveTurnContext.Provider,
      { value: IDLE },
      createElement(PhonePanel, { phones, selected: noah, thread, dayLabel: day.label }),
    ),
  );

describe("the phone panel reads like a text thread", () => {
  const html = panelHtml();

  it("names the adult, the child and the number the thread belongs to", () => {
    expect(html).toContain(esc(familyTexts.heading));
    expect(html).toContain(noah.guardianName);
    expect(html).toContain(phoneLabel(noah));
    // The dialling form the fixture stores is not what a screen prints.
    expect(html).not.toContain(noah.phone);
    expect(html).toContain(
      esc(fill(familyTexts.threadWho, {
        adult: noah.guardianName,
        child: noah.childFirstName,
        relationship: noah.relationship,
      })),
    );
  });

  it("names the van and the provider that drives the ride", () => {
    expect(html).toContain(noah.vanLabel);
    expect(html).toContain(noah.providerName);
    expect(html).toContain(noah.stopPlace);
  });

  it("carries the day the thread is from, and a real time under the bubble", () => {
    expect(html).toContain(fill(familyTexts.dayLine, { date: day.label }));
    expect(html).toContain("4:08 PM");
  });

  it("shows the body the outbox would send, word for word", () => {
    expect(html).toContain(esc(noah.body));
    // …which is the one that says "your child" rather than naming them (Veri #12).
    expect(noah.body).not.toContain(noah.childFirstName);
  });

  it("carries the §6.3 simulated-phone banner and the §7.1 record chip", () => {
    expect(html).toContain(familyTexts.simulatedPhone);
    expect(html).toContain('data-token="src-sim"');
    expect(html).toContain(sourceMode.SIMULATED);
  });

  it("says the bubbles came from the scenario, and shows no delivery it cannot know", () => {
    expect(html).toContain(esc(familyTexts.fromScenario));
    expect(html).not.toContain(esc(familyTexts.fromLog));
    for (const state of Object.values(outboundStates)) {
      expect(html, state.label).not.toContain(`>${state.label}<`);
    }
  });

  it("offers one tab per family the day texted, with the open one marked", () => {
    expect(phones.length).toBeGreaterThan(1);
    for (const phone of phones) {
      expect(html).toContain(`?child=${phone.childKey}`);
      expect(html).toContain(
        esc(fill(familyTexts.tab, { adult: phone.guardianName, child: phone.childFirstName })),
      );
    }
    expect(html.match(/aria-current="page"/g)).toHaveLength(1);
  });

  it("mounts no second DEMO bar and no second screen-level chip (§7, §7.1)", () => {
    // The root layout owns both. The panel's own chip is the record one, inside the frame.
    expect(html).not.toContain('role="status"');
    expect(html.match(/data-token="src-sim"/g)).toHaveLength(1);
  });
});

describe("the thread from the message log", () => {
  const logThread: Thread = {
    source: "log",
    bubbles: [
      { id: "in", direction: "IN", timeLabel: "4:02 PM", body: "where is the van", delivery: null, reachedPhone: true },
      { id: "out", direction: "OUT", timeLabel: "4:08 PM", body: noah.body, delivery: outboundStates.DELIVERED, reachedPhone: true },
      { id: "blocked", direction: "OUT", timeLabel: "4:12 PM", body: noah.body, delivery: outboundStates.BLOCKED_EGRESS, reachedPhone: false },
    ],
  };
  const html = panelHtml(logThread);

  it("says where the bubbles came from, and shows each one's delivery", () => {
    expect(html).toContain(esc(familyTexts.fromLog));
    expect(html).toContain(outboundStates.DELIVERED.label);
    expect(html).toContain(outboundStates.BLOCKED_EGRESS.label);
  });

  it("never draws a message that did not leave the center as one that arrived (demo step 10)", () => {
    expect(html).toContain('data-reached="false"');
    expect(html.match(/data-reached="true"/g)).toHaveLength(2);
  });

  it("says who each bubble is from, so the side is not the only cue", () => {
    expect(html).toContain(places.center);
    expect(html).toContain(noah.guardianName);
  });
});

describe("the one click that gets there", () => {
  const board = buildBoard(day);
  const legsOf = (key: string) => board.legs.filter((l) => l.child.childKey === key);
  const drawerHtml = (key: string, hasTexts: boolean) =>
    renderToStaticMarkup(
      createElement(LegDrawer, { legs: legsOf(key), day, hasTexts, onClose: () => {} }),
    );

  it("offers the family's thread from the child's drawer", () => {
    const html = drawerHtml("C2", true);
    expect(html).toContain(drawer.textsHeading);
    expect(html).toContain("/family-texts?child=C2");
    expect(html).toContain(esc(fill(drawer.openTexts, { child: "Noah O." })));
  });

  it("says plainly that nothing was texted, rather than linking to an empty phone", () => {
    const html = drawerHtml("C1", false);
    expect(html).not.toContain("/family-texts");
    expect(html).toContain(esc(fill(drawer.noTexts, { child: "Mia R." })));
  });

  it("offers it for exactly the children the day texted", () => {
    const texted = demoLateDropoffs(day).map((t) => t.childKey);
    expect(texted).toContain("C2");
    expect(texted).not.toContain("C1");
  });
});

describe("the number the panel asks the message log for", () => {
  it("is the fixture's own phone, in the form the persona route takes", () => {
    expect(e164Of(noah)).toBe("+15615550102");
  });

  it("and shows it in the form a person reads", () => {
    expect(phoneLabel(noah)).toBe("(561) 555-0102");
  });
});

/**
 * A LOG THAT COULD NOT BE READ IS NOT A DAY THAT HAS NOT RUN (Veri's S3 note).
 *
 * `threadFor` used to funnel a thrown database read into the same `scenario` source as an empty
 * mailbox, so the panel said "the demo day hasn't run yet" when the truth was "we could not read
 * your message log". The first is a claim about the day; the second is a fault in the system. A
 * coordinator deciding whether a family was actually told needs to know which one they are
 * looking at.
 *
 * Driven through the real `threadFor` with a database that throws, so what is asserted is the
 * module's own choice and not a hand-made source value.
 */
describe("a message log that cannot be read says so", () => {
  const throwingDb = () => ({
    query: async () => {
      throw new Error("getaddrinfo ENOTFOUND db.example.internal");
    },
    tx: async () => {
      throw new Error("no");
    },
  }) as never;

  const reading = { dropoff: noah, pepper: "test-pepper", userId: "01900000-0000-7000-8000-00000000abcd" };

  it("comes back as its own source, with the projection still on screen", async () => {
    const thread = await threadFor(throwingDb, reading);

    expect(thread.source).toBe("logUnreadable");
    // Not a blank thread: the words are the same outbox copy the day would send.
    expect(thread.bubbles).toHaveLength(1);
    expect(thread.bubbles[0].body).toBe(noah.body);
    // And no delivery state, because nothing was sent and nothing is known about what was.
    expect(thread.bubbles[0].delivery).toBeNull();
  });

  it("says that, and not that the day has not run", async () => {
    const html = panelHtml(await threadFor(throwingDb, reading));

    expect(html).toContain(esc(familyTexts.logUnreadable));
    expect(html).not.toContain(esc(familyTexts.fromScenario));
    expect(html).not.toContain(esc(familyTexts.fromLog));
  });

  /** No session is not a fault: there is nothing to read, and the day is the honest answer. */
  it("still says the day has not run when there was simply nothing to ask with", async () => {
    const thread = await threadFor(throwingDb, { ...reading, userId: undefined });
    expect(thread.source).toBe("scenario");
    expect(panelHtml(thread)).toContain(esc(familyTexts.fromScenario));
  });

  /**
   * The fault reaches the server log and the credential does not. A driver that cannot reach its
   * host quotes the whole DSN back, so the one line that is written strips it.
   */
  it("strips a connection string out of the line it logs", () => {
    const dsn = "postgresql://ppec:sup3rs3cret@db.example.internal:5432/ppec";
    const line = faultLine(new Error(`connection to ${dsn} failed`));

    expect(line).not.toContain("sup3rs3cret");
    expect(line).toContain("[redacted]@");
    // Still useful: the class of the fault and the host it was about.
    expect(line).toContain("Error:");
    expect(line).toContain("db.example.internal");
  });
});

/**
 * THE ASSISTANT'S REPLY LANDS IN THE THREAD (demo item 2c; PRD §18.2 steps 9–10).
 *
 * A coordinator types a text as the family and the assistant answers. "What did we say to them" is
 * a question a person asks of the *thread* — so the pair renders inside the phone frame, under the
 * bubbles already there, and not in a card beside it. `LiveTurn.tsx` is how one turn reaches two
 * places; this is the assertion that it reaches the right one.
 *
 * Rendered through `LiveTurnProvider` with a turn in it, because the whole point is placement: what
 * is read off the markup is which element the bubbles are inside.
 */
describe("the turn a coordinator drives appears in the thread", () => {
  const typed = "Can Noah be dropped at grandma's at 5?";
  const reply = "PPEC: Your child's van on October 14 changed. New drop-off around 5:00 PM at Okeeheelee Park.";

  /** The frame's own markup: everything from the phone section's open tag onwards. */
  const phoneFrame = (html: string): string => {
    const open = html.indexOf(`class="${phoneStyles.phone}"`);
    expect(open, "the phone frame is in the markup").toBeGreaterThan(-1);
    return html.slice(open);
  };

  /** A turn, as the provider would hand it over. Only the two fields the thread reads matter. */
  const turnValue = (typed: string | null, reply: string | null): LiveTurn => ({
    turnState: typed === null
      ? { status: "idle" }
      : { status: "answered", childKey: noah.childKey, text: typed, turn: {} as never },
    submitTurn: () => {},
    turnPending: false,
    approval: reply === null
      ? { status: "idle" }
      : { status: "approved", applied: { reply: { body: reply } } as never },
    submitApproval: () => {},
    approvalPending: false,
    declined: false,
    decline: () => {},
  });

  /** The panel, rendered inside a turn. The composer is not the subject here; placement is. */
  const withTurn = (typed: string | null, reply: string | null): string =>
    renderToStaticMarkup(
      createElement(
        LiveTurnContext.Provider,
        { value: turnValue(typed, reply) },
        createElement(PhonePanel, {
          phones,
          selected: noah,
          thread: scenarioThread,
          dayLabel: day.label,
          composer: null,
        }),
      ),
    );

  it("renders the family's text and the reply as bubbles, inside the phone frame", () => {
    const html = withTurn(typed, reply);

    // Both bubbles are present, and both are inside the frame rather than beside it.
    const frame = phoneFrame(html);
    expect(frame).toContain(esc(typed));
    expect(frame).toContain(esc(reply));
    // Under the logged bubble, not above it: the conversation continues, it does not restart.
    expect(frame.indexOf(esc(noah.body))).toBeLessThan(frame.indexOf(esc(typed)));
    // The family's side and the centre's side, each labelled, so neither reads as the other.
    expect(frame).toContain(esc(noah.guardianName));
    expect(frame).toContain(esc(places.center));
  });

  /**
   * §11.2: a proposal is not a message. A thread that showed the draft before a person approved it
   * would be showing a family a text nobody had agreed to send.
   */
  it("shows the family's text but no reply until a person has approved one", () => {
    const html = withTurn(typed, null);
    expect(html).toContain(esc(typed));
    expect(html).not.toContain(esc(reply));
  });

  /** And neither live bubble claims a time or a delivery state, because nothing was sent. */
  it("says why this session's bubbles carry no time and no delivery", () => {
    const html = withTurn(typed, reply);
    expect(html).toContain(esc(familyTexts.liveNote));
  });

  it("renders nothing at all before a turn has been driven", () => {
    const html = withTurn(null, null);
    expect(html).not.toContain(esc(familyTexts.liveNote));
  });
});
