import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  adapters,
  board,
  countable,
  demoBanner,
  fill,
  liveUpdates,
  login,
  mapPreview,
  nav,
  notFound,
  pluralize,
  rampPreview,
  sentence,
  scenarioClock,
  screenReader,
  search,
  securement,
  sourceMode,
  unbuilt,
  whoami,
} from "./copy";

/**
 * COPY-GUIDE.md is the source of truth for words. These assertions pin the strings the guide
 * fixes verbatim, so a well-meaning rewrite in a component cannot quietly change them.
 */
describe("COPY-GUIDE strings, verbatim", () => {
  it("§6: the banner reads exactly DEMO, and so does its screen-reader label", () => {
    // Founder decision, 2026-10-14 13:18 ET (ledger row 40), "incl. screen-reader label":
    // COPY-GUIDE §6 and DESIGN-DIRECTION §7 both write aria-label "DEMO", not a paraphrase.
    expect(demoBanner.text).toBe("DEMO");
    expect(demoBanner.ariaLabel).toBe("DEMO");
  });

  it("§2 of DESIGN-DIRECTION: the four nav labels", () => {
    expect(nav.today).toBe("Today");
    expect(nav.exceptions).toBe("Exceptions & Approvals");
    expect(nav.setup).toBe("Setup");
    expect(nav.health).toBe("Health & ROI");
  });

  it("§5: search has a visible label and a hint-only placeholder", () => {
    expect(search.label).toBe("Search");
    expect(search.placeholder).toBe("Child, route or vehicle");
  });

  it("§5: the live-updates-down text, with no jargon", () => {
    expect(liveUpdates.downBody).toBe(
      "Live updates paused. Reconnecting… Board may be up to 40 s old.",
    );
    expect(liveUpdates.downBody).not.toMatch(/SSE/);
  });

  it("§5 SURF-01: the board's empty state, with a date placeholder", () => {
    expect(board.empty).toBe(
      "No rides scheduled for {date}. Change the date or reset the demo.",
    );
    expect(fill(board.empty, { date: "Tue, Oct 14" })).toBe(
      "No rides scheduled for Tue, Oct 14. Change the date or reset the demo.",
    );
  });

  it("§6.1: the five source-mode labels", () => {
    expect(sourceMode).toEqual({
      SIMULATED: "Simulated",
      REPLAY: "Replay",
      MANUAL: "Manual entry",
      SANDBOX: "Sandbox",
      LIVE: "Live",
    });
  });

  it("§5: the interim adapter pills read '<adapter> · Simulated'", () => {
    expect(adapters.simulatedValue).toBe("Simulated");
    expect([adapters.sms, adapters.teams, adapters.gps, adapters.agent]).toEqual([
      "SMS",
      "Teams",
      "GPS",
      "Agent",
    ]);
    expect(`${adapters.sms}${adapters.separator}${adapters.simulatedValue}`).toBe(
      "SMS · Simulated",
    );
  });

  it("§9: chips and badges announce themselves as 'State: …' and 'Source: …'", () => {
    expect(fill(screenReader.state, { label: "Needs action" })).toBe("State: Needs action");
    expect(fill(screenReader.source, { label: "Simulated" })).toBe("Source: Simulated");
  });

  it("§1: no exclamation marks, no emoji, sentence case bodies", () => {
    const emoji = /\p{Extended_Pictographic}/u;
    for (const [key, value] of allStrings()) {
      expect(value.includes("!"), `${key} shouts`).toBe(false);
      expect(emoji.test(value), `${key} has an emoji`).toBe(false);
    }
  });

  it("§2: no banned word reaches a user-facing string", () => {
    // Jargon list from COPY-GUIDE §2, matched as whole words so "Setup" and "Legs" are safe.
    const banned = [
      "wheelchair-bound",
      "special needs",
      "handicapped",
      "suffers from",
      "victim of",
      "unload",
      "cargo",
      "patient",
      "abandoned",
      "stranded",
      "ASAP",
      "oops",
      "idempotency",
      "webhook",
      "outbox",
      "SSE",
    ];
    // Whole words (plus a plural), as the list above intends: a substring match reads "SSE"
    // inside "passed" and "patient" inside "patiently", which would ban plain English.
    for (const [key, value] of allStrings()) {
      for (const word of banned) {
        const pattern = new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:s|es)?\\b`, "i");
        expect(pattern.test(value), `${key} uses "${word}"`).toBe(false);
      }
    }
  });

  it("says in plain words what each not-yet-built surface will do", () => {
    // What it must NOT say is covered by no-internals.test.ts: no build-step codes.
    for (const body of [unbuilt.today, unbuilt.exceptions, unbuilt.setup, unbuilt.health]) {
      expect(body).toMatch(/^[A-Z].*\.$/);
    }
    expect(unbuilt.tag).toBe("Not built yet");
  });

  it("§5 SURF-04: the ramp strings the guide fixes verbatim", () => {
    expect(rampPreview.offlinePill).toBe(
      "Offline · {count} saved on this iPad. They'll send when Wi-Fi is back.",
    );
    expect(fill(rampPreview.offlinePill, { count: 3 })).toBe(
      "Offline · 3 saved on this iPad. They'll send when Wi-Fi is back.",
    );
    // §5: "Boarding confirmed for Leo B." — one period, not two, after the last initial.
    expect(sentence(fill(rampPreview.snackBoarded, { child: "Leo B." }))).toBe(
      "Boarding confirmed for Leo B.",
    );
    expect(sentence(fill(rampPreview.snackLeftEarly, { child: "Mia R." }))).toBe(
      "Mia R. marked left early.",
    );
    expect(rampPreview.recordedLate).toBe("Recorded late");
    expect(rampPreview.whoPickedUp).toBe("Who picked up?");
    expect(rampPreview.liftRow).toBe("Lift works?");
    expect(rampPreview.latchRow).toBe("Car-seat anchors (LATCH)");
    expect(Object.values(rampPreview.answer)).toEqual(["Yes", "No", "Not sure"]);
    // §5 SURF-02, reused on the rider card: a transport need is never a diagnosis.
    expect(rampPreview.needsCaption).toBe("Derived from intake, not a diagnosis.");
  });

  it("§5 SURF-04: no free-text names in the pickup role list", () => {
    expect(rampPreview.pickupRoles).toEqual([
      "Parent or guardian",
      "Approved adult on the pickup list",
      "PPEC staff",
    ]);
  });

  it("the sign-in intro is the one sentence the review fixed", () => {
    expect(login.intro).toBe("Demo accounts only.");
  });

  it("never claims the sign-in error was the email or the password", () => {
    expect(login.error).toBe("Email or password is incorrect.");
  });

  it("§1: the scenario clock says the demo has not started, and why Start is inert", () => {
    expect(scenarioClock.notStarted).toBe("Demo not started");
    expect(scenarioClock.start).toBe("Start");
    expect(scenarioClock.startUnavailable).toBe("Demo controls aren't connected yet.");
  });
});

describe("pluralize", () => {
  it("never prints a bare count", () => {
    expect(pluralize(1, countable.wheelchair)).toBe("1 wheelchair");
    expect(pluralize(2, countable.wheelchair)).toBe("2 wheelchairs");
    expect(pluralize(0, countable.walkingSeat)).toBe("0 walking seats");
    expect(pluralize(1, countable.wcPosition)).toBe("1 wheelchair position");
  });
});

describe("sentence", () => {
  it("adds the full stop a name's initial already supplied, and only then", () => {
    expect(sentence("Boarding confirmed for Leo B.")).toBe("Boarding confirmed for Leo B.");
    expect(sentence("Boarding confirmed for Leo")).toBe("Boarding confirmed for Leo.");
    expect(sentence("Who picked up?")).toBe("Who picked up?");
  });
});

describe("fill", () => {
  it("replaces named placeholders", () => {
    expect(fill("Handed off to {receiver role}", { "receiver role": "parent" })).toBe(
      "Handed off to parent",
    );
  });

  it("leaves unknown placeholders visible rather than printing undefined", () => {
    expect(fill("Snoozed until {time}", {})).toBe("Snoozed until {time}");
  });

  it("accepts numbers", () => {
    expect(fill("Approved v{n}", { n: 3 })).toBe("Approved v3");
  });
});

/* ───────────────────────── components hold no user-facing text ───────────────────────── */

const SRC = path.resolve(__dirname, "..");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return walk(full);
    return full.endsWith(".tsx") ? [full] : [];
  });
}

/** Comments are prose about the design, not rendered text; drop them before scanning. */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

describe("no user-facing string literals in components", () => {
  const files = walk(SRC);

  it("scans every .tsx file", () => {
    expect(files.length).toBeGreaterThan(8);
  });

  it.each(files.map((f) => path.relative(SRC, f)))("%s has no JSX text node", (relative) => {
    const body = stripComments(readFileSync(path.join(SRC, relative), "utf8"));
    // Text sitting between tags on one line, e.g. <h1>Today</h1>. Rendered copy must arrive
    // through an expression from src/ui/copy.ts instead.
    const hits = [...body.matchAll(/>([^<>{}\n]*[A-Za-z]{2}[^<>{}\n]*)</g)]
      .map((m) => m[1].trim())
      .filter((s) => s.length > 0);
    expect(hits).toEqual([]);
  });

  it.each(files.map((f) => path.relative(SRC, f)))(
    "%s has no user-facing attribute literal",
    (relative) => {
      const body = stripComments(readFileSync(path.join(SRC, relative), "utf8"));
      const hits = [
        ...body.matchAll(/\b(aria-label|aria-description|placeholder|title|alt)="([^"]+)"/g),
      ].map((m) => `${m[1]}="${m[2]}"`);
      expect(hits).toEqual([]);
    },
  );
});

/** Every leaf string exported from copy.ts, flattened with a dotted key for messages. */
function allStrings(): Array<[string, string]> {
  const copy: Record<string, unknown> = {
    adapters,
    board,
    countable,
    demoBanner,
    liveUpdates,
    login,
    mapPreview,
    nav,
    notFound,
    rampPreview,
    scenarioClock,
    search,
    securement,
    sourceMode,
    unbuilt,
    whoami,
  };
  const out: Array<[string, string]> = [];
  const visit = (prefix: string, value: unknown) => {
    if (typeof value === "string") {
      out.push([prefix, value]);
      return;
    }
    if (value && typeof value === "object") {
      for (const [k, v] of Object.entries(value)) visit(prefix ? `${prefix}.${k}` : k, v);
    }
  };
  visit("", copy);
  return out;
}
