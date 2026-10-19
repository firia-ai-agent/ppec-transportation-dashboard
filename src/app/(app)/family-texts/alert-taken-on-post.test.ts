/**
 * A "NEEDS A PERSON" ALERT IS TAKEN BY A PRESS, AND BY NOTHING ELSE.
 *
 * Firia's S1-4 (2026-10-18 12:13 AM ET), on Veri's checklist item 8: `openAlert` is an UPDATE —
 * `ops.task` `OPEN → IN_PROGRESS` — and it used to run inside the `/exceptions` page's **GET**
 * render. Two things follow from a state change on a GET, and both are real: a browser or a
 * crawler prefetching the link claims an alert nobody has read, and a reload tells a second
 * coordinator that somebody is already handling a text nobody has looked at.
 *
 * So the three claims here, in the order they matter:
 *
 *  1. **No render mutates.** The reads the "For you" tab actually does — `openAssistantAlerts`
 *     and `assistantAlertCount` — leave the row `OPEN`, and `/exceptions` is a redirect with no
 *     read at all. Held structurally too: nothing under `src/app` calls `openAlert` except the
 *     one server action.
 *  2. **A POST takes it.** `takeAlertAction`, the real server action the button submits to.
 *  3. **The front desk is refused.** They reach neither the page nor the tab, and the action
 *     refuses them anyway, because hiding a control is not a guard (the ID-swap rule).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import type { PGlite } from "@electric-sql/pglite";
import type { Db } from "@/db/exec";
import { APPROVAL_ROLES } from "@/auth/access";
import {
  assistantAlertCount,
  openAssistantAlerts,
  raiseModelUnavailableAlert,
} from "@/modules/agent/staff-alert";
import { unwiredIdentityGateway } from "@/modules/identity/gateway";
import { seedStaff } from "@/test/messaging";
import { seedAgentScenario, type AgentScenario } from "@/test/agent-state";
import { freshDb } from "@/test/pglite";

/** The caller the action sees. The database membership is seeded to match, per test. */
const caller = vi.fn();
vi.mock("@/auth/caller", () => ({ getCaller: () => caller() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
const neon = vi.fn();
vi.mock("@/db/exec", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/db/exec")>()),
  getNeonDb: () => neon(),
}));

let pg: PGlite;
let db: Db;
let sc: AgentScenario;
let alertId: string;

beforeEach(async () => {
  ({ pg, db } = await freshDb());
  vi.clearAllMocks();
  neon.mockImplementation(() => db);
  sc = await seedAgentScenario(db, { body: "is someone else picking him up?" });
  ({ id: alertId } = await raiseModelUnavailableAlert(db, {
    siteId: sc.siteId,
    messageId: sc.messageId,
    reason: "provider_error",
    by: "test",
  }));
});

afterEach(async () => {
  await pg.close();
});

const stateOf = async () =>
  (await db.query<{ state: string }>("SELECT state FROM ops.task WHERE id = $1", [alertId]))
    .rows[0].state;

async function signedIn(role: "DIRECTOR" | "COORDINATOR" | "FRONT_DESK") {
  const userId = await seedStaff(db, role, sc.siteId);
  caller.mockResolvedValue({ kind: "STAFF", role, userId, memberships: [{ siteId: sc.siteId, role }] });
  return userId;
}

const take = async (id: string = alertId) => {
  const { takeAlertAction } = await import("./actions");
  const form = new FormData();
  form.set("alert", id);
  await takeAlertAction(form);
};

describe("reading the For you tab does not take an alert (S1-4)", () => {
  it("the alert reads OPEN before anybody has pressed anything", async () => {
    expect(await stateOf()).toBe("OPEN");
  });

  it("the tab's own reads leave it OPEN, however many times they run", async () => {
    // These two are exactly what `/family-texts` calls on a render (page.tsx `readAlerts`, and
    // the rail badge's count). Three renders, because a claim-on-read would show up on the first.
    for (let i = 0; i < 3; i += 1) {
      const alerts = await openAssistantAlerts(db, [sc.siteId], unwiredIdentityGateway());
      expect(alerts).toHaveLength(1);
      expect(alerts[0].beingHandled).toBe(false);
      expect(await assistantAlertCount(db, [sc.siteId])).toBe(1);
    }
    expect(await stateOf()).toBe("OPEN");
  });
});

describe("a press takes it, and says who has it", () => {
  for (const role of APPROVAL_ROLES) {
    it(`a ${role} takes it with a POST`, async () => {
      await signedIn(role as "DIRECTOR" | "COORDINATOR");
      await take();
      expect(await stateOf()).toBe("IN_PROGRESS");
      // And the card now says so, which is what the second coordinator reads.
      const [alert] = await openAssistantAlerts(db, [sc.siteId], unwiredIdentityGateway());
      expect(alert.beingHandled).toBe(true);
    });
  }

  it("a second press changes nothing: the alert is already taken", async () => {
    await signedIn("COORDINATOR");
    await take();
    await take();
    expect(await stateOf()).toBe("IN_PROGRESS");
  });

  it("an id this caller has no membership for updates nothing", async () => {
    const userId = await seedStaff(db, "DIRECTOR", sc.siteId);
    // A real session, a real role — and a membership list that does not hold this alert's site.
    caller.mockResolvedValue({
      kind: "STAFF",
      role: "DIRECTOR",
      userId,
      memberships: [{ siteId: "00000000-0000-7000-8000-0000000000b1", role: "DIRECTOR" }],
    });
    await take();
    expect(await stateOf()).toBe("OPEN");
  });
});

describe("the front desk is refused, on the server (gate 8)", () => {
  it("a front-desk POST takes nothing", async () => {
    expect(APPROVAL_ROLES).not.toContain("FRONT_DESK");
    await signedIn("FRONT_DESK");
    await take();
    expect(await stateOf()).toBe("OPEN");
  });

  it("and neither does a caller with no session at all", async () => {
    caller.mockResolvedValue({ kind: "ANONYMOUS", memberships: [] });
    await take();
    expect(await stateOf()).toBe("OPEN");
  });
});

/* ──────────── the structural half: no GET path can reach the UPDATE ──────────── */

const ROOT = resolve(__dirname, "..", "..", "..", "..");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (/node_modules|\.next/.test(p)) continue;
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(p)) out.push(relative(ROOT, p));
  }
  return out;
}

describe("openAlert has exactly one caller in src/app, and it is the POST", () => {
  it("names it, so a second caller on a render path fails here", () => {
    const source = (f: string) => readFileSync(join(ROOT, f), "utf8");
    const notTests = (f: string) => !f.endsWith(".test.ts") && !f.endsWith(".test.tsx");
    /*
     * openAlert is an UPDATE (OPEN → IN_PROGRESS). It belongs to a POST and to nothing a render can
     * reach — Firia's S1-4, 2026-10-18 12:13 AM ET. Since ledger #74 the one call is the action
     * layer's `take_alert` (modules/actions/decisions.ts), and in src/app the one thing that runs
     * that is the server action.
     */
    const callers = walk(join(ROOT, "src"))
      .filter(notTests)
      .filter((f) => f !== "src/modules/agent/alert-task.ts") // where it is defined
      .filter((f) => /\bopenAlert\s*\(/.test(source(f)))
      .sort();
    expect(callers).toEqual(["src/modules/actions/decisions.ts"]);
    const appRunners = walk(join(ROOT, "src", "app")).filter(notTests).filter((f) => /\btake_alert\b/.test(source(f)));
    expect(appRunners).toEqual(["src/app/(app)/family-texts/actions.ts"]);
  });

  it("and /exceptions is a redirect that reads nothing at all", () => {
    const page = readFileSync(join(ROOT, "src/app/(app)/exceptions/page.tsx"), "utf8");
    expect(page).toContain("permanentRedirect");
    expect(page).not.toContain("openAlert");
    expect(page).not.toMatch(/searchParams/);
  });
});
