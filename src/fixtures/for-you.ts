/**
 * THE DEMO DAY'S "FOR YOU" QUEUE, as a count.
 *
 * REDESIGN-SPEC §9.2 and the founder's mockups put a count badge on Family texts — "2" in
 * png/shell-flow-1440.png — and Vera's audit §2 item 2 names it as missing from the rail. This
 * is where that number comes from, and it is a *fixture*, in the folder every other number the
 * demo draws comes from (src/fixtures/fleet.ts, replays.ts, map.ts): the scenario is synthetic
 * by construction (ADR-015, APP_DATA_CLASS=SYNTHETIC), so the demo day has two things waiting on
 * a person in Family texts · For you, and the badge says two.
 *
 * It is a count and nothing else — no invented parent text, no invented proposal. What those two
 * items *are* is signed off in docs/DATA-MODEL.md (an `approval_request` of kind DROPOFF_CHANGE,
 * and the NEEDS_PERSON staff alert, which "counts toward the Family texts badge", Firia 8:37 PM
 * ET on 2026-10-17) and both are read from `ops.*` rows by the screen that lands with #61. When
 * that read exists, this constant is replaced by it and the badge stops being a fixture; nothing
 * else moves, because the badge asks one function (src/ui/menu-badge.ts) rather than this file.
 */
export const FOR_YOU_WAITING = 2;
