import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { demoDay } from "@/domain/board/day";
import { buildBoard } from "@/domain/board/board";
import { demoLateDropoffs } from "@/modules/demo/late-dropoff";
import { drawer, fill, phonePanel, places, sourceMode } from "@/ui/copy";
import { outboundStates } from "@/ui/states";
import { LegDrawer } from "../today/LegDrawer";
import { PhonePanel } from "./PhonePanel";
import { e164Of, phoneLabel, type Thread } from "./thread";

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

const panelHtml = (thread: Thread = scenarioThread): string =>
  renderToStaticMarkup(
    createElement(PhonePanel, { phones, selected: noah, thread, dayLabel: day.label }),
  );

describe("the phone panel reads like a text thread", () => {
  const html = panelHtml();

  it("names the adult, the child and the number the thread belongs to", () => {
    expect(html).toContain(esc(phonePanel.heading));
    expect(html).toContain(noah.guardianName);
    expect(html).toContain(phoneLabel(noah));
    // The dialling form the fixture stores is not what a screen prints.
    expect(html).not.toContain(noah.phone);
    expect(html).toContain(
      esc(fill(phonePanel.threadWho, {
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
    expect(html).toContain(fill(phonePanel.dayLine, { date: day.label }));
    expect(html).toContain("4:08 PM");
  });

  it("shows the body the outbox would send, word for word", () => {
    expect(html).toContain(esc(noah.body));
    // …which is the one that says "your child" rather than naming them (Veri #12).
    expect(noah.body).not.toContain(noah.childFirstName);
  });

  it("carries the §6.3 simulated-phone banner and the §7.1 record chip", () => {
    expect(html).toContain(phonePanel.simulatedPhone);
    expect(html).toContain('data-token="src-sim"');
    expect(html).toContain(sourceMode.SIMULATED);
  });

  it("says the bubbles came from the scenario, and shows no delivery it cannot know", () => {
    expect(html).toContain(esc(phonePanel.fromScenario));
    expect(html).not.toContain(esc(phonePanel.fromLog));
    for (const state of Object.values(outboundStates)) {
      expect(html, state.label).not.toContain(`>${state.label}<`);
    }
  });

  it("offers one tab per family the day texted, with the open one marked", () => {
    expect(phones.length).toBeGreaterThan(1);
    for (const phone of phones) {
      expect(html).toContain(`?child=${phone.childKey}`);
      expect(html).toContain(
        esc(fill(phonePanel.tab, { adult: phone.guardianName, child: phone.childFirstName })),
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
    expect(html).toContain(esc(phonePanel.fromLog));
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
    expect(html).toContain("/phone-preview?child=C2");
    expect(html).toContain(esc(fill(drawer.openTexts, { child: "Noah O." })));
  });

  it("says plainly that nothing was texted, rather than linking to an empty phone", () => {
    const html = drawerHtml("C1", false);
    expect(html).not.toContain("/phone-preview");
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
