import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { buildBoard, type LegRow } from "@/domain/board/board";
import { adapterHealth } from "@/domain/health/adapters";
import { dayCounts } from "@/domain/health/metrics";
import { DEMO_ACCOUNTS } from "@/auth/demo-accounts";
import { PROVIDERS, providerDisplayName } from "@/modules/demo/fixtures/standard";
import { rampArrivals } from "@/domain/plan/arrival";
import { board as boardCopy, fill, vanTitle } from "./copy";

/**
 * The four screens Vera walked, rendered, with every code read off the markup the browser gets.
 *
 * `no-codes.test.ts` nets the strings a screen holds statically and `no-van-codes.test.ts` nets
 * the strings its view models return. Neither could see the four things the prod walk found
 * (2026-10-17 2:48 PM ET), because all four were composed *in the markup*: the ramp iPad's
 * vehicle tiles read "V1 · SYN Palm Lift Transport", the drawer the Health screen opens read
 * "V4 · SYN Coastal Car Service", the board's Van column read "V2" on every row, and the app
 * header read "SYN Dana Director" on every console page.
 *
 * So this file renders the real components — the ramp screen, the Today board, Health & ROI, the
 * ride drawer both of those open, and the console layout itself, which is the one place the
 * session's name becomes words — and scans the whole of each result. The whole of it, attributes
 * included: an `aria-label` is read out loud, so a code hiding in one is a code on the screen.
 *
 * The screens are not mocked and the day is not invented: every one of them is given the seed
 * day (`buildBoard`, `rampArrivals`) that the demo walk opens on.
 */

/*
 * The console layout is a server component that reads a session, and the sign-out control it
 * mounts imports Auth.js, which does not load outside Next. The session is stubbed with the
 * account's *stored* name — the thing under test is that the header does not print it as it is
 * stored — and the two modules that need a runtime are stubbed with nothing: neither renders a
 * van or a person's name, which is the whole of what this file reads.
 */
vi.mock("next/navigation", async (actual) => ({
  ...(await actual<Record<string, unknown>>()),
  usePathname: () => "/today",
}));
vi.mock("@/ui/SignOutButton", () => ({ SignOutButton: () => null }));
vi.mock("@/auth/caller", () => ({ getCaller: vi.fn() }));

/**
 * The codes, as the day writes them — the same four `no-van-codes.test.ts` scans for, kept in
 * both files rather than imported across a test boundary: a van key, the trade's layout
 * shorthand, the synthetic-name marker, and the provider as the interim fleet fixture ids it.
 */
const PATTERNS: ReadonlyArray<{ name: string; re: RegExp }> = [
  { name: "a fixture van key", re: /\bV\d\b/g },
  { name: "a layout shorthand", re: /\d+WC\/\d+A/g },
  { name: "a synthetic-name marker", re: /\bSYN\b/g },
  { name: "a provider id", re: /Provider P\d/g },
];

function codesIn(markup: string): string[] {
  return [...new Set(PATTERNS.flatMap(({ re }) => [...markup.matchAll(re)].map((m) => m[0])))];
}

const BOARD = buildBoard();
const COUNTS = dayCounts(BOARD);
const ADAPTERS = adapterHealth(BOARD, { APP_DATA_CLASS: "SYNTHETIC", DEMO_MODE: "1" });

/** A child with a van on both rides: the drawer either screen opens for them names it twice. */
const WITH_A_VAN: LegRow = BOARD.legs.find((leg) => leg.ride.vehicleDescription !== null)!;
const legsOf = (childKey: string) => BOARD.legs.filter((leg) => leg.child.childKey === childKey);

async function rampMarkup(): Promise<string> {
  const RampCheck = (await import("@/app/ramp-ipad/RampCheck")).default;
  return renderToStaticMarkup(createElement(RampCheck, { role: "DIRECTOR" }));
}

async function boardMarkup(): Promise<string> {
  const { TodayBoard } = await import("@/app/(app)/today/TodayBoard");
  return renderToStaticMarkup(createElement(TodayBoard, { board: BOARD, query: "" }));
}

async function healthMarkup(): Promise<string> {
  const { HealthScreen } = await import("@/app/(app)/health/HealthScreen");
  return renderToStaticMarkup(
    createElement(HealthScreen, { board: BOARD, counts: COUNTS, adapters: ADAPTERS }),
  );
}

/**
 * The ride drawer, with the legs the Health screen hands it: `drawerLegs` there is every leg of
 * one child, and the component is the board's own — HealthScreen renders `LegDrawer` itself
 * rather than a copy of it, which is why one assertion covers both screens.
 */
async function drawerMarkup(childKey: string): Promise<string> {
  const { LegDrawer } = await import("@/app/(app)/today/LegDrawer");
  return renderToStaticMarkup(
    createElement(LegDrawer, { legs: legsOf(childKey), day: BOARD.day, onClose: () => {} }),
  );
}

/** The console header, through the real layout: the guard, the session's name, the shell. */
async function headerMarkup(storedName: string): Promise<string> {
  const { getCaller } = await import("@/auth/caller");
  vi.mocked(getCaller).mockResolvedValue({
    kind: "STAFF",
    role: "DIRECTOR",
    userId: "01900000-0000-7000-8000-0000000000d1",
    displayName: storedName,
    memberships: [],
  } as never);
  const layout = await import("@/app/(app)/layout");
  return renderToStaticMarkup(await layout.default({ children: null }));
}

describe("the scan reads the markup, and would have caught all four", () => {
  it("catches each code where the prod walk found it", () => {
    expect(codesIn('<strong>V1 · SYN Palm Lift Transport</strong>')).toEqual([
      "V1",
      "SYN",
    ]);
    expect(codesIn('<span class="vanName">V2</span>')).toEqual(["V2"]);
    expect(codesIn('<span>SYN Dana Director</span>')).toEqual(["SYN"]);
    expect(codesIn('<p>Checked as 1WC/3A.</p>')).toEqual(["1WC/3A"]);
    expect(codesIn('<a aria-label="Open V4 · Provider P1">x</a>')).toEqual(["V4", "Provider P1"]);
  });

  it("passes the words that merely look like one", () => {
    expect(codesIn("<p>SYNTHETIC</p><p>Simulated</p>")).toEqual([]);
    expect(codesIn("<p>The center van · Greenacres center fleet</p>")).toEqual([]);
    expect(codesIn("<p>1 wheelchair · 3 seats</p>")).toEqual([]);
  });

  it("is reading screens with something on them", () => {
    // A net over an empty page passes for the wrong reason: the seed day runs three vans and
    // nine riders, and the drawer is opened on a child who has a van on it.
    expect(rampArrivals().length).toBeGreaterThan(2);
    expect(BOARD.legs.length).toBeGreaterThan(10);
    expect(WITH_A_VAN.ride.vehicleDescription).not.toBeNull();
    expect(COUNTS.metrics).toHaveLength(4);
  });
});

describe("the ramp iPad, rendered", () => {
  it("puts no van key, layout shorthand, synthetic marker or provider id on the screen", async () => {
    expect(codesIn(await rampMarkup())).toEqual([]);
  });

  it("names every van at the ramp, and the company that runs it", async () => {
    const html = await rampMarkup();
    for (const arrival of rampArrivals()) {
      expect(html, arrival.laneId).toContain(vanTitle(arrival.vehicle.description));
      expect(html, arrival.laneId).toContain(arrival.vehicle.providerName);
    }
    // The providers are the scenario's own three, with the marker off and nothing else changed.
    for (const provider of PROVIDERS) {
      expect(providerDisplayName(provider.name)).not.toContain("SYN");
      expect(provider.name).toContain("SYN");
    }
  });
});

describe("the Today board, rendered", () => {
  it("puts no code in any cell", async () => {
    expect(codesIn(await boardMarkup())).toEqual([]);
  });

  it("names the van in the Van column, on every row that has one", async () => {
    const html = await boardMarkup();
    const named = BOARD.legs.filter((leg) => leg.ride.vehicleDescription !== null);
    expect(named.length).toBeGreaterThan(0);
    for (const leg of named) {
      expect(html, leg.key).toContain(vanTitle(leg.ride.vehicleDescription!));
    }
  });
});

describe("Health & ROI and the ride drawer it opens, rendered", () => {
  it("puts no code on the Health screen", async () => {
    expect(codesIn(await healthMarkup())).toEqual([]);
  });

  it("puts no code in the ride drawer either screen opens", async () => {
    expect(codesIn(await drawerMarkup(WITH_A_VAN.child.childKey))).toEqual([]);
  });

  it("names the van and the company on the drawer's van line", async () => {
    const html = await drawerMarkup(WITH_A_VAN.child.childKey);
    const { ride } = WITH_A_VAN;
    expect(html).toContain(
      fill(boardCopy.vanAndProvider, {
        van: vanTitle(ride.vehicleDescription!),
        provider: ride.providerName ?? "",
      }),
    );
  });
});

describe("the console header, rendered through the real layout", () => {
  it("shows the person's first name and not the account's stored name", async () => {
    const director = DEMO_ACCOUNTS.find((account) => account.role === "DIRECTOR")!;
    // The account is still stored under its full synthetic name; this is a display helper.
    expect(director.name).toBe("SYN Dana Director");
    const html = await headerMarkup(director.name);
    expect(codesIn(html)).toEqual([]);
    expect(html).toContain("Dana");
    expect(html).not.toContain("Dana Director");
  });

  it("leaves a name with no marker on it alone, which is every other session", async () => {
    // The browser check signs in with a role and no user row, and the name it renders is that
    // role's own word (src/auth/caller.ts) — nothing for the helper to take off.
    const html = await headerMarkup("Director");
    expect(html).toContain("Director");
    expect(codesIn(html)).toEqual([]);
  });
});
