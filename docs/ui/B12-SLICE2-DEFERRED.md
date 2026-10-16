# Console slice 2: what landed, what it answers, what is still open

```
READER: Rudy (build), Veri (verify), Vera (taste). DECISION IT SERVES: what the next console
change has to pick up, and which of slice 1's gaps are now closed.
STATUS: Written with the slice. The "open" rows are questions, not decisions.
SOURCE: PRD §6.1, §6.3, §6.6 (CA-04), §8, §14 (SURF-01, SURF-02), §18.1–§18.2,
DESIGN-DIRECTION §2, §3, §4.1, §4.2, §8, §9, COPY-GUIDE §1, §5, MOCKS-AND-DEMO §1, §5–§7,
ADR-007, ADR-013, ADR-015, DECISION-LEDGER row 47. Slice 1: docs/ui/B12-SLICE1-DEFERRED.md.
```

## 1. What this slice is

Five things, and the first two are the same change seen from different ends.

| # | Change | Where |
|---|---|---|
| 1 | A ride that **ends** HELD_NO_RECEIVER, with no automatic return (AT-13) | `src/modules/demo/fixtures/standard.ts` (what a finished day recorded), `src/domain/board/board.ts` (`rideStateFrom`) |
| 2 | AT-10 tightened: an arrival and a handoff on one board, told apart | `src/domain/board/board.ts`, `e2e/today-board.spec.ts`, `src/domain/board/board.test.ts` |
| 3 | A disabled control that looks disabled | `src/ui/tokens.ts`, `src/app/(app)/today/today.module.css` |
| 4 | Afternoon arrival windows, from geometry aligned to the scenario | `src/fixtures/run-routes.ts`, `src/domain/eta/eta.ts` (`plannedEta`), `src/domain/location/route.ts` (`reverseRoute`) |
| 5 | One service date for the screen, switchable; the drawer's rides as a timeline | `src/domain/board/day.ts`, `src/ui/ServiceDateSwitcher.tsx`, `src/app/(app)/today/LegDrawer.tsx` |

## 2. The day the board is about (and why AT-13 needed one)

Slice 1's board was a projection at one fixed instant: twelve minutes into the demo day's
morning runs, where one van is stalled, one is inside a GPS gap and one has no displayable
position. Every acceptance story that is about a ride **in flight** is visible there, and no
story about a ride that **ended** can be: at 07:42 nothing has ended. AT-13 is exactly that kind
of story — a leg that ends HELD_NO_RECEIVER — and so is the half of AT-10 that is worth proving,
because a board with no handoff anywhere on it cannot show that an arrival is not one.

So the board now takes a **service date** (`?date=`, PRD §6.1) and reads each day at an instant
that belongs to it:

| Day | Phase | Read at | What is on it |
|---|---|---|---|
| before the demo day | `ENDED` | 17:30, after the last van is in (MOCKS §7 step 12) | outcomes: ten handoffs, one van arrived with no custody event, one ride holding a child, one run cancelled |
| the demo day | `LIVE` | 07:30 + 12 min, unchanged | the morning in flight — the stall, the GPS gap, the unlinked device |
| after it | `PLANNED` | 06:00, the scenario clock's start (MOCKS §6) | the plan, and nothing claimed about it |
| a weekend | — | — | no rows at all (PRD §18.1 schedules Mon–Fri); the §5 "No rides scheduled for {date}" line, which has always ended in "Change the date" |

The instants are whole-day offsets from `SCENARIO_START_MS`, so every day in range is as
deterministic as the demo day and a screenshot of one is still evidence. The range is ±14 days
because whole-day arithmetic is only exact inside one daylight-saving offset, and that is the
window around the seeded Wednesday that stays in EDT (`day.test.ts` holds it).

**The finished day is a fixture, not a second scenario.** `FINISHED_DAY_RIDES` in standard.ts
records *acts* and never states — who reported a child aboard, whether staff verified it, whether
the geofence saw the van reach the drop-off, whether a custody event was recorded — and the leg
machine makes states out of them one legal edge at a time. Three rides depart from the ordinary
outcome, and each is an acceptance test:

- **C2's afternoon is AT-13.** F2 holds every scope except RECEIVE_CHILD, so there was nobody on
  file to receive Noah O. and no custody event to record. `ARRIVED_DROPOFF → HELD_NO_RECEIVER`
  by the system (PRD §6.6 CA-04, ledger row 47), and then nothing: `HELD_NO_RECEIVER` is in the
  machine's `noWildcardFrom` and exits by staff only, so the "no automatic return" rule is the
  machine's own shape rather than a sentence on a screen. The board says it in words too, on the
  row and in the drawer, because a coordinator should not have to infer it.
- **C6's afternoon is AT-10.** The van arrived; the handoff was never recorded. "Arrived
  (vehicle)", and the step asks a person for the one thing only a person can do.
- **R3's six rides are AT-12's shape.** V4 is a sedan with two tether-capable seats and all three
  of its riders need an anchored seat, so the solver says it does not fit and staff cancelled
  transport before anyone boarded.

## 3. Slice 1's gaps, answered

| Slice 1 §3 | Now |
|---|---|
| 1. the committed routes and the scenario disagree | **Half closed.** `src/fixtures/run-routes.ts` is one route per run per direction, built from the scenario itself — its own children's own stops, in `manifestFor`'s order, with each family's label and each stop's ASM-12 service time read off the children who ride from it. Every window on the board now comes from geometry that names the child's own stop. The three ADR-007 replay routes are **untouched**: they are the demo day's live morning (and one of them is a real OSRM response), and regenerating them against the scenario is still a change to committed routing data and still the founder's call. The one visible remnant is that a van on the road publishes against the replay's clock, which starts at 07:30 — later than the plan's first pickups |
| 2. the afternoon has no committed geometry | **Closed.** The afternoon is the morning reversed (`reverseRoute`), which is what the scenario says a run's afternoon is, and `plannedEta` gives each stop the 10-minute window its family holds. No row on the board says "Window pending" any more. `run-routes.test.ts` holds every derived arrival to within ten minutes of the window the scenario's plan promised — the two agree, stop by stop, in both directions |
| 3. a seeded profile has no named approver | unchanged |
| 4. a verified capability has no named verifier | unchanged — and now visible in one more place: a morning handoff says "Handed off to the ramp" rather than naming the person who received the child, for the same reason |

And slice 1's open question "the screen shows two service dates" is answered: there is one, it is
in the board's header, and it is switchable. The shell's duplicate (today's real date, on every
page including those with no day) is gone.

## 4. Deliberate decisions in this slice

| Decision | Why |
|---|---|
| The date switcher is in the **board's** header, not the app shell's | The date belongs to the day on screen. The shell is rendered by a layout, which cannot read `?date=`, so a date up there would have had to be either today's real date (the contradiction slice 1 flagged) or a client component re-deriving the day. Moving it is a one-file change if Vera wants it in the chrome |
| The heading says "Today" only on the demo day; other days read "Rides on Tue, Oct 13" | COPY-GUIDE §5 fixes "Today" as the SURF-01 heading, and a board of finished rides under it would be the one false sentence on the screen |
| The live day is labelled "Demo day", not "Today" | The demo clock has not started (the readout beside it says so), so the seeded day is the day being *shown*, not the day it is |
| `plannedEta` is a new function rather than `computeEta` with a vehicle at chainage 0 | `computeEta` reports the origin as *passed* — correct for a van standing at its first stop, and wrong for a plan, where the first family is exactly the one at chainage 0 and still needs a window |
| A ride that is over has no needs-action reason | The machine's own `terminal` list decides, not a second list here. `HELD_NO_RECEIVER` is deliberately not in it: a child waiting with a van is the most open thing on the board |
| The drawer's disabled "Confirm handoff" has a fourth reason, "Confirming a handoff isn't connected yet" | On the finished day the van is there and an adult is on file, so the three day-shaped reasons are all satisfied — and this slice still does not write. A control that looked available and then did nothing would be the one dishonest thing on the panel |
| Disabled tokens sit at 4.34:1 | WCAG 2.1 exempts an inactive component from 1.4.3 and 1.4.11 altogether. 4.34:1 is weaker than every tone a usable control wears (`tokens.test.ts` asserts exactly that) and still legible; the reason it is disabled keeps full contrast beside it |

## 5. Open questions

- **Vera:** the drawer's rides are timeline rows now — time column, stops, icon + label state, no
  box. The van, the reason and the step still sit under each row because §4.1 folds those columns
  into this panel below 1280. Is that the right amount, or should the narrow-width extras be
  visually separated from the two-line ride?
- **Vera:** a finished day's rows say "No position recorded" in the van-location column, because
  this slice keeps no position history. Is a column that can only say that worth keeping on a
  finished day, or should it fold away like the three that fold below 1280?
- **Rudy / founder:** the ADR-007 replay routes are still the pre-scenario geometry (§3.1). The
  run-aligned routes now exist and agree with the plan, so regenerating the replays against them
  is a smaller change than it was — it would also give the live morning real per-child pickup
  arrivals. Worth the committed-data change before the demo?
- **Rudy:** the finished day is a fixture in `standard.ts`, not something `demo reset` seeds. When
  the scenario clock lands (§6.1 dock), the honest version is the clock walking the real day and
  the board reading whatever it has reached. Does the clock subsume this fixture, or stay beside
  it as the "yesterday" the board can look back at?
