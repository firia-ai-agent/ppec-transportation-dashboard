import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ROLE_LADDER, homePathFor, type Caller } from "./access";
import type { Membership } from "./core";
import { NOTICE_PARAM, NOT_ON_YOUR_MENU } from "@/ui/notice";

/**
 * WHERE "NOT ON YOUR MENU" IS ALLOWED TO APPEAR — Vera, 2026-10-17 8:46 PM ET.
 *
 * The notice is the sentence a redirect could not say: you asked for Plan routes and you are
 * looking at the live map (§9.3). That makes it right in exactly one situation — somebody typed
 * or followed an address their role does not open — and wrong everywhere else. Landing on your
 * own home because you just signed in, or because you opened `/`, is not a refusal and must not
 * be explained as one: a toast there tells a person something went wrong on the one screen
 * where nothing did.
 *
 * So both halves are held here, as the server's own answers rather than as a reading of the
 * source: the guard attaches the notice, and the entry route never does.
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

process.env.__NEXT_EXPERIMENTAL_AUTH_INTERRUPTS = "1";

const SITE = "00000000-0000-7000-8000-000000000001";
const staff = (role: Membership["role"]): Resolved => ({
  kind: "STAFF",
  role,
  userId: "00000000-0000-7000-8000-0000000000d1",
  displayName: "SYN Dana Mercer Director",
  memberships: [{ siteId: SITE, role }],
});

/** Where a thrown `redirect()` was going, or null when nothing was thrown. */
async function redirectOf(run: () => Promise<unknown>): Promise<string | null> {
  try {
    await run();
    return null;
  } catch (error) {
    const digest = (error as { digest?: unknown })?.digest;
    if (typeof digest === "string" && digest.startsWith("NEXT_REDIRECT")) return digest.split(";")[2];
    throw error;
  }
}

beforeEach(() => {
  getCaller.mockReset();
});

/**
 * THE CASE IT IS FOR: a typed address this role does not open. The front desk has no console
 * page, so each of these is a URL they can only have typed or followed — and each lands them on
 * their own home *with* the sentence.
 */
describe("a blocked address this role typed", () => {
  it.each(["/plan-routes", "/today", "/approvals", "/exceptions"])(
    "sends the front desk home from %s, and says why",
    async (blocked) => {
      const { requirePage } = await import("./page-guard");
      getCaller.mockResolvedValue(staff("FRONT_DESK"));
      const to = await redirectOf(() => requirePage(blocked));
      expect(to).toBe(`/live-map?${NOTICE_PARAM}=${NOT_ON_YOUR_MENU}`);
    },
  );

  /** The "For you" tab is the same thing with a query string on it (src/app/(app)/family-texts). */
  it("says it for a typed ?tab=for-you as well", async () => {
    const page = (await import("../app/(app)/family-texts/page")).default;
    getCaller.mockResolvedValue(staff("FRONT_DESK"));
    const to = await redirectOf(() =>
      page({ searchParams: Promise.resolve({ tab: "for-you" }) } as never),
    );
    expect(to).toBe(`/live-map?${NOTICE_PARAM}=${NOT_ON_YOUR_MENU}`);
  });
});

/**
 * THE CASES IT IS NOT FOR. `/` is where sign-in lands every role (the login action's
 * `redirectTo`), and where the browser goes when somebody opens the app at its root. Both are
 * somebody arriving, not somebody being turned away.
 */
describe("arriving at your own home", () => {
  it.each([...ROLE_LADDER])("sends %s to their home with no notice on it", async (role) => {
    const home = (await import("../app/page")).default;
    getCaller.mockResolvedValue(staff(role));
    const to = await redirectOf(() => home());
    expect(to).toBe(homePathFor({ kind: "STAFF", role }));
    expect(to, "a notice on a landing that refused nobody").not.toContain(NOTICE_PARAM);
  });

  it("sends a signed-out visitor to sign-in, with no notice either", async () => {
    const home = (await import("../app/page")).default;
    getCaller.mockResolvedValue({ kind: "ANONYMOUS", memberships: [] });
    const to = await redirectOf(() => home());
    expect(to).toBe("/login");
    expect(to).not.toContain(NOTICE_PARAM);
  });

  /**
   * And sign-in itself goes through `/` rather than naming a page: one place decides where a
   * role lands, so a front-desk sign-in cannot be sent to a console page and then bounced off
   * it — which is what would put the notice on screen a second after someone typed a password.
   */
  it("signs in through the entry route, not through a page a role might not open", () => {
    const source = readFileSync(
      path.join(__dirname, "..", "app", "login", "page.tsx"),
      "utf8",
    );
    expect(source).toMatch(/redirectTo: "\/"/);
    expect(source).not.toMatch(/redirectTo: "\/(today|live-map|ramp-ipad|plan-routes)/);
    expect(source, "the login action must not attach a notice").not.toContain(NOTICE_PARAM);
    expect(source).not.toContain("withNotice");
  });

  /** The entry route holds no opinion of its own about notices: it has none to attach. */
  it("has no notice in the entry route at all", () => {
    const source = readFileSync(path.join(__dirname, "..", "app", "page.tsx"), "utf8");
    expect(source).not.toContain("withNotice");
    expect(source).not.toContain(NOTICE_PARAM);
  });
});
