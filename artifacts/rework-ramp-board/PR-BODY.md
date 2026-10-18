# Rework 2: arrival counters + plan board

**Not a PR yet, by instruction** (Firia, 2026-10-17 6:19 PM ET): this body is written down here and
the branch `team/ppe-rework-ramp-board` is pushed. Nothing was opened, marked ready or reviewed.

This merges **second**, after the frame (Rework 1). `origin/team/ppe-rework-frame` appeared while
this was being built and **is merged in** (`4bdd034`, merge commit "Merge the frame (Rework 1)"),
together with `origin/main` (#70). So the board and the ramp render **inside the frame's shell**:
the 232 px rail at 1440, the 64 px bottom tab bar at 390, one header row, one Simulated chip. The
two screens are each their own `<main>` inside `ConsoleShell` (the layouts the frame added at
`src/app/plan-routes/layout.tsx` and `src/app/ramp-ipad/layout.tsx`), and the room for the tab bar
is the shell's padding, not a second copy of it here.

## The 7:17–7:27 PM ET scope (founder, Firia + Vera, Athena, Veri)

A second round landed after the first build: the board gained **drag between vans and onto Absent
or Family drives**, a **child panel** with three Yes/No answers, and a needs layer that is **rows
rather than a fixture**. Everything below in this section is that round.

**No migration, and none is needed** (Athena 7:19 PM ET, signed off by Firia):
`ops.transport_need_item.category` is `text`, so `OXYGEN` is a new string; `state` is the existing
`need_item_state` enum and `APPROVED` is one of its values; `plan_assignment.bucket` already
allows `ABSENT` and `FAMILY_DRIVES` with a null `vehicle_id` (0009:46-48). `git diff origin/main
-- drizzle/` is empty.

### Absence, and every other move, has one writer
`setChildPlacement({siteId, serviceDate, direction, childToken, bucket, vehicleId, expectedVersion,
actor})` — **src/modules/plan/place.ts** — is the only thing that changes a child's bucket. The
drag, the drop on Absent, the drop on Family drives and `Move to…` all go through it, and so does
`setChildAwayAllDay`, which is the same call for AM and PM (all-day absent is two plans, because a
plan is per date **and** per leg). Its JSDoc says in as many words that **#61's agent cancel will
call this same function** rather than writing `plan_assignment` or touching `ops.attendance_day`.
Absence is read from the plan and nowhere else; tomorrow starts clean because tomorrow is a
different plan (asserted).

Every move writes a **new `plan_run.version`** (never a silent overwrite) and a stale version is a
409. Proved in rows: `src/modules/plan/place.db.test.ts`.

### Needs are rows, and a Save moves the board
- `src/domain/plan/needs.ts` no longer imports `CHILDREN`. It takes **categories** and returns
  flags; where the categories come from is the roster's business.
- **`src/modules/roster/sql.ts`** is the DB reader behind the one day-data port: children from
  `ops.child_profile`, legs and windows from `ops.attendance_plan`, stops from
  `ops.stop_location`, and flags from the **APPROVED** items on the child's **APPROVED**
  `transport_profile`. `src/modules/plan/store.ts` picks it whenever `DATABASE_URL` is set and the
  demo adapter otherwise.
- **`src/modules/roster/needs-write.ts`** is the write path: it upserts/flips items on the child's
  existing approved profile — **no new profile version** — setting `APPROVED` for a Yes and
  `UNKNOWN` for a No (only `APPROVED` is planned against, so "off" is a state, not a deletion).
- **`transport_profile.mobility` is untouched.** A chair is the approved `WHEELCHAIR_SECUREMENT`
  item and nothing else, which is what makes the panel's Wheelchair toggle actually change the
  plan. Every `WC` child in the synthetic day already carries that item, so no rider changed by
  this. (Asserted: "leaves transport_profile.mobility exactly as intake left it".)
- **Oxygen is `OXYGEN` + `APPROVED`** in the seed and the fixtures, where it used to be
  `MEDICAL_DEVICE_POWER` + `REPORTED` and therefore planned against nothing. Zoe B. keeps a
  separate reported-but-unapproved item (the portable suction), so PRD l.1329's "one unapproved
  item" is still demonstrable and the approved-only rule is still visible.
- After a Save the leg is **re-planned on the new needs** through the same `fit.ts` placement
  (unpinned children re-placed, pinned kept) and saved as a new version.

### Gate (a): one category list
`NEED_CATEGORY` in **src/config/equipment.ts** exports `WHEELCHAIR_SECUREMENT`,
`CAR_SEAT_OR_BOOSTER` and `OXYGEN` (plus the nurse's and the harness's). The panel, the write
path, the planner, the seed, the fixtures, the agent's tool schema and `copy.ts`'s labels all read
them from there. **src/config/need-categories.test.ts** scans every `.ts`/`.tsx` under `src/` and
fails on a literal of any of the three outside that module — with two documented exemptions: comment
prose, and the files that use the word `OXYGEN` as a **reject reason** (`fit.ts`, `fit.test.ts`,
`copy.ts`), a different vocabulary that touches no need item.

### The board, as drawn
Tapping a card opens the panel from `plan-board-child-*.png`: the child's name, "Van 3 ·
Afternoon", three Yes/No rows (Wheelchair, Car seat, Oxygen), Save, and "Saving updates the plan".
At 390 it is the bottom sheet with the grab handle. No "riding today" toggle, no sheet page, no
setup popover. Labels and icons come from the shared equipment list.

**Roles.** Director and coordinator drag and edit. The front desk gets the same panel values with
no Save and no drag handles (`canEdit={false}`), and the **server** refuses them: `POST
/api/plan/place` and `POST /api/children/:token/needs` both answer 403, asserted in both route
tests. Note: the front desk has **no board surface today** — `/plan-routes` and `/today` are both
console-only in the access table, which this PR does not widen (rule 3) — so there is no
`frontdesk-board-child` screenshot to take.

### Today is the same board
`/today` renders the **same `PlanBoard` component** over the same `plan_assignment` rows (at
`headingLevel={2}`, so the page keeps one `h1`), not a second static child list. A plan made and
saved on Today is the plan Plan routes opens on (asserted in the browser check). The existing
rides/ETA table stays below it: it is a per-ride view, not a child list, and rebuilding it is
another PR's.

## What this is

The Ramp iPad's van arrival (redesign spec §2) and the Plan routes board (§1), **re-skinned from
#66** (`origin/team/ppe-plan-board` @ 38ef27f) rather than rewritten: its structure, its
components, its SQL store and its endpoints are what is here, with the planned-counts path cut
out, the carry-over ladder removed, placement moved onto one function, and the Teal palette
applied.

### Carried from #66 (re-skinned, not rewritten)
| Kept | Where |
|---|---|
| The four counters as one config list | `src/config/equipment.ts` (unchanged) |
| The fit rule (`fits` / `rejectReason` / `shortfalls`) | `src/domain/plan/fit.ts` |
| The SQL store for the three 0009 tables | `src/modules/plan/sql.ts` |
| The memory store for the browser check | `src/modules/plan/memory.ts` (now fails closed) |
| The board components and CSS | `src/app/plan-routes/board/*` (minus the popover) |
| The ramp's arrival screen and CSS | `src/app/ramp-ipad/arrival/*` |
| `POST /api/plan/save`, `GET /api/plan`, `POST /api/vans/:id/setup` | `src/app/api/**`, `src/modules/plan/api.ts` |
| The date/leg URL helpers | `src/modules/plan/when.ts` |

### Dropped from #66
- **`VanSetupPopover.tsx`** and every planned-count write from the board (rule 1).
- **`resolveSetup`'s carry-over rung** ("last CHECKED", "From {day}", "Tomorrow starts from this")
  and the seed's yesterday-CHECKED rows (6:00 PM ET ruling).
- **`setupToLayout` / `setupToVehicle`** and the seat-solver Auto-plan with its separate oxygen
  pass (`board.ts:394-437` on #66). Replaced by one counters-based placement function.
- `GET /api/day/readiness` and the Today step strip: another PR's screens, so the access row went
  with them.

### From #60 (`origin/team/ppe-demo6-roi`)
Nothing was carried. Its ramp re-plan (`src/domain/plan/arrival.ts`) is keyed on the seat-level
layout model and writes `vehicle_capability_day`; its walking-seat/per-position screen is the one
§2 deletes. What this PR keeps of the idea is the **port**: `src/domain/plan/replan.ts`, which
hands the leg to the coordinator's board with the counted van selected, and never moves anybody
silently. #60's occupancy weights, `RAMP_DIRECTION` hardcode and capability writes are not here.

### Deleted with the old screens
`PlanRoutes.tsx` (−1002), `lanes.ts`, `save-plan.ts`, `plan.module.css`, `RampCheck.tsx` (−684),
`capability.ts`, `icons.tsx`, `domain/plan/{reasons,save,stages}.ts`, `modules/demo/plan-store.ts`
(the in-memory save #58 shipped), and the `planRoutes` copy §1.5 lists as deleted
(`demoScenarioNote`, `nothingSent`, `optionsNote`, `needsCaption`, `mapNote`, `dragHint`,
`laneMissing`, `setUpChanges`, `reason.*`, `missing.*`, `refused`, `vanNamed`).

## The Firia rules, and the test that holds each one

| Rule | How it is enforced | Test |
|---|---|---|
| **1. Only DEFAULT and CHECKED are written; nothing can produce PLANNED; the board has no planned counts** | `putVanSetupRequest` refuses any state but `CHECKED` with a 403, for every role; there is no popover, no stepper and no Apply on the board | `src/app/api/vans/[id]/setup/route.test.ts` ("refuses a planned count from every role, and writes nothing", "refuses the state the absence of a row means"), `src/app/plan-routes/board/lines.test.ts`, e2e "opens empty … no ⚙, no popover" |
| **2. ONE placement function; the solver places nobody; no screen imports it** | `placeRiders` in `src/domain/plan/fit.ts` is the only placement; `autoPlan`, the drag pre-check, `checkPlan`, the ramp verdicts and Re-plan all go through it or `rejectReason`; `setupToLayout`/`setupToVehicle` are deleted | `src/domain/plan/placement.test.ts` (Veri's five properties, 200 generated days each), `src/domain/plan/board.test.ts` ("is the same answer the placement function gives directly"), `src/ui/rebuilt-screens.test.ts` (import scan: no `domain/solver` under `src/app` or `src/components`) |
| **3. Staff alert / keyword fallback out of scope** | `providers/keyword.ts`, `remote.ts` and the access-table role rows are untouched | `git diff origin/main -- src/modules/agent` is empty |
| **4. The memory store can never be selected when a database URL is set** | `memoryPlanStore(env)` throws when `env.DATABASE_URL` is set; `planStore()` picks SQL whenever one is | `src/modules/plan/memory.test.ts` (throws for every URL shape, throws even with a "force" flag present) |
| **5. Screens read the day through one interface, never a fixture** | `DayDataSource` (`src/domain/day/source.ts`), implemented once by the demo adapter (`src/modules/demo/day-source.ts`); `loadBoard` composes it with the plan store | `src/ui/rebuilt-screens.test.ts` (import scan over `src/app/plan-routes` and `src/app/ramp-ipad`) |
| **6. One time-zone constant, one van-name helper, copy in copy.ts, equipment from one list** | `SITE_TIME_ZONE` now lives in `src/config/site.ts` (`PROJECT_TIME_ZONE` is gone); `vanNameOf(slot)` in `src/config/vans.ts` is the only van-name helper (`copy.vanName(description)` deleted); `EQUIPMENT_COUNTERS` drives counters, fit, copy keys and icons | `src/ui/copy.test.ts` ("has dropped the Plan routes copy the redesign deleted"), `src/ui/no-hex.test.ts`, `src/ui/tokens.test.ts`, existing no-codes/contrast tests |

### The rule-1 interpretation, stated plainly
`PLANNED` stays in migration 0009's check constraint, byte-for-byte. No code writes it. The TS
type the screens and the domain use is **`'CHECKED' | 'DEFAULT'`** (`src/domain/plan/setup.ts`),
so a planned state cannot be constructed in the app at all; the endpoint still *parses* a
`PLANNED` body — so the refusal is an honest 403 (`NOT_A_STATE`) rather than a generic "couldn't
read that" — and writes nothing. `DEFAULT` is never written either: it is what the **absence** of
a row means.

### The other rulings
- **No carry-over anywhere** (Firia/Veri 6:00 PM ET): today's `CHECKED` row or the shared config's
  defaults, full stop. No "yesterday", no "From {day}", no "Tomorrow starts from this" — the seed
  writes no setup row at all, and `src/modules/demo/seed.test.ts` asserts that.
- **Board column line**: an unconfirmed van shows one line, `Using default setup`, with no button.
  The "Not checked" chip is gone.
- **Count chips open the ramp**: each chip is a link to `/ramp-ipad?date=…&leg=…&van=<id>`, and the
  ramp honours `?van=` by selecting that tab.
- **Day started** comes from `ops.scenario_clock` through the plan store, never from browser
  storage.

## Palette (Vera, 6:14 PM ET)
`tokens.ts` gains `teal #0F766E`, `teal-ink #134E4A`, `teal-tint #E6F2F1`, `coral #E8735A` and
`route-2 #B45309`, each with its contrast row (teal 5.47:1 on white, teal-ink 9.48:1, teal-ink on
the tint 8.27:1, route-2 5.02:1 both ways). `brand` and the five tones are **not** restyled — the
frame PR owns that sweep — so the rebuilt screens read the new tokens and nothing else changes
colour. `map-route-2` (the old teal second route) is retired in favour of `route-2`, because teal
is the primary now and a van is not an action. Coral has no contrast row on purpose: at 2.99:1 it
is an **accent only** (the rule down the won't-fit banner, the edge of a refusing column, the ring
on an over count) and never text, never a fill behind text, never the only cue.

## Screenshots (committed)
`artifacts/rework-ramp-board/`, one walk per role, both review widths:

```
director-ramp-1440.png            director-ramp-390.png
director-today-1440.png           director-today-390.png
director-board-child-1440.png     director-board-child-390.png
director-board-child-saved-1440.png
director-ramp-wontfit-1440.png    director-ramp-wontfit-390.png
director-board-1440.png           director-board-390.png
director-board-empty-1440.png     director-board-empty-390.png
director-board-dragreject-1440.png director-board-dragreject-390.png
coordinator-ramp-1440.png         coordinator-ramp-390.png
coordinator-today-1440.png        coordinator-today-390.png
coordinator-board-child-1440.png  coordinator-board-child-390.png
coordinator-board-child-saved-1440.png
coordinator-ramp-wontfit-1440.png coordinator-ramp-wontfit-390.png
coordinator-board-1440.png        coordinator-board-390.png
coordinator-board-empty-1440.png  coordinator-board-empty-390.png
coordinator-board-dragreject-1440.png coordinator-board-dragreject-390.png
frontdesk-ramp-1440.png           frontdesk-ramp-390.png
frontdesk-ramp-wontfit-1440.png   frontdesk-ramp-wontfit-390.png
```
There is no `frontdesk-board-child-*`: the front desk has no board surface (both `/plan-routes`
and `/today` are console-only in the access table, which this PR does not widen). The read-only
panel they would see is unit-tested, and both endpoints answer them 403.
Regenerate: `E2E_PORT=3211 E2E_DEMO_ROLE=DIRECTOR pnpm e2e e2e/rework-ramp-board.spec.ts` (then
3212/COORDINATOR, 3213/FRONT_DESK). `artifacts/` stays gitignored apart from this one directory.
Every shot here is **inside the frame** (rail at 1440, tab bar at 390).

## Tests
- **Targeted vitest, `--maxWorkers=2`, foreground:** `src/app src/ui src/auth src/domain
  src/modules src/config src/components` → **112 files, 5 490 tests, all passing**. The board/ramp subset on its own (`src/domain/plan
  src/modules/plan src/app/plan-routes src/app/ramp-ipad src/app/api src/ui src/auth
  src/modules/demo src/components`) is 38 files / 3 433 tests.
- New files: `src/domain/plan/placement.test.ts` (1 051 assertions over 200 generated days per
  property), `src/modules/plan/memory.test.ts`, `src/ui/rebuilt-screens.test.ts`,
  `src/test/board-day.ts` (helper). Rewritten: `board.test.ts`, `map.test.ts`, `lines.test.ts`,
  `readiness.test.ts`, `sql.test.ts`, `seed.test.ts`, `setup/route.test.ts`, `copy.test.ts`.
- **Browser check:** `e2e/rework-ramp-board.spec.ts` — 14 passing as director, 14 as coordinator,
  7 as front desk (the board half is skipped for the role that cannot open it). Covers: counters
  change the verdicts live, the won't-fit line and Re-plan, Confirm → `CHECKED` → reload still
  says so, drag accepted, drag refused and snapped back with the reason announced, keyboard drag,
  Auto-plan → Save → reload shows the same plan, the count chip's link to the ramp, the front
  desk sent home with "Not on your menu" **and** a 403 from `POST /api/plan/save`, the DOM lint
  (no `V\d`, no `1WC/3A`, no 24-hour time, no "Oct 14", no provider name), and the 390 layout
  with nothing under the tab bar.
- `pnpm typecheck` and `pnpm lint`: clean.
- **`drizzle/` diff against `origin/main` is empty** (checked before every push). No migration was
  written, generated or run; no database was touched.

## Access table
Four rows and four `API` entries, all strictly for the new endpoints — **no role row was
changed**. `/api/plan/place` (POST, director + coordinator) and `/api/children/[token]/needs`
(POST, director + coordinator) are the 7:17 PM ET additions; the two from the first round were:
`/api/plan` (GET, director + coordinator, exactly as the page) and `/api/vans/[id]/setup` (POST,
all three roles, because counting a van is the front desk's job; what each may *write* is the
route's own check). #66's `/api/day/readiness` row was removed again, since that route is not in
this PR.

## Downstream (proposed, not built here)
The saved plan is `ops.plan_run` + `ops.plan_assignment`, and today nothing downstream reads it.
Scope note: DIFF item 4 says approve writes `ops.trip_leg`; this PR does **not** touch approvals or
`trip_leg`. Proposed next steps, in order:
1. **Plan → trip_leg.** A `publishPlan(planRunId)` step writes/updates one `ops.trip_leg` per
   assignment (vehicle, child, window, stop_seq) inside one transaction, keyed on
   (service_date, direction, child_token), and bumps `plan_version`. Approvals keep moving
   `trip_leg`; the board stays the thing that decides *who is on which van*.
2. **Live map.** `LiveFleetMap` reads routes from the saved plan's assignments + stop order rather
   than `src/fixtures/replays.ts`, and names its vans through `vanNameOf` from the one shared van
   config, so "Van 3" means one vehicle everywhere.
3. **Approvals.** A proposal's before→after is diffed against `plan_assignment` (the spec's shape)
   and, on approval, re-published through step 1 — so an approved change reaches the board and the
   map instead of only `trip_leg`.
4. **Today / Health.** Both read the same `plan_run` for "is the day planned", instead of the
   fixtures, which is what makes the step strip and the table stop contradicting each other.

## Database tests
`pnpm test:db` runs `sql.test.ts`, `place.db.test.ts` and `seed.test.ts`. They run on **PGlite** by
default — a throwaway Postgres inside the test process, with every migration in `drizzle/` applied,
nothing to install and nothing that can be pointed at the wrong database — and on a **local
Postgres** when `TEST_DATABASE_URL` names one (README "Database tests"). `src/test/pglite.ts`
**refuses any host that is not loopback**, because those suites drop and recreate the `ops` and
`identity` schemas. Nothing in this PR has ever been pointed at the shared Neon database, and no
migration or seed was run against anything but PGlite in this process.

*Deviation, stated plainly:* the instruction said drags and saves are tested **only** against a
local Postgres and skipped otherwise. There is no Postgres server and no Docker in this
environment, so a skip-only suite would have proved nothing; PGlite runs the same statements
against the same migrations on every commit, and the `TEST_DATABASE_URL` path is there for Veri.

## Known mismatches vs the mockups (honest list)
1. **Count chips carry labels.** The re-rendered mockup keeps icon-only meters (`4/6`) and a
   `✓ Checked` / `◷ Not checked` chip. STEERING 2 (5:55 PM ET) asks for labelled read-only chips
   ("Seats 3/6 · Wheelchair 1/1 …") that open the ramp, and for the "Not checked" chip to be
   replaced by the `Using default setup` line. The written instruction won; the mockup still shows
   the older treatment.
2. **Van 3's colour** is the existing `map-route-3` vermillion, not the mockup's `#BE185D` pink: a
   fourth palette value was not in the 6:14 PM list, and adding one is a design call plus a
   contrast row.
3. **The roster is the build's, not the mockup's.** The day has 9 riders (Noah O., Mia R., Owen C.
   …) and 19 children whose family drives them; the mockup draws 12 riders (Noah B., Iris K. …)
   and 1. One roster now, but it is `standard.ts`'s.
4. **No `+ Add van` column** (§8 allows it visible-and-disabled; it is absent).
5. **The ramp's rider rows are one line** (name · stop · verdict) where the mockup stacks name over
   stop, and the stepper value has no boxed well around it.
6. **The map pane** has the van chips on top and the long sentence removed, but keeps the
   "Zoom to show every route" button the mockup does not draw, and its attribution strip.
7. **The frame is the frame's.** The rail, the header, the tab bar and the "Not on your menu"
   redirect come from Rework 1, merged in here unchanged; this PR only stops drawing its own
   viewport-height box and lets the shell own the tab bar's room. The e2e asserts the bar is
   there at 390 and that no rider card or Confirm sits under it, scrolled to the bottom.
8. **Live map still reads `src/fixtures/map.ts` and `replays.ts`** (four vehicles, V1–V4). It is
   untouched by this PR; the one van list is exported and ready for it (Downstream step 2).
9. **The child panel is centred, not anchored to the card.** The mockup pins it beside the card
   it belongs to and rings that card; this one is a centred dialog at 1440 (and the mockup's
   bottom sheet at 390). The card does carry `data-selected` while its panel is open.
10. **"Car seats", not "Car seat", in the panel.** The row labels are the shared equipment labels
    (`COUNTER_LABEL`), which is what the instruction asks for — the mockup writes the singular.
11. **The van columns still show "Using default setup" and no "Not checked" chip** (Firia/Veri's
    6:00 PM ET ruling), where the 7:19 PM mockup draws `✓ Checked` / `◷ Not checked` chips. No
    "yesterday" wording appears anywhere.
12. **`Family drives` counts 19 and `Absent` 0** on the synthetic day, where the mockup draws 1
    and 1: the roster is the build's (`standard.ts`), and absence starts empty because it is a
    placement nobody has made yet.
