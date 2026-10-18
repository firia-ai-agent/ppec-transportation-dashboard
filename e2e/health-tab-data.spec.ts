/**
 * THE HEALTH TAB, COUNTED FROM A SEEDED DAY — a throwaway local Postgres, not the empty session.
 *
 * png/health-demo-1440.png and png/health-demo-390.png: four Right now tiles. The figures on
 * those pictures are what a day's rows add up to. This run starts from three vans and five
 * children and no other rows, records the tiles and the step strip, then changes the rows the
 * way a coordinator would and reads the screen again. A screen with the numbers written on it
 * cannot follow both changes.
 *
 * Firia ruling 2026-10-17: Health = four Right-now tiles on Today, and the van-checked count
 * is the step strip's own count. docs/DATA-MODEL.md: a van check is `vehicle_setup_day` in
 * state CHECKED, the plan is `plan_run` / `plan_assignment`, a late van is the latest
 * `eta_estimate` past its window, and a staff alert is an open `ops.task` of kind NEEDS_PERSON.
 *
 * The database is the one e2e/db-server.ts just created on 127.0.0.1. This file refuses any
 * other host.
 */
import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { Client } from "pg";
import { DEMO_SITE_A } from "../src/auth/seed";
import { legAt, serviceDateAt } from "../src/domain/day/day-facts";
import { vanOnScreen } from "../src/domain/health/right-now";
import { demoLogins, fill, flow, healthNow, login, nav } from "../src/ui/copy";
import { shot } from "./helpers";

const WIDTHS = [1440, 390] as const;

type Tone = "ok" | "warn" | "info" | "neutral";

/** What one tile must say after a reload. `pill` absent means the tile has no chip. */
type TileExpect = { label: string; figure: string; pill?: string; tone?: Tone };

function databaseUrl(): string {
  const file = JSON.parse(readFileSync("artifacts/health-db.json", "utf8")) as { databaseUrl?: string };
  const url = file.databaseUrl ?? "";
  const host = new URL(url).hostname;
  if (host !== "127.0.0.1" && host !== "localhost") {
    throw new Error("health-tab-data refuses a database that is not on this machine");
  }
  return url;
}

async function signIn(page: Page, role: "DIRECTOR" | "COORDINATOR"): Promise<void> {
  await page.context().clearCookies();
  await page.goto("/login");
  await page.getByRole("button", { name: fill(demoLogins.useRole, { role: demoLogins.roles[role].title }) }).click();
  await page.getByRole("button", { name: login.submit }).click();
  await expect(page).not.toHaveURL(/\/login/, { timeout: 30_000 });
}

async function at(page: Page, width: number): Promise<void> {
  await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
}

/** The strip is the board's. Read it there, then open Health and read the four tiles. */
async function readDay(page: Page, tiles: readonly TileExpect[], checked: number, total: number): Promise<void> {
  await page.goto("/today");
  const strip = page.getByRole("navigation", { name: flow.stepsAria });
  // Firia ruling 2026-10-17: Vans checked and Van setup are one count.
  await expect(strip).toContainText(fill(flow.detail.setup, { checked, total }));
  await page.getByRole("tab", { name: healthNow.health }).click();
  const panel = page.getByRole("tabpanel", { name: healthNow.health });
  const cards = panel.getByRole("link");
  await expect(cards).toHaveCount(4);
  for (const tile of tiles) {
    const card = cards.filter({ hasText: tile.label });
    const text = (await card.innerText()).replace(/\s+/g, " ").trim();
    const label = tile.label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const figure = tile.figure.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // The figure is the tile's own number, not a digit inside another tile's fraction.
    expect(text).toMatch(new RegExp(`${label}\\s+${figure}(?!\\d)`));
    const pill = card.locator("[data-pill]");
    if (tile.pill) {
      // png/health-demo-1440.png, png/health-demo-390.png: All is green, a van is amber,
      // Family texts is the info teal, and a zero is the grey None.
      await expect(pill).toContainText(tile.pill);
      await expect(pill).toHaveAttribute("data-tone", tile.tone ?? "");
    } else {
      await expect(pill).toHaveCount(0);
    }
  }
}

/**
 * The row changes from the walk, against this centre and this leg.
 *
 * docs/DATA-MODEL.md: CHECKED is the van check, the plan seats a child in a van or leaves them
 * unassigned, a manifest carries the leg the estimate is about, and NEEDS_PERSON / OPEN is the
 * staff alert.
 */
async function applyFirstChange(db: Client, date: string, leg: string): Promise<void> {
  const vans = (
    await db.query<{ id: string; label: string }>(
      "select id::text, label from ops.vehicle where site_id = $1 order by label",
      [DEMO_SITE_A],
    )
  ).rows;
  const kids = (
    await db.query<{ t: string }>(
      "select child_token::text as t from ops.child_profile where site_id = $1 order by child_token limit 5",
      [DEMO_SITE_A],
    )
  ).rows;
  expect(vans.map((v) => v.label)).toEqual(["V1", "V2", "V3"]);
  expect(kids).toHaveLength(5);

  for (const van of vans.slice(0, 2)) {
    await db.query(
      `INSERT INTO ops.vehicle_setup_day
         (id, site_id, vehicle_id, service_date, seats, wheelchair_spots, car_seats, oxygen_mounts, has_lift, state, created_by, updated_by)
       VALUES (gen_random_uuid(), $1, $2, $3, 4, 0, 0, 0, true, 'CHECKED', 'veri', 'veri')`,
      [DEMO_SITE_A, van.id, date],
    );
  }
  const run = (
    await db.query<{ id: string }>(
      `INSERT INTO ops.plan_run (id, site_id, service_date, direction, created_by, updated_by)
       VALUES (gen_random_uuid(), $1, $2, $3, 'veri', 'veri') RETURNING id::text`,
      [DEMO_SITE_A, date, leg],
    )
  ).rows[0]!.id;
  for (const [i, kid] of kids.entries()) {
    await db.query(
      `INSERT INTO ops.plan_assignment
         (plan_run_id, site_id, child_token, vehicle_id, bucket, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, 'veri', 'veri')`,
      [run, DEMO_SITE_A, kid.t, i < 4 ? vans[0]!.id : null, i < 4 ? "VAN" : "UNASSIGNED"],
    );
  }
  const manifest = (
    await db.query<{ id: string }>(
      `INSERT INTO ops.manifest (id, site_id, service_date, direction, vehicle_id, created_by, updated_by)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, 'veri', 'veri') RETURNING id::text`,
      [DEMO_SITE_A, date, leg, vans[1]!.id],
    )
  ).rows[0]!.id;
  const legRow = (
    await db.query<{ id: string }>(
      `INSERT INTO ops.trip_leg
         (id, site_id, child_token, service_date, direction, mode, manifest_id, created_by, updated_by)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, 'PROVIDER', $5, 'veri', 'veri') RETURNING id::text`,
      [DEMO_SITE_A, kids[0]!.t, date, leg, manifest],
    )
  ).rows[0]!.id;
  await db.query(
    `INSERT INTO ops.eta_estimate
       (id, site_id, trip_leg_id, computed_at, eta_at, uncertainty_sec, window_start, window_end, created_by, updated_by)
     VALUES (gen_random_uuid(), $1, $2, now(), now() + interval '20 minutes', 60, now() - interval '20 minutes', now(), 'veri', 'veri')`,
    [DEMO_SITE_A, legRow],
  );
  for (let i = 0; i < 3; i++) {
    await db.query(
      `INSERT INTO ops.task
         (id, site_id, category, severity, state, summary, completion_predicate, created_by, updated_by)
       VALUES (gen_random_uuid(), $1, 'NEEDS_PERSON', 'RED', 'OPEN', 'veri probe', 'staff', 'veri', 'veri')`,
      [DEMO_SITE_A],
    );
  }
}

/** Resolve one open alert and check the van that is still open. docs/DATA-MODEL.md. */
async function applySecondChange(db: Client, date: string): Promise<void> {
  const resolved = await db.query(
    `UPDATE ops.task SET state = 'RESOLVED_APPROVED'
      WHERE id = (
        SELECT id FROM ops.task
         WHERE site_id = $1 AND category = 'NEEDS_PERSON' AND state = 'OPEN'
         LIMIT 1
      )`,
    [DEMO_SITE_A],
  );
  expect(resolved.rowCount).toBe(1);
  const open = (
    await db.query<{ id: string }>(
      `SELECT v.id::text FROM ops.vehicle v
        WHERE v.site_id = $1
          AND NOT EXISTS (
            SELECT 1 FROM ops.vehicle_setup_day s
             WHERE s.vehicle_id = v.id AND s.service_date = $2
          )
        ORDER BY v.label
        LIMIT 1`,
      [DEMO_SITE_A, date],
    )
  ).rows;
  expect(open).toHaveLength(1);
  await db.query(
    `INSERT INTO ops.vehicle_setup_day
       (id, site_id, vehicle_id, service_date, seats, wheelchair_spots, car_seats, oxygen_mounts, has_lift, state, created_by, updated_by)
     VALUES (gen_random_uuid(), $1, $2, $3, 4, 0, 0, 0, true, 'CHECKED', 'veri', 'veri')`,
    [DEMO_SITE_A, open[0]!.id, date],
  );
}

test("changing the day's rows moves the four tiles and the step strip, at 1440 and at 390", async ({ page }) => {
  const db = new Client({ connectionString: databaseUrl() });
  await db.connect();
  try {
    const date = serviceDateAt();
    const leg = legAt();
    // The stored labels are the codes. The pills say the mockup's words.
    const van2 = vanOnScreen("V2");
    const van3 = vanOnScreen("V3");

    const before: TileExpect[] = [
      { label: healthNow.kidsPlaced, figure: "0/0", pill: healthNow.none, tone: "neutral" },
      // Firia, 2026-10-18: nothing checked is three vans to check, and the chip names none of
      // them — a name waits until one van is all that is left (then it reads "Van 3", below).
      {
        label: healthNow.vansChecked,
        figure: "0/3",
        pill: fill(healthNow.toCheck, { n: 3 }),
        tone: "warn",
      },
      { label: healthNow.runningLate, figure: "0", pill: healthNow.none, tone: "neutral" },
      { label: healthNow.needsYou, figure: "0", pill: healthNow.none, tone: "neutral" },
    ];
    // docs/DATA-MODEL.md: nothing checked, nothing saved, no estimate, no open alert.
    await signIn(page, "DIRECTOR");
    for (const width of WIDTHS) {
      await at(page, width);
      await readDay(page, before, 0, 3);
    }

    await applyFirstChange(db, date, leg);
    // 2 of 3 vans CHECKED, 4 of 5 children in a van, one late estimate, 3 open alerts.
    const after: TileExpect[] = [
      { label: healthNow.kidsPlaced, figure: "4/5" },
      { label: healthNow.vansChecked, figure: "2/3", pill: van3, tone: "warn" },
      { label: healthNow.runningLate, figure: "1", pill: van2, tone: "warn" },
      { label: healthNow.needsYou, figure: "3", pill: nav.familyTexts, tone: "info" },
    ];
    for (const width of WIDTHS) {
      await at(page, width);
      await readDay(page, after, 2, 3);
      // png/health-demo-1440.png, png/health-demo-390.png: Family texts is the info chip.
      const family = page
        .getByRole("tabpanel", { name: healthNow.health })
        .getByRole("link")
        .filter({ hasText: healthNow.needsYou })
        .locator("[data-pill]");
      const tone = await family.evaluate((el) => {
        const probe = document.createElement("div");
        probe.style.backgroundColor = "var(--color-info-bg)";
        probe.style.color = "var(--color-info-fg)";
        document.body.appendChild(probe);
        const want = getComputedStyle(probe);
        const got = getComputedStyle(el);
        const read = {
          bg: got.backgroundColor,
          fg: got.color,
          wantBg: want.backgroundColor,
          wantFg: want.color,
        };
        probe.remove();
        return read;
      });
      expect(tone.bg).toBe(tone.wantBg);
      expect(tone.fg).toBe(tone.wantFg);
      console.log("screenshot:", await shot(page, `health-tab-seeded-${width}`));
    }

    await applySecondChange(db, date);
    // One alert resolved, the third van checked: All is the green chip, and two alerts remain.
    const again: TileExpect[] = [
      { label: healthNow.kidsPlaced, figure: "4/5" },
      { label: healthNow.vansChecked, figure: "3/3", pill: healthNow.all, tone: "ok" },
      { label: healthNow.runningLate, figure: "1", pill: van2, tone: "warn" },
      { label: healthNow.needsYou, figure: "2", pill: nav.familyTexts, tone: "info" },
    ];
    for (const width of WIDTHS) {
      await at(page, width);
      await readDay(page, again, 3, 3);
    }
    console.log("screenshot:", await shot(page, "health-tab-seeded-1440-all"));

    // The same centre, read by the coordinator: the numbers are the day's, not the director's.
    await signIn(page, "COORDINATOR");
    for (const width of WIDTHS) {
      await at(page, width);
      await readDay(page, again, 3, 3);
    }
  } finally {
    await db.end();
  }
});
