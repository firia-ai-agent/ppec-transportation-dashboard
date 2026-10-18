/**
 * WHO THE LIVE MAP IS FOR.
 *
 * Layer 2 (behaviour). The rule is a named ruling, and it is quoted where it is asserted:
 *
 * > **Firia, 2026-10-17 3:08 PM ET (final, supersedes the 3:07 note):** "Front desk gets two
 * > tabs, Live map (their home) and Ramp iPad." REDESIGN-SPEC §9 carries it, and §0's own line
 * > is "Front desk keeps Live map + Ramp iPad; `access.ts` unchanged."
 *
 * So three things have to hold at once, and each is a separate failure if it stops holding:
 * the director and the coordinator can open the screen, the front desk can open it and **lands**
 * on it, their menu is exactly those two destinations, and anybody else is refused by the
 * server rather than by a hidden link.
 *
 * These ask the access table directly, with no browser involved, exactly because a hidden link
 * is not a closed door (the ID-swap rule: hiding ≠ denying). The browser half — that the front
 * desk really arrives on /live-map and sees no scenario control — is e2e/live-map.spec.ts.
 */
import { describe, expect, it } from "vitest";
import { canOpenPage, homePathFor, type Caller } from "@/auth/access";
import { canOpenLiveMap, canSeeMapData, mapViewerFor } from "@/domain/access/map-view";
import { navItemsFor } from "@/ui/nav-items";
import type { StaffRole } from "@/auth/core";

const staff = (role: StaffRole): Caller => ({ kind: "STAFF", role });
const CONSOLE_ROLES: StaffRole[] = ["DIRECTOR", "COORDINATOR"];

describe("the three staff roles can open the Live map", () => {
  it.each([...CONSOLE_ROLES, "FRONT_DESK" as const])("%s can open /live-map", (role) => {
    expect(canOpenPage(staff(role), "/live-map")).toBe(true);
    expect(canOpenLiveMap(mapViewerFor([role]))).toBe(true);
  });
});

describe("everybody else is refused by the server", () => {
  /*
   * The two callers who are not a role: signed out, and signed in with no membership anywhere.
   * Neither gets the screen. (The page guard turns the first into a redirect to sign-in and the
   * second into the no-access page with a 403 — src/auth/page-guard.ts.)
   */
  it("refuses an anonymous caller", () => {
    expect(canOpenPage({ kind: "ANONYMOUS" }, "/live-map")).toBe(false);
  });

  it("refuses a signed-in caller who holds no role at any site", () => {
    expect(canOpenPage({ kind: "NO_ROLE", userId: "u1" }, "/live-map")).toBe(false);
    expect(canOpenLiveMap(mapViewerFor([]))).toBe(false);
  });
});

describe("the front desk's menu is exactly Live map + Ramp iPad (Firia, 3:08 PM ET)", () => {
  const menu = navItemsFor("FRONT_DESK").map((item) => item.href);

  it("has those two destinations, in that order", () => {
    expect(menu).toEqual(["/live-map", "/ramp-ipad"]);
  });

  /* Named one at a time, so a menu that grows a third item fails on the item rather than a count. */
  it.each(["/today", "/plan-routes", "/family-texts", "/health", "/setup", "/exceptions"])(
    "does not carry %s",
    (href) => {
      expect(menu).not.toContain(href);
      expect(canOpenPage(staff("FRONT_DESK"), href)).toBe(false);
    },
  );
});

describe("the front desk LANDS on the Live map", () => {
  /*
   * "Their home page is Live map." Asserted through `homePathFor`, which is what every redirect
   * with nowhere else to send somebody uses — login, and a typed URL for a page not on their
   * menu — so this is the same answer all of those give.
   */
  it("is sent to /live-map when they need somewhere to be", () => {
    expect(homePathFor(staff("FRONT_DESK"))).toBe("/live-map");
  });

  it("is not where the two console roles land: they open on Today", () => {
    for (const role of CONSOLE_ROLES) expect(homePathFor(staff(role))).toBe("/today");
  });
});

describe("what the front desk sees once they are on it", () => {
  const frontDesk = mapViewerFor(["FRONT_DESK"]);

  /* No scenario or demo controls. The clock's controls are a demo control, and this is the one
     role whose home page this is — so the screen they land on steers nothing. */
  it("gets no clock controls", () => {
    expect(canSeeMapData(frontDesk, "clockControls")).toBe(false);
    for (const role of CONSOLE_ROLES) {
      // And the one role that does get them is the director, not everyone with a console.
      expect(canSeeMapData(mapViewerFor([role]), "clockControls")).toBe(role === "DIRECTOR");
    }
  });

  it("gets the map and the vans, which is the whole point of their having it", () => {
    expect(canSeeMapData(frontDesk, "map")).toBe(true);
    expect(canSeeMapData(frontDesk, "vehiclePositions")).toBe(true);
  });

  /* A person at the door needs to know where the van is, not which family was texted. */
  it("does not get family labels or the notification queue", () => {
    expect(canSeeMapData(frontDesk, "familyLabels")).toBe(false);
    expect(canSeeMapData(frontDesk, "notificationDecisions")).toBe(false);
  });
});
