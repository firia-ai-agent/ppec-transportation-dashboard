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
| 1 | A ride that **ends** HELD_NO_RECEIVER, with no automatic return (AT-13) — recorded on the demo day as well as the finished one (§4), and read on whichever of them the clock has carried past the ride (§5). The demo day can now be **walked** past it, which is where AT-13's browser check reads the hold (ledger row 72) | `src/modules/demo/fixtures/standard.ts` (`DEMO_DAY_RIDES`, what a finished day recorded), `src/domain/board/board.ts` (`rideStateFrom`, `dayRecordFor`), `src/domain/board/day.ts` + `src/domain/eta/scenario-clock.ts` (`demoDayAtTick`, `requestedScenarioTick`), `e2e/today-board.spec.ts` |
| 2 | AT-10 tightened: an arrival and a handoff on one board, told apart | `src/domain/board/board.ts`, `e2e/today-board.spec.ts`, `src/domain/board/board.test.ts` |
| 3 | A disabled control that looks disabled | `src/ui/tokens.ts`, `src/app/(app)/today/today.module.css` |
| 4 | Afternoon arrival windows, from geometry aligned to the scenario | `src/fixtures/run-routes.ts`, `src/domain/eta/eta.ts` (`plannedEta`), `src/domain/location/route.ts` (`reverseRoute`) |
| 5 | One date on screen — the replayed demo day, labelled as the demo day, no switcher and no `?date=` a deployment reads (§4); the drawer's rides as a timeline, headed with the day they are on | `src/domain/board/day.ts` (`dateOverrideAllowed`, `requestedServiceDay`), `src/app/(app)/today/page.tsx`, `src/app/(app)/today/TodayBoard.tsx`, `src/app/(app)/today/LegDrawer.tsx`, `src/ui/copy.ts` |

## 2. The day the board is about (and why AT-13 needed one)

Slice 1's board was a projection at one fixed instant: twelve minutes into the demo day's
morning runs, where one van is stalled, one is inside a GPS gap and one has no displayable
position. Every acceptance story that is about a ride **in flight** is visible there, and no
story about a ride that **ended** can be: at 07:42 nothing has ended. AT-13 is exactly that kind
of story — a leg that ends HELD_NO_RECEIVER — and so is the half of AT-10 that is worth proving,
because a board with no handoff anywhere on it cannot show that an arrival is not one.

So the board now takes a **service date** (PRD §6.1) and reads each day at an instant that
belongs to it. The date on screen is the demo day and nothing changes it — Vera's final call, and
§4 below — so the other three rows of this table are reached by the **test-only date override**,
which is how the browser checks and a design review read the finished day: a `?date=` that the
server reads only in a local synthetic shell that asked for it by name (`E2E_DATE_OVERRIDE=1`,
`dateOverrideAllowed` in `src/domain/board/day.ts`; Veri #49, §4):

| Day | Phase | Read at | What is on it |
|---|---|---|---|
| before the demo day | `ENDED` | 17:30, after the last van is in (MOCKS §7 step 12) | outcomes: ten handoffs, one van arrived with no custody event, one ride holding a child, one run cancelled |
| the demo day | `LIVE` | 07:30 + 12 min, unchanged | the morning in flight — the stall, the GPS gap, the unlinked device. It records the AT-13 ride's acts (§4) but reads them only once the clock is past the ride, so at 07:42 that afternoon is scheduled and says the receiver rule rather than the hold (§5, Firia 2026-10-17) |
| after it | `PLANNED` | 06:00, the scenario clock's start (MOCKS §6) | the plan, and nothing claimed about it |
| a weekend | — | — | no rows at all (PRD §18.1 schedules Mon–Fri); the §5 "No rides scheduled for {date}" line. Its "Change the date" is now a sentence with no control behind it — reachable only by a weekend date through the override, so it is left verbatim as COPY-GUIDE §5 writes it rather than rewritten for a day no console and no deployment can reach |

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
  row and in the drawer, because a coordinator should not have to infer it. **The demo day
  records this one ride as well** (`DEMO_DAY_RIDES`, §4 and §5): same acts, same walk, so the
  walk that opens `/today` reaches it without a `?date=`.
- **C6's afternoon is AT-10.** The van arrived; the handoff was never recorded. "Arrived
  (vehicle)", and the step asks a person for the one thing only a person can do.
- **R3's six rides are AT-12's shape.** V4 is a sedan with two tether-capable seats and all three
  of its riders need an anchored seat, so the solver says it does not fit and staff cancelled
  transport before anyone boarded.

## 3. Slice 1's gaps, answered

| Slice 1 §3 | Now |
|---|---|
| 1. the committed routes and the scenario disagree | **Half closed.** `src/fixtures/run-routes.ts` is one route per run per direction, built from the scenario itself — its own children's own stops, in `manifestFor`'s order, with each family's label and each stop's ASM-12 service time read off the children who ride from it. Every window on the board now comes from geometry that names the child's own stop. The three ADR-007 replay routes were **untouched by this slice**: they are the demo day's live morning, and regenerating them was a change to committed routing data, so it is a call this slice recorded rather than assumed. **It was made — Firia's, within founder locks (DECISION-LEDGER rows 63, 71) — and they were regenerated in the PR after this one** — the three tracks are the runs' own morning geometry now, which closes slice 1's §3.1 outright (docs/ui/B12-SLICE1-DEFERRED.md §3.1, DECISION-LEDGER row 71). What that PR did *not* change is the remnant this slice already had: a van on the road publishes against the replay's clock, which starts at 07:30 — later than the plan's first pickups |
| 2. the afternoon has no committed geometry | **Closed.** The afternoon is the morning reversed (`reverseRoute`), which is what the scenario says a run's afternoon is, and `plannedEta` gives each stop the 10-minute window its family holds. No row on the board says it has no time yet. `run-routes.test.ts` holds every derived arrival to within ten minutes of the window the scenario's plan promised — the two agree, stop by stop, in both directions |
| 3. a seeded profile has no named approver | unchanged |
| 4. a verified capability has no named verifier | unchanged — and now visible in one more place: a morning handoff says "Handed off to the ramp" rather than naming the person who received the child, for the same reason |

And slice 1's open question "the screen shows two service dates" is answered: there is one, it is
in the board's header, it is the replayed demo day and it is labelled as the demo day. The shell's
duplicate (today's real date, on every page including those with no day) is gone, and so is the
switcher that first settled the contradiction — Vera's final call, 2026-10-16: one date, read,
with nothing on screen offering another.

## 4. Deliberate decisions in this slice

| Decision | Why |
|---|---|
| **No date switcher.** One date on screen, in the **board's** header, read and not changed | Vera's final call, 2026-10-16. The date belongs to the day on screen, and the only day this build replays is the demo day: arrows offering a fortnight each way advertised days the demo does not have, and put a coordinator one stray click from a board that is not today. The shell carries no date either — it is rendered by a layout, which cannot read a day, so a date up there could only be today's real date (the contradiction slice 1 flagged) |
| The finished day stays reachable, as a **test-only** override rather than as a URL anyone can type (Veri #49) | It is where AT-10 is *proved* — an arrival and a handoff on one board, told apart — which does not exist on a board twelve minutes into a morning, so deleting the parameter with the switcher would have deleted browser checks of an acceptance test to remove a control that is already gone. But a `?date=` the server read on every deployment *was* the switcher, minus the control: a link in a chat message and a coordinator is reading a finished day. So the route reads the date through `requestedServiceDay`, behind the four gates of `dateOverrideAllowed` — `VERCEL_ENV` unset, `APP_DATA_CLASS=SYNTHETIC`, `DEMO_MODE=1`, `E2E_DATE_OVERRIDE=1` — the same shape as the browser check's synthetic session, and the first of them holds on no deployment we own. `day.test.ts` walks every way the gate closes; `today-board.test.ts` holds that nothing in the console links to another day and that the route reads the date nowhere else |
| The drawer's first heading names the day too ("Rides on Tue, Oct 13"), and the table's screen-reader caption with it | COPY-GUIDE §5's "Today's rides" may only be said on the day it is true of, the same rule the board's heading keeps. The drawer is the sharper case: it opens *over* the header that carries the date, so a panel of a child's finished rides headed "Today's rides" is read with nothing on screen to correct it. The caption is the same falsehood where only the ear can catch it (Veri #49) |
| **The AT-13 hold is on the demo day too** (`DEMO_DAY_RIDES`, Vera 2026-10-16) — **but read off the clock** (Firia, 2026-10-17; §5) | A held child and the rule that nothing brings them back were reachable only by typing a date into the URL, which means the demo walk never showed them — and they are the hardest thing on this board to infer and the worst to learn late. The demo day records that one ride's acts and the machine makes the state as it does everywhere else, and the clock decides when any of it is read. At 07:42 that afternoon says its own time and nothing else — "Drop-off 4:20 PM", no reason, no step, and no needs-action row, so `/today` opens on "Needs action (0)" (Vera, 2026-10-17) — while the missing receiving adult stays on both of Noah O.'s rows in the receiver column and the CA-04 rule stays in his panel. The hold, and the line that asks for the record, are what those acts become once the instant is past 4:20 PM: on the finished day, and — since the scenario clock landed in this slice (founder, ledger row 72) — on the demo day itself, walked there with `?tick=` through the date override's own four gates |
| The heading says "Today" only on the demo day; other days read "Rides on Tue, Oct 13" | COPY-GUIDE §5 fixes "Today" as the SURF-01 heading, and a board of finished rides under it would be the one false sentence on the screen |
| The live day is labelled "Demo day", not "Today" | The demo clock has not started (the readout beside it says so), so the seeded day is the day being *shown*, not the day it is |
| `plannedEta` is a new function rather than `computeEta` with a vehicle at chainage 0 | `computeEta` reports the origin as *passed* — correct for a van standing at its first stop, and wrong for a plan, where the first family is exactly the one at chainage 0 and still needs a window |
| A ride that is over has no needs-action reason | The machine's own `terminal` list decides, not a second list here. `HELD_NO_RECEIVER` is deliberately not in it: a child waiting with a van is the most open thing on the board |
| The drawer footer says "Confirming and overriding aren't connected yet" **once**, in the caption under both controls — and the override keeps a line of its own, "An override skips the ramp check, with a reason on the record.", under its own button, as a muted caption | On the finished day the van is there and an adult is on file, so the three day-shaped reasons are all satisfied — and this slice still does not write. A control that looked available and then did nothing would be the one dishonest thing on the panel. That fact is true of both controls and it is one fact, so it is said once rather than three times — a per-control version on the handoff and on the override, plus the caption, read as three different limits (Vera, #51). The handoff's reason was also the only sentence beside the override, where it read as the child's missing receiver being what stops an override; two controls, two lines, each under its own button, and the override's is muted because nothing is wrong with the day (Vera, 2026-10-16 and #51) |
| Disabled tokens sit at 4.34:1 | WCAG 2.1 exempts an inactive component from 1.4.3 and 1.4.11 altogether. 4.34:1 is weaker than every tone a usable control wears (`tokens.test.ts` asserts exactly that) and still legible; the reason it is disabled keeps full contrast beside it |

## 5. Open questions

- ~~**Vera / Rudy: the hold is ahead of the board's own clock.**~~ **Answered: the hold waits for
  the clock — and the clock now walks** (Firia, 2026-10-17; founder, ledger row 72). The demo day is read twelve minutes into its morning runs and
  the AT-13 ride's window is 4:20 PM, so Noah O.'s afternoon read "Held: no adult to receive"
  while his morning row was still "On the way to pickup" beside it — a child dropped at home
  before the van that collects him had finished its run. `dayRecordFor`
  (`src/domain/board/board.ts`) now compares the day's instant with the ride's planned window and
  will not read a record for a ride the day has not reached: a ride later than the clock is
  scheduled, not held, on every day the projection can build.

  What the demo walk reaches as a result is the **rule** rather than the outcome, and the row it
  is on says only when that ride is: "Drop-off 4:20 PM", with no reason under it and no step
  (Vera, 2026-10-17). The first cut of this left the afternoon under "Needs action" asking a
  coordinator to record a receiver for a van that leaves in eight hours — work nobody can close,
  in the one group that must never be skimmed — so the board a walk opens now reads "Needs action
  (0)" and has no such group at all. What is still said at 07:42 is what a coordinator can act on,
  on the row and in the panel: no adult on file may receive him (the receiver column, both of his
  rows, in the crit tone), and if nobody is there he waits with the van and nothing brings him
  back (CA-04). The ride's own time replaces the published window because a ten-minute window is
  kept against a van's real position and there is no van in motion on a ride nothing has happened
  to. The ended ride itself is read on the finished day, which is where the browser check walked
  it first — the van back, nobody recorded as receiving him, and the line that asks for both the
  call and the record.

  **And on the demo day itself, now that the clock has landed in this slice** (founder, 2026-10-17
  8:46 AM ET, DECISION-LEDGER row 72 — the clock-driven check stays in B-12 rather than moving to
  B-10, because what it proves is the board; the clock it walks on is B-10's and is reused, not
  rebuilt). `demoDayAtTick` reads the demo day at an instant on the scenario clock, `?tick=` on
  /today reaches it through the same four gates as `?date=` (`requestedScenarioTick` calls
  `dateOverrideAllowed`, so no deployment has a clock control, production included), and
  `e2e/today-board.spec.ts` walks the one board from 07:42 — "Drop-off 4:20 PM", nothing asked —
  to 4:25 PM, where the same row is the hold, the step asks a person to call his contacts and
  record who receives him, and the panel says there is no automatic return. The walk arrives at
  CA-04 rather than at a board that quietly dropped it, and nothing about AT-13 is waiting on a
  B-10 row. `board.test.ts` and `today-board.test.ts` hold both ends underneath it: nothing ahead
  of its day's clock is ever held, and the same demo-day record *is* held once the instant is
  past 4:20 PM. One consequence is asserted rather than hidden — the committed replays end at
  08:47, so a board walked to 4:25 PM says every van's last point is hours old ("No signal",
  "Find the van"), which is LOC-03 reading the data the fixture has.
- **Vera:** the drawer's rides are timeline rows now — time column, stops, icon + label state, no
  box. The van, the reason and the step still sit under each row because §4.1 folds those columns
  into this panel below 1280. Is that the right amount, or should the narrow-width extras be
  visually separated from the two-line ride?
- **Vera:** a finished day's rows say "No van location kept" in the van-location column, because
  this slice keeps no position history. Is a column that can only say that worth keeping on a
  finished day, or should it fold away like the three that fold below 1280?
- ~~**Rudy / founder:** the ADR-007 replay routes are still the pre-scenario geometry (§3.1).~~
  **Answered: yes, and they were regenerated in the next PR** (Firia, 2026-10-16, within founder
  locks; DECISION-LEDGER row 71). The tracks are the runs' own morning geometry, the live morning reaches each child's
  own kerb, and the cost — no committed leg is survey-grade any more — is written up in
  docs/ui/B12-SLICE1-DEFERRED.md §3.1.
- **Rudy:** the finished day is a fixture in `standard.ts`, not something `demo reset` seeds. When
  the scenario clock lands (§6.1 dock), the honest version is the clock walking the real day and
  the board reading whatever it has reached. Does the clock subsume this fixture, or stay beside
  it as the "yesterday" the board can look back at? **Half-answered:** the board reads the demo
  day at a tick now (above), and the finished-day check was **kept** beside the walked one — the
  two are different assertions, a record a finished day holds versus a ride ending in front of a
  coordinator. What is still open is the rest of it: a clock that *runs* (the §6.1 dock control
  says "Demo not started" and is connected to nothing), and whether `demo reset` seeds yesterday.

## 6. Evidence, and the commands that regenerate it

Everything a review of this slice reads is produced by one of three commands. All of them write
into `artifacts/`, which is gitignored — the evidence is regenerated, never committed.

**The screenshot set** (README "Browser check" is the canonical copy of this):

```
pnpm e2e                           # the whole set: builds the app, starts it, walks every screen
pnpm e2e e2e/today-board.spec.ts   # the board's own: today-board / arrival-not-handoff /
                                   # held-no-receiver / receiver-rule-before-ride /
                                   # clock-past-dropoff / one-date / drawer / disabled-action /
                                   # needs-action, each at 1024 and 1280
rm -rf artifacts && pnpm e2e       # when the set itself is under review, so no stale PNG survives
```

`pnpm e2e` needs no database and no credentials: `playwright.config.ts` starts the app with the
test-only synthetic session and `E2E_DATE_OVERRIDE=1`, which is the only way a check can reach
the finished day (§4) **or move the board's clock** — one variable, one gate, both parameters. Each file's name is in the `console.log("screenshot:", …)` line of
the test that takes it.

**The AT-10 mutation** (`artifacts/at-10-mutation.txt`): the rule is that a vehicle arriving is
never a child changing hands, and the one line that could break it is in `rideStateFrom`
(`src/domain/board/board.ts`), where a custody event — and nothing else — reaches
`COMPLETED_HANDOFF`. Make that line read the geofence instead and every layer that claims to
hold AT-10 has to fail:

```
sed -i 's/if (facts\.custodyEvent)/if (facts.dropoffArrived)/' src/domain/board/board.ts
pnpm vitest run --maxWorkers=2 src/domain/board/board.test.ts \
  'src/app/(app)/today/today-board.test.ts' src/domain/eta/replay.test.ts \
  src/domain/location/geofence.test.ts
pnpm e2e e2e/today-board.spec.ts -g 'AT-10'
git checkout -- src/domain/board/board.ts    # and re-run both green
```

The artifact is that run, with the tests it named. Regenerate it whenever those tests are
renamed or re-cut, so what it names is what the suite now calls them (Veri #49).
