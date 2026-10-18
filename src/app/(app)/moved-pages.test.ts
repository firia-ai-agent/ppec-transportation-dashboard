import { describe, expect, it, vi, beforeEach } from "vitest";
import { getAccessFallbackHTTPStatus, isHTTPAccessFallbackError } from "next/dist/client/components/http-access-fallback/http-access-fallback";
import { APPROVAL_ROLES, MOVED_PAGES, canOpenForYou, type Caller } from "@/auth/access";
import type { Membership } from "@/auth/core";
import { NOT_ON_YOUR_MENU, withNotice } from "@/ui/notice";

/**
 * THE TWO SCREENS THAT BECAME PART OF ANOTHER SCREEN — `/exceptions` and `/approvals` — asked of
 * the server, per role, and the "For you" tab beside them.
 *
 * Firia, 2026-10-17 8:36 PM ET, and Vera's audit §2 item 2: Exceptions & Approvals and Health &
 * ROI come off the menu, and the first of them redirects to Today while Approvals redirects to
 * the tab it has always been (REDESIGN-SPEC §9.2: "Approvals is the For you tab inside Family
 * texts, not a menu item"). What is checked here is the thing a redirect can get wrong:
 *
 *  1. **It is a 308**, not a 307. The address has moved for good.
 *  2. **The guard runs first.** A signed-out visitor is sent to sign-in and never learns that
 *     the destination exists — a redirect configured in next.config.ts would fire before anyone
 *     knows who is asking, which is exactly the leak.
 *  3. **The front desk ends on a screen they can see.** Their row opens neither page, so they
 *     are refused *here* and sent to their own home — the live map — with the §9.3 notice.
 *     Never "For you", never a 403, never a dead end.
 *  4. **A typed `?tab=for-you` is refused on the server**, not hidden in the UI (the ID-swap
 *     skill, rule 6: hiding ≠ denying).
 *
 * The pages are imported and *called*, the way Next calls them, so this is the server's answer
 * and not a reading of the source. Only the session reader is stubbed: that is how a role is put
 * on the request (the reader's own steps are tested against a real database in caller.test.ts).
 */
type Resolved = Caller & { displayName?: string; memberships: readonly Membership[] };

const getCaller = vi.fn<() => Promise<Resolved>>();
vi.mock("@/auth/caller", () => ({ getCaller }));
vi.mock("@/auth", () => ({
  auth: vi.fn(async () => null),
  signIn: vi.fn(),
  signOut: vi.fn(),
  handlers: { GET: vi.fn(), POST: vi.fn() },
}));
vi.mock("next/link", () => ({ default: () => null }));

process.env.__NEXT_EXPERIMENTAL_AUTH_INTERRUPTS = "1";

const SITE = "00000000-0000-7000-8000-000000000001";
const staff = (role: Membership["role"]): Resolved => ({
  kind: "STAFF",
  role,
  userId: "00000000-0000-7000-8000-0000000000d1",
  displayName: "SYN Dana Director",
  memberships: [{ siteId: SITE, role }],
});
const SIGNED_OUT: Resolved = { kind: "ANONYMOUS", memberships: [] };
const NO_ROLE: Resolved = {
  kind: "NO_ROLE",
  userId: "00000000-0000-7000-8000-0000000000e1",
  displayName: "SYN Nina NoRole",
  memberships: [],
};

/** What a thrown Next interrupt was: where a redirect went, and whether it is permanent. */
function interruptOf(
  error: unknown,
): { kind: "redirect"; to: string; permanent: boolean } | { kind: "http"; status: number } | null {
  if (isHTTPAccessFallbackError(error)) {
    return { kind: "http", status: getAccessFallbackHTTPStatus(error) };
  }
  const digest = (error as { digest?: unknown })?.digest;
  if (typeof digest === "string" && digest.startsWith("NEXT_REDIRECT")) {
    const parts = digest.split(";");
    // `NEXT_REDIRECT;<kind>;<url>;<permanent|replace…>` — Next's own 308 marker is "308".
    return { kind: "redirect", to: parts[2], permanent: digest.includes("308") };
  }
  return null;
}

async function open(file: string, searchParams: Record<string, string> = {}) {
  const mod = (await import(/* @vite-ignore */ file)) as {
    default: (props: unknown) => Promise<unknown> | unknown;
  };
  try {
    await mod.default({
      searchParams: Promise.resolve(searchParams),
      params: Promise.resolve({}),
    });
    return { rendered: true as const };
  } catch (error) {
    const interrupt = interruptOf(error);
    if (!interrupt) throw error;
    return { rendered: false as const, interrupt };
  }
}

const PAGES = {
  "/exceptions": "./exceptions/page",
  "/approvals": "./approvals/page",
} as const;

beforeEach(() => {
  getCaller.mockReset();
});

describe("the two addresses that moved, per role", () => {
  for (const [from, file] of Object.entries(PAGES)) {
    const to = MOVED_PAGES[from];

    it(`${from} sends a director to ${to}, permanently`, async () => {
      getCaller.mockResolvedValue(staff("DIRECTOR"));
      expect(await open(file)).toEqual({
        rendered: false,
        interrupt: { kind: "redirect", to, permanent: true },
      });
    });

    it(`${from} sends a coordinator to ${to}, permanently`, async () => {
      getCaller.mockResolvedValue(staff("COORDINATOR"));
      expect(await open(file)).toEqual({
        rendered: false,
        interrupt: { kind: "redirect", to, permanent: true },
      });
    });

    /**
     * The front desk's whole answer, in one assertion: not the destination, not a 403, but their
     * own home with the notice that says why (§9.3). `/live-map` is a page their row opens — the
     * access table's own answer, which access.test.ts holds — so this is where they end, and it
     * is a screen rather than a bounce.
     */
    it(`${from} leaves the front desk on the live map, not on ${to}`, async () => {
      getCaller.mockResolvedValue(staff("FRONT_DESK"));
      const result = await open(file);
      expect(result).toEqual({
        rendered: false,
        interrupt: {
          kind: "redirect",
          to: withNotice("/live-map", NOT_ON_YOUR_MENU),
          permanent: false,
        },
      });
    });

    /** Signed out: sign-in first, and nothing about what is at the other end. */
    it(`${from} sends a signed-out visitor to sign-in, not to ${to}`, async () => {
      getCaller.mockResolvedValue(SIGNED_OUT);
      const result = await open(file);
      expect(result).toEqual({
        rendered: false,
        interrupt: { kind: "redirect", to: "/login", permanent: false },
      });
      expect(JSON.stringify(result)).not.toContain(to);
    });

    /** Signed in, a member of nowhere: a real 403, the same as on every other staff page. */
    it(`${from} answers 403 to a caller with no role anywhere`, async () => {
      getCaller.mockResolvedValue(NO_ROLE);
      expect(await open(file)).toEqual({
        rendered: false,
        interrupt: { kind: "http", status: 403 },
      });
    });
  }
});

/**
 * THE "FOR YOU" TAB, which is what `/approvals` is now (REDESIGN-SPEC §9.2).
 *
 * Two independent checks stand between the front desk and this queue, and both are the server's:
 * the page's own row (`/family-texts`, the two console roles) and `canOpenForYou`, which reads
 * `APPROVAL_ROLES`. They are equal sets today and they are not the same claim — one is "which
 * surface is the web console", the other is "who may decide" — so each is tested on its own.
 */
describe("the For you tab is refused server-side", () => {
  const FAMILY_TEXTS = "./family-texts/page";

  it("refuses the front desk a typed ?tab=for-you, and lands them on the live map", async () => {
    getCaller.mockResolvedValue(staff("FRONT_DESK"));
    expect(await open(FAMILY_TEXTS, { tab: "for-you" })).toEqual({
      rendered: false,
      interrupt: {
        kind: "redirect",
        to: withNotice("/live-map", NOT_ON_YOUR_MENU),
        permanent: false,
      },
    });
  });

  it("opens it for the roles that may decide", async () => {
    for (const role of APPROVAL_ROLES) {
      getCaller.mockResolvedValue(staff(role));
      expect(await open(FAMILY_TEXTS, { tab: "for-you" }), role).toEqual({ rendered: true });
    }
  });

  /**
   * THE CHECK ITSELF, with the page's row taken out of the way.
   *
   * The front desk is refused twice over, which is correct and which also means the end-to-end
   * test above would still pass if the tab's own check were deleted. So this one asks the gate
   * directly, with the same real `APPROVAL_ROLES` the page reads: remove `canOpenForYou` and
   * this test cannot even import, let alone pass. Verified by removing it, watching this file
   * fail, and putting it back.
   */
  it("is a gate of its own: APPROVAL_ROLES, not the page's row", () => {
    expect(APPROVAL_ROLES).toEqual(["DIRECTOR", "COORDINATOR"]);
    expect(canOpenForYou(staff("DIRECTOR"))).toBe(true);
    expect(canOpenForYou(staff("COORDINATOR"))).toBe(true);
    expect(canOpenForYou(staff("FRONT_DESK"))).toBe(false);
    expect(canOpenForYou(NO_ROLE)).toBe(false);
    expect(canOpenForYou(SIGNED_OUT)).toBe(false);
  });

  /**
   * And the call site, with the page guard widened to allow everyone: if the tab's check is
   * removed from the page, the front desk renders "For you" and this fails. That is the one
   * assertion the double refusal would otherwise hide.
   */
  it("still refuses the front desk when the page's own row would let them in", async () => {
    vi.resetModules();
    vi.doMock("@/auth/page-guard", () => ({
      requirePage: async () => staff("FRONT_DESK"),
    }));
    try {
      getCaller.mockResolvedValue(staff("FRONT_DESK"));
      const result = await open(`${FAMILY_TEXTS}?widened`, { tab: "for-you" });
      expect(result).toEqual({
        rendered: false,
        interrupt: {
          kind: "redirect",
          to: withNotice("/live-map", NOT_ON_YOUR_MENU),
          permanent: false,
        },
      });
    } finally {
      vi.doUnmock("@/auth/page-guard");
      vi.resetModules();
    }
  });
});
