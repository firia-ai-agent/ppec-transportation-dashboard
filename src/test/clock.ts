/**
 * The one clock the DB-backed suites pin, and the one every fixture's validity window is cut from.
 * Test-only, like the fixtures that use it.
 *
 * The fixtures used to open their windows at the database's `now() - interval '1 day'`, which
 * agreed with a pinned test clock only for a day: once the real clock passed 2026-10-16T12:00Z,
 * `now() - 1 day` landed *after* the message a test seeds at `TEST_NOW`, so the §6.4 authorization
 * lookup — which reads the window at the message's own arrival time — found no row, the sender was
 * not recognized, and a multi-step run stopped after `resolve_sender`. A fixture's times are
 * therefore always built from the clock the test runs on, never from `now()` or `Date.now()`.
 */
export const TEST_NOW = new Date("2026-10-15T12:00:00.000Z");

/** A day before `at`: when a seeded contact's authorization or consent window opens. */
export function fixtureValidFrom(at: Date): Date {
  return new Date(at.getTime() - 24 * 3600_000);
}
