/**
 * NO INTERNAL CODE REACHES THE LIVE MAP — scanned on the real markup, not inferred from source.
 *
 * Layer 2 (behaviour), per /workspace/ppec-redesign/MOCKUP-TEST-CONTRACT.md §Rules 6, which makes
 * this a global check on every screen and role: no V1–V4, no "Provider P1", no SYN, no raw ids,
 * no 24-hour times. COPY-GUIDE §1–§2 is the standing rule; Vera's walk of 2026-10-18 12:30 AM ET
 * is the S1 — she found "V1 · Convertible van", "Provider P1" and "V2 · Live 2 s" on this screen.
 *
 * The founder's mockup has the answer in one line (mockups/live-map.html `.van .t`): a van is
 * "Van 2" and a driver's name beside it. Not an id, not a vehicle description, not a vendor.
 *
 * **Why this is a vitest and not only a browser check.** A code on a screen is interpolated out
 * of a fixture at render time — it is neither a literal in a component nor a string in copy.ts,
 * so none of the greps in src/ui/no-codes.test.ts can see it. Rendering the screen is the only
 * way to read what a founder reads. e2e/live-map.spec.ts makes the same assertions in a real
 * browser at 390 and 1440 and for each role; this one runs on every commit, in a second, and
 * walks the whole simulated day rather than one pinned instant.
 *
 * The map pane is mocked: it is a WebGL canvas that draws no DOM text, and mounting MapLibre in
 * a test environment proves nothing about words. Its own labels — the van number in each pin —
 * are checked in map-layers.ts/fleet.test.ts, and in the browser through the pane's published
 * `data-vans-drawn`.
 */
import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { DEMO_RUN_SECONDS } from "@/fixtures/replays";
import { MAP_DATA_BY_ROLE, type MapViewer } from "@/domain/access/map-view";
import { liveMap } from "@/ui/copy";
import LiveMapScreen from "./LiveMapScreen";
import { LockedCard } from "./LockedCard";
import { LIVE_FLEET_VEHICLE_IDS } from "./fleet";
import { liveDayAt } from "./day";

/* The pane is a canvas; this suite is about words. See the header. */
vi.mock("./LiveMapPane", () => ({
  default: ({ children }: { children?: unknown }) => children ?? null,
}));
/* The header slot portals into the frame's bar, which is not mounted here. */
vi.mock("@/ui/HeaderSlot", () => ({
  HeaderSlot: ({ children }: { children?: unknown }) => children ?? null,
}));
vi.mock("next/link", () => ({
  default: ({ children }: { children?: unknown }) => children ?? null,
}));

/** The screen as a role sees it, with a plan saved so the vans are on it. */
function render(options: { familyLabels?: boolean; at?: number; unlocked?: boolean } = {}): string {
  return renderToStaticMarkup(
    createElement(LiveMapScreen, {
      date: "2026-10-17",
      leg: "AM" as const,
      familyLabels: options.familyLabels ?? true,
      unlocked: options.unlocked ?? true,
      kidsByVan: { V1: 3, V2: 4, V3: 2 },
      pinnedSeconds: options.at ?? 830,
      // The page hands the card down when the leg has no saved plan (§9.1); so does this.
      locked:
        options.unlocked === false
          ? createElement(LockedCard, { canPlan: true })
          : null,
    }),
  );
}

/** The words a founder reads: markup with its tags, attributes and comments taken out. */
function wordsOf(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&[a-z]+;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Every shape of internal code the contract names, each on its own so a failure says which.
 * `\b` on both sides, so a place called "Van 1" and a driver called "C. Ruiz" are not codes.
 */
const CODES: ReadonlyArray<[name: string, pattern: RegExp]> = [
  ["a V-code (V1, V2, V3, V4)", /\bV\d\b/],
  ["a provider or vendor name", /\bProvider\b|\bP\d\b/],
  ["the synthetic marker", /\bSYN\b/],
  ["a family key", /\bF\d{1,2}\b/],
  ["a child token", /\bC\d{1,2}\b/],
  ["a stop key", /\bS\d{1,2}\b/],
  ["a run or route id", /\broute\d|\bR\d\b/],
  ["a device id", /\bDEV-/],
  ["a layout code", /\d+WC\/\d+A/],
  ["a 24-hour time", /\b([01]\d|2[0-3]):[0-5]\d\b(?!\s*(AM|PM))/],
  ["a uuid", /[0-9a-f]{8}-[0-9a-f]{4}-/i],
];

/**
 * The vehicle descriptions and vendor names the fixtures carry. None of them is a word a founder
 * should ever read on this screen (REDESIGN-SPEC §6 item 5: providers are hidden from the demo
 * UI, and §7 C2: generic Van 1–3 with drivers' real names, no providers shown).
 */
const NEVER_ON_SCREEN = [
  "Convertible van",
  "Center van",
  "Substitute van",
  "Sedan",
  "Provider P1",
  "Provider P2",
  "Palm Lift Transport",
  "Coastal Car Service",
  "center fleet",
];

describe("the van list says 'Van N · <driver>' and nothing else about the van", () => {
  it("names every van the founder's way (mockups/live-map.html `.van .t`)", () => {
    const html = render();
    const names = [...html.matchAll(/aria-label="(Van [^"]*)"/g)].map((m) => m[1]);
    expect(names).toHaveLength(3);
    for (const name of names) {
      // "Van 1 · Marco D." — a number, a separator, a person. Nothing else fits this.
      expect(name).toMatch(/^Van [123] · [A-Z][a-z]+(?: [A-Z]\.)?$/);
    }
    expect(names.map((n) => n.slice(0, 5)).sort()).toEqual(["Van 1", "Van 2", "Van 3"]);
  });

  it("prints no vehicle description and no vendor, ever", () => {
    const words = wordsOf(render());
    for (const banned of NEVER_ON_SCREEN) {
      expect(words, `"${banned}" is on the Live map`).not.toContain(banned);
    }
  });

  /*
   * The fleet's own keys are what the screen joins the saved plan on, and they must stay on the
   * inside of it. Named explicitly, because "V1" is the one that was actually on screen.
   */
  it("prints none of the fleet's internal vehicle keys", () => {
    const words = wordsOf(render());
    for (const key of LIVE_FLEET_VEHICLE_IDS) {
      expect(words, `the vehicle key ${key} is on the Live map`).not.toMatch(
        new RegExp(`\\b${key}\\b`),
      );
    }
  });
});

describe("no internal code of any shape, at any second of the day", () => {
  /*
   * Walked rather than sampled. A code reaches the screen through a *fixture value* — the next
   * stop's name, a family label in the Auto texts feed, a driver — and which values are on
   * screen depends on where the clock is. One pinned instant would have missed the family key
   * that was in the feed before this branch resolved it to a person.
   */
  const instants = Array.from({ length: 1 + Math.floor(DEMO_RUN_SECONDS / 300) }, (_, i) => i * 300);

  it.each(CODES)("never prints %s", (name, pattern) => {
    for (const at of instants) {
      const words = wordsOf(render({ at }));
      expect(words.match(pattern), `${name} at ${at}s: ${words.slice(0, 200)}`).toBeNull();
    }
  });

  it("has words to scan at every one of those instants, so this cannot pass on an empty page", () => {
    for (const at of instants) {
      const words = wordsOf(render({ at }));
      expect(words.length, `nothing rendered at ${at}s`).toBeGreaterThan(80);
      expect(words).toContain("Van 1");
    }
  });
});

describe("for every role that can open the map", () => {
  /*
   * The front desk sees the same screen with less on it — no family labels in the feed
   * (src/domain/access/map-view.ts). Both views are scanned, because the role that is MOST
   * likely to be left holding a raw label is the one whose data is filtered on the way out.
   */
  const viewers: MapViewer[] = ["DIRECTOR", "COORDINATOR", "FRONT_DESK"];

  it.each(viewers)("%s reads no internal code", (viewer) => {
    const familyLabels = MAP_DATA_BY_ROLE[viewer].includes("familyLabels");
    const words = wordsOf(render({ familyLabels }));
    for (const [name, pattern] of CODES) {
      expect(words.match(pattern), `${viewer}: ${name}`).toBeNull();
    }
    for (const banned of NEVER_ON_SCREEN) expect(words).not.toContain(banned);
  });

  /* And the one that cannot see family names gets the van alone, not a blanked-out label. */
  it("gives the front desk a feed row with a van and no family at all", () => {
    const words = wordsOf(render({ familyLabels: false }));
    expect(words).toContain(liveMap.feedHeading);
    expect(words).not.toMatch(/\bF\d/);
    expect(words).not.toContain("undefined");
    expect(words).not.toContain("null");
  });
});

describe("the locked screen says nothing about a van either", () => {
  it("prints no code while there is no saved plan", () => {
    const words = wordsOf(render({ unlocked: false }));
    expect(words).toContain(liveMap.lockedHeading);
    for (const [name, pattern] of CODES) {
      expect(words.match(pattern), name).toBeNull();
    }
  });
});

/**
 * And the data the screen is handed carries no code into it either.
 *
 * The markup scan above is the founder's view; this is the door it comes through. A field that
 * holds "V1" is one `{field}` away from being drawn, so the day's own strings are checked at
 * the source — which is also what keeps this honest if the list is ever re-skinned.
 */
describe("the day hands the screen no code to print", () => {
  it("puts no vehicle key, description or vendor in any string field", () => {
    for (let seconds = 0; seconds <= DEMO_RUN_SECONDS; seconds += 300) {
      const day = liveDayAt(seconds, { tween: true, familyLabels: true });
      for (const van of day.vans) {
        for (const value of [van.driver, van.nextStop]) {
          expect(value, `at ${seconds}s`).not.toMatch(/\bV\d\b|\bProvider\b|\bSYN\b/);
        }
      }
      for (const row of day.feed) {
        expect(row.familyLabel ?? "", `at ${seconds}s`).not.toMatch(/\bF\d/);
      }
    }
  });

  /* `id` is the one field that is a key, and it is the one field nothing may print. */
  it("keeps the vehicle key on the data, where it is a join and not a label", () => {
    const day = liveDayAt(830, { tween: true });
    expect(day.vans.map((van) => van.id).sort()).toEqual([...LIVE_FLEET_VEHICLE_IDS].sort());
  });
});
