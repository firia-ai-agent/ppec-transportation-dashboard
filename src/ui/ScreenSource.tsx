import { uiSourceMode } from "@/lib/env";
import { SourceBadge } from "./SourceBadge";

/**
 * The screen-level source-mode badge (NFR-09, §7.1: "on every screen, record and outbound
 * message"). Vera's answer, 2026-10-14: it is the small outlined D-10 chip next to the DEMO
 * banner — not a strip of its own — and it is the same chip in the same place on every screen,
 * sign-in included, rather than moving next to the sign-in card title.
 *
 * DemoBanner places it, and DemoBanner is in the *root* layout, so "every screen" includes the
 * ones outside the app shell: /login, the whoami developer page, and any future signed-link
 * page. A visitor must never see a PPEC screen without being told where its data comes from.
 * Mounting it in exactly one place is also what keeps a second, contradicting badge away.
 */
export function ScreenSource() {
  return <SourceBadge mode={uiSourceMode()} />;
}
