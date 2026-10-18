import { endpointRow, API } from "@/auth/access";
import type { StaffRole } from "@/auth/core";
import { demoBanner } from "./copy";
import { isSyntheticDemo } from "@/lib/env";
import { DemoClock } from "./DemoClock";
import { DemoRestart } from "./DemoRestart";
import { ScreenSource } from "./ScreenSource";
import styles from "./DemoBanner.module.css";

/**
 * DESIGN-DIRECTION §7 / NFR-09 / REDESIGN-SPEC §0: a 32 px full-width violet bar above
 * everything, reading
 * `DEMO · Synthetic data · [Simulated] ……… [Scenario clock] [Restart demo day]`. Text exactly
 * "DEMO" and **no icon before it** (COPY-GUIDE §6, audit §2 item 4 — the flask belonged to the
 * §7.1 chip and the bar was wearing a second copy of it), role="status" with aria-label "DEMO"
 * too (ledger row 40 covers the screen-reader label), announced once on load. Not dismissible.
 *
 * The bar carries the one screen-level source-mode chip (§7.1, NFR-09) — Vera's answer,
 * 2026-10-14: the chip goes *next to* the banner as the small outlined D-10 chip, and there is
 * no second full-width strip under it. `role="status"` wraps the "DEMO" text only, so a reader
 * announces the banner and the chip as the two separate things they are.
 *
 * **And it carries the demo's one control.** "Restart demo day" was "Start demo day" in the
 * white app header, beside a readout of a state nothing set, and it did nothing — the control
 * and the readout are both gone and this is the reset the app already has, in the bar the
 * founder's mockups put it in (png/shell-flow-1440.png). The bar is the right home for it: it
 * is the one piece of chrome that is about the *demo* rather than about the day.
 *
 * Rendered only while the environment is synthetic. P1 is synthetic by construction
 * (src/lib/env.ts refuses to start otherwise), so in practice it always renders; the guard
 * is what keeps the demo violet out of a future LIVE build (§7, D-5). The chip rides with the
 * bar because in LIVE the bar itself becomes the slim neutral "LIVE" chip (§7) — there is no
 * violet banner left for a separate chip to sit beside.
 */
export function DemoBanner({
  role,
  vanCount,
}: {
  role: StaffRole | null;
  /**
   * How many vans the day runs, for the one sentence that is about them: "Restart demo day" asks
   * before it throws a saved plan away, and the question names the vans it covers
   * (`demoDay.confirm.body`). Read where the fleet is read — src/ui/DemoBar.tsx, which is this
   * bar's one server component — so no component in the bar knows a fleet size of its own.
   */
  vanCount: number;
}) {
  if (!isSyntheticDemo()) return null;
  return (
    <div className={styles.banner}>
      {/*
        "DEMO", with no flask beside it. Audit §2 item 4: "the mockup reads exactly 'DEMO' then
        'Synthetic data', with no icon before DEMO" — the flask is the §7.1 chip's own mark, and
        the bar was wearing it a second time two words away from it.
      */}
      <p className={styles.demo} role="status" aria-label={demoBanner.ariaLabel}>
        <span className={styles.text}>{demoBanner.text}</span>
      </p>
      {/* What the demo is. Dropped below 768 (REDESIGN-SPEC §0) — the stylesheet says why. */}
      <p className={styles.what}>{demoBanner.syntheticData}</p>
      {/* §7.1 / NFR-09: the single screen-level source chip, beside the words. */}
      <div className={styles.source}>
        <ScreenSource />
      </div>
      <div className={styles.spacer} />
      {/*
        The scenario clock, at the trailing end and before the reset (Firia, 8:36 PM ET). It
        draws itself only on the screen it moves — the live map — and the controls only for a
        role that holds them (src/ui/DemoClock.tsx).
      */}
      <DemoClock role={role} />
      {canRestartDemo(role) ? <DemoRestart vanCount={vanCount} /> : null}
    </div>
  );
}

/**
 * Who sees the button, read from the one table that decides who the reset answers.
 *
 * REDESIGN-SPEC §0 says the control is hidden for the front desk, and the server refuses them
 * (the reset's row is DIRECTOR, and `POST /api/demo/reset` answers 403 for every other role —
 * src/app/api/demo/reset/route.test.ts). Those are the same fact, so this asks the table rather
 * than keeping a list of its own: the front desk is excluded *because* the server excludes
 * them, and a control that would answer 403 to the person looking at it is never drawn.
 *
 * Change who may reset, in the access table, and the bar follows on the same commit.
 */
export function canRestartDemo(role: StaffRole | null): boolean {
  if (!role) return false;
  const row = endpointRow(API.demoReset)?.auth;
  return row?.kind === "session" && row.roles.includes(role);
}
