import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { pageOutcome } from "@/auth/access";
import { canOpenRampPreview } from "@/domain/access/map-view";
import { rampPreview } from "@/ui/copy";

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
    const cards = screen.slice(screen.indexOf("ARRIVING_VEHICLES.map"));
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
