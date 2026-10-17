/**
 * WHO GETS THE DEMO'S CONTROL, read off the real screen for the role this run is signed in as.
 *
 * The founder's final ruling (2026-10-17 14:44 ET, DECISION-LEDGER row 72): only the director and
 * the coordinator may put the demo day back, and **the front desk does not see the button at
 * all** — not a disabled one. An inert button is exactly the thing the 14:40 report was about, so
 * "the front desk sees no button" has to be measured on a rendered page and not inferred from a
 * role list.
 *
 * It runs for whichever role the server was started as (`E2E_DEMO_ROLE`, the test-only synthetic
 * session in src/domain/access/map-view.ts, refused outright on any deployment), and it asserts
 * the two halves of that role's answer:
 *
 *  - **the screen** — the control is there for a role the reset endpoint's row names, and the
 *    readout with no control at all for a role it does not;
 *  - **the server** — and for a role it does not name, a POST straight to the endpoint from the
 *    signed-in browser is refused. That is the half hiding a button never does. The role matrix
 *    against a real database is src/auth/idswap.test.ts and src/auth/guard-matrix.test.ts; this
 *    is the same refusal over HTTP, with a real session cookie in front of it.
 *
 * One role per run, because the session is the server's (`E2E_DEMO_ROLE` is read per process):
 * `E2E_DEMO_ROLE=FRONT_DESK E2E_PORT=<free port> pnpm e2e demo-control-roles` is the other half
 * of the default DIRECTOR run, and the PR body records both.
 */
import { expect, test } from "@playwright/test";
import { API, rolesWhoCanCall } from "../src/auth/access";
import type { StaffRole } from "../src/auth/core";
import { scenarioClock } from "../src/ui/copy";
import { expectNoInternalCodes, shot } from "./helpers";

/** The role playwright.config.ts starts the server as. Its default is the director. */
const ROLE = (process.env.E2E_DEMO_ROLE ?? "DIRECTOR") as StaffRole;

/** What the endpoint's own row says about this role — the same list the component reads. */
const MAY_RESET = rolesWhoCanCall(API.demoReset).includes(ROLE);

test.describe(`the demo control as ${ROLE}`, () => {
  test(`is ${MAY_RESET ? "offered" : "not on the screen at all"}`, async ({ page }) => {
    await page.goto("/today");

    // The readout is everyone's: the shell's header carries it on every console route, and a
    // role that cannot restart the day can still read what time the demo is at.
    const readout = page.locator('[data-scenario-clock="readout"]');
    await expect(readout).toBeVisible();
    await expect(readout).toHaveText(scenarioClock.notStarted);

    const start = page.getByRole("button", { name: scenarioClock.start, exact: true });

    if (MAY_RESET) {
      await expect(start).toBeVisible();
      await expect(start).toBeEnabled();
      return;
    }

    // No button, and not a disabled one either: nothing in the clock's row is a control.
    await expect(start).toHaveCount(0);
    await expect(page.getByRole("button", { name: scenarioClock.restart, exact: true })).toHaveCount(0);
    const row = page.locator('[data-scenario-clock="readout"]').locator("xpath=..");
    await expect(row.getByRole("button")).toHaveCount(0);
    await expect(row.locator("button")).toHaveCount(0);
    await expectNoInternalCodes(page);
    console.log("screenshot:", await shot(page, `demo-control-${ROLE.toLowerCase()}`));
  });

  test("the server refuses the reset for a role the table does not name", async ({ page }) => {
    test.skip(MAY_RESET, "this role may reset the demo; the matrix tests own the allowed cells");

    // The signed-in browser's own context, so the request carries whatever session the page has.
    await page.goto("/today");
    const res = await page.request.post(API.demoReset, { data: {} });

    expect(res.status()).toBe(403);
    const body = await res.json();
    expect(body.ok).toBe(false);
    // The refusal names no role, no path and no flag — and carries no "by design" code either.
    expect(JSON.stringify(body)).not.toMatch(/DIRECTOR|COORDINATOR|FRONT_DESK|demo\/reset|DEMO_MODE/);
    expect(Object.keys(body).sort()).toEqual(["error", "ok"]);
  });
});
