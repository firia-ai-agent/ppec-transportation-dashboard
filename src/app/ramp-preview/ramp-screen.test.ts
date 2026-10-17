import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { pageOutcome } from "@/auth/access";
import { canOpenRampPreview } from "@/domain/access/map-view";
import { ARRIVAL_PARAM, rampArrivals } from "@/domain/plan/arrival";
import { MEASURED_AT_ARRIVAL } from "@/domain/plan/day";
import { boardChildren } from "@/domain/board/scenario";
import { demoBanner, rampPreview, rampReplan } from "@/ui/copy";
import RampCheck from "./RampCheck";

/**
 * The ramp check's screen contracts from Vera's review.
 *
 * The screen is a client component with its own state, and vitest runs in node with no DOM, so
 * what can be asserted here is that the rules are written: the guard is on the route, the
 * selected state is filled rather than outlined, and the sticky banner reserves its own height.
 * That the browser then applies them is e2e/screens.spec.ts's job — it measures the real boxes
 * at 1024 and 1280 and proves no row ends up underneath the banner.
 */
const HERE = __dirname;

function read(file: string): string {
  return readFileSync(path.join(HERE, file), "utf8");
}

describe("the route is behind the same door as the map preview", () => {
  const page = read("page.tsx");
  const screen = read("RampCheck.tsx");

  it("guards on the server, through the shared guard and the one access table", () => {
    expect(page).not.toMatch(/^"use client"/m);
    // The guard is the same one every page calls, keyed by this route's row in the table: it
    // redirects a signed-out visitor to sign-in and answers 403 for a role the row omits.
    expect(page).toMatch(/requirePage\("\/ramp-preview"\)/);
    expect(page).toMatch(/from "@\/auth\/page-guard"/);
    // A session read means the route can never be answered from a static render.
    expect(page).toMatch(/export const dynamic = "force-dynamic"/);
  });

  it("leaves the screen itself a plain client component with no guard of its own", () => {
    expect(screen).toMatch(/^"use client"/);
    expect(screen).not.toMatch(/redirect|requirePage|getCaller|auth\(\)/);
  });

  it("anonymous cannot reach it, which is the point of the guard", () => {
    expect(canOpenRampPreview("ANONYMOUS")).toBe(false);
    expect(canOpenRampPreview("FRONT_DESK")).toBe(true);
    // ...and the table, which is what the route actually enforces, says the same.
    expect(pageOutcome({ kind: "ANONYMOUS" }, "/ramp-preview")).toBe("SIGN_IN");
    expect(pageOutcome({ kind: "STAFF", role: "FRONT_DESK" }, "/ramp-preview")).toBe("ALLOW");
  });

  it("is reachable from the map preview, so it is not URL-only", () => {
    const mapPage = readFileSync(
      path.resolve(HERE, "..", "map-preview", "page.tsx"),
      "utf8",
    );
    expect(mapPage).toMatch(/href="\/ramp-preview"/);
  });
});

describe("a chosen answer is filled, not outlined", () => {
  const screen = read("RampCheck.tsx");

  it("fills the button in the brand pair and marks it pressed", () => {
    // An outline in the brand tone is the same shape as the §9 focus ring; filled is not.
    expect(screen).toMatch(/const SELECTED_PALETTE = \{[^}]*background: "var\(--color-brand\)"/);
    expect(screen).toMatch(/const SELECTED_PALETTE = \{[^}]*color: "var\(--color-surface\)"/);
    expect(screen).toMatch(/variant === "primary" \|\| pressed\s*\?\s*SELECTED_PALETTE/);
    expect(screen).toMatch(/aria-pressed=\{pressed\}/);
  });

  it("adds a check mark, so the state is never colour alone (§3)", () => {
    expect(screen).toMatch(/\{pressed \? <Icon name="check" \/> : null\}/);
  });

  it("gives the arriving-vehicle cards the same treatment", () => {
    const cards = screen.slice(screen.indexOf("arrivals.map("));
    expect(cards).toMatch(/aria-pressed=\{chosen\}/);
    expect(cards).toMatch(/chosen \? "var\(--color-brand\)" : "var\(--color-surface\)"/);
    expect(cards).toMatch(/\{chosen \? <Icon name="check" \/> : null\}/);
  });

  it("covers the three controls the review named: cards, setup buttons and Not sure", () => {
    // The setup buttons and every checklist answer are BigButtons, so one `pressed` rule
    // reaches all of them; the cards are their own markup and are asserted above.
    expect(screen).toMatch(/<BigButton\s+\/\/[^\n]*\n\s*key=\{candidate\.id\} label=\{layoutName\(candidate\.code\)\}/);
    expect(screen).toMatch(/<BigButton\s+key=\{option\} label=\{labels\[option\]\} pressed=\{value === option\}/);
    expect(rampPreview.answer.UNSURE).toBe("Not sure");
  });
});

describe("the sticky banner reserves its own height", () => {
  const screen = read("RampCheck.tsx");

  it("measures the banner rather than guessing it", () => {
    // It grows a line every time the solver adds an option, so a constant would be wrong on
    // the first run that does not fit.
    expect(screen).toMatch(/new ResizeObserver\(/);
    expect(screen).toMatch(/setBannerHeight\(node\.offsetHeight\)/);
  });

  it("pads the page by that height, so no row ends up underneath it", () => {
    expect(screen).toMatch(/paddingBottom: `calc\(var\(--space-5\) \+ \$\{bannerHeight\}px\)`/);
  });

  it("collapses to the verdict line, so it covers one row rather than four", () => {
    // The reserved padding frees the rows at the bottom of the page; collapsing is what keeps
    // the banner off them in the middle of it. The verdict itself is never hidden.
    expect(screen).toMatch(/const \[bannerOpen, setBannerOpen\] = useState\(false\)/);
    expect(screen).toMatch(/\{bannerOpen && banner\.detail \?/);
    expect(screen).toMatch(/\{bannerOpen && result\.options\.length > 0 \?/);
    expect(screen).toMatch(/label=\{bannerOpen \? rampPreview\.hideDetails : rampPreview\.showDetails\}/);
    expect(rampPreview.showDetails).toBe("Show details");
    expect(rampPreview.hideDetails).toBe("Hide details");
  });

  it("stops the page being exactly the DEMO bar too tall", () => {
    expect(screen).toMatch(/minHeight: "calc\(100vh - var\(--layout-demo-banner-height\)\)"/);
  });
});

/**
 * One day under the ramp iPad, the plan and the board.
 *
 * The screen used to read a fixture written beside it (src/fixtures/fleet.ts), which named
 * eight children the Today board has never heard of and carried hand-written arrival times that
 * could disagree with the plan. It now reads the demo scenario's own afternoon runs, so what is
 * checked here is the thing that could silently come apart again: the children, the vans and the
 * times on this screen are the ones the board renders.
 */
describe("the vans at the ramp are the day the board shows", () => {
  const screen = read("RampCheck.tsx");

  it("reads the day's own afternoon runs, and no second fleet fixture", () => {
    expect(screen).toMatch(/from "@\/domain\/plan\/arrival"/);
    expect(screen).toMatch(/rampArrivals\(\)/);
    expect(screen).not.toMatch(/@\/fixtures\/fleet/);
  });

  it("renders the scenario's own children, by the labels the board writes them with", () => {
    const html = renderToStaticMarkup(createElement(RampCheck));
    const arrival = rampArrivals()[0];
    for (const rider of arrival.riders) {
      expect(html, rider.child.displayName).toContain(rider.child.displayName);
      // The same label the board's own row carries for that child.
      expect(boardChildren.map((c) => c.label)).toContain(rider.child.displayName);
    }
  });

  it("names every van the day runs, and takes each tile's time from the plan", () => {
    const html = renderToStaticMarkup(createElement(RampCheck));
    for (const arrival of rampArrivals()) {
      expect(html, arrival.laneId).toContain(arrival.vehicle.description);
      expect(html, arrival.laneId).toContain(arrival.leavesAt);
      // An afternoon run leaves the centre after lunch, which is what the ramp is against.
      expect(arrival.leavesAt, arrival.laneId).toMatch(/PM$/);
    }
  });

  it("mounts no second DEMO bar and no second source chip: both ride in the root layout", () => {
    const html = renderToStaticMarkup(createElement(RampCheck));
    expect(demoBanner.text).toBe("DEMO");
    expect(html).not.toContain(`aria-label="${demoBanner.ariaLabel}"`);
    expect(html.match(/Simulated/g) ?? []).toHaveLength(0);
  });
});

/**
 * The re-plan panel: the check no longer stops on the iPad.
 *
 * The outcome itself is the solver's and is checked in src/domain/plan/arrival.test.ts; the
 * sentences are checked in src/ui/arrival-lines.test.ts. What is left for the screen is when it
 * speaks and where it sends the result, and both are rules a browser cannot be relied on to
 * reveal — a half-answered checklist is the state the screen *opens* in.
 */
describe("what the check does to the afternoon, on the screen that took it", () => {
  const screen = read("RampCheck.tsx");

  it("says nothing about moves until the vehicle check is finished", () => {
    const html = renderToStaticMarkup(createElement(RampCheck));
    // Opening state: nothing answered, so the panel asks for the rest of the check instead of
    // announcing that three children have no van.
    expect(html).toContain(rampReplan.heading);
    expect(html).toContain(rampPreview.notCheckedDetail);
    expect(html).not.toContain(rampReplan.heldHeading);
    expect(html).not.toContain(rampReplan.movedHeading);
    expect(html).not.toContain(rampReplan.openPlan);
  });

  it("treats an unanswered row as unanswered, never as a yes", () => {
    expect(screen).toMatch(/checklist\.lift !== "UNSURE"/);
    expect(screen).toMatch(/\(checklist\.positions\[p\.id\] \?\? "UNSURE"\) !== "UNSURE"/);
  });

  it("re-plans through the solver's own mover, and computes nothing itself", () => {
    expect(screen).toMatch(/replanForArrival\(finding\)/);
    expect(screen).not.toMatch(/tryMove|planAssignment/);
  });

  it("hands the result on as a link, carrying the finding to both screens", () => {
    expect(screen).toContain(`/plan-preview?${"$"}{ARRIVAL_PARAM}=`);
    expect(screen).toContain(`/today?${"$"}{ARRIVAL_PARAM}=`);
    expect(screen).toMatch(/encodeURIComponent\(findingCode\)/);
    expect(ARRIVAL_PARAM).toBe("arrival");
  });

  it("says a proposal is a proposal, and that no family has been told", () => {
    expect(screen).toMatch(/rampReplan\.decides/);
    expect(rampReplan.decides).toBe("A coordinator decides. No family has been told.");
  });

  /**
   * The line at the top of the screen says where the answers go, and it changed with this: the
   * ramp's finding leaves the iPad now, and the boarding records still do not.
   */
  it("no longer claims every answer stays on the iPad", () => {
    const html = renderToStaticMarkup(createElement(RampCheck));
    expect(html).toContain(rampPreview.localOnly);
    expect(rampPreview.localOnly).toContain("goes to the plan");
    expect(rampPreview.localOnly).toContain("boarding records stay on this iPad");
  });
});

/** AT's own lever: a chair measured at the ramp, rather than taken from the file. */
describe("the chair the ramp measures", () => {
  const screen = read("RampCheck.tsx");

  it("is offered only for a child the day has a measurement for", () => {
    expect(screen).toMatch(/MEASURED_AT_ARRIVAL\[child\.token\] !== undefined/);
    expect(screen).toMatch(/\{measurable\.includes\(child\) \?/);
  });

  it("compares the two numbers rather than asserting a difference", () => {
    expect(screen).toMatch(/function chairDiffers\(child: Child\): boolean/);
    expect(screen).toMatch(/rampPreview\.measuredMatches/);
  });

  it("is a finding about a child, kept out of the vehicle checklist", () => {
    // The §4.4 checklist is the vehicle check; a chair is not part of the vehicle.
    expect(screen).toMatch(/const \[measuredChairs, setMeasuredChairs\]/);
    expect(screen).toMatch(/findingOfChecklist\(arrival, checklist, measuredChairs\)/);
  });

  it("has a measurement the plan can act on: the chair that arrives is bigger", () => {
    for (const [token, measured] of Object.entries(MEASURED_AT_ARRIVAL)) {
      const onFile = boardChildren.find((c) => c.key === token);
      expect(onFile, token).toBeDefined();
      expect(measured.wcLengthCm, token).toBeGreaterThan(onFile!.wcLengthCm ?? 0);
    }
  });
});
