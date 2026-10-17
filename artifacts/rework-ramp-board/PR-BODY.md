# Rework 2: arrival counters + plan board

**Not a PR yet, by instruction** (Firia, 2026-10-17 6:19 PM ET): this body is written down here and
the branch `team/ppe-rework-ramp-board` is pushed. Nothing was opened, marked ready or reviewed.
This PR merges **second**, after the frame PR (Rework 1, `team/ppe-rework-frame`) — that branch did
not exist at `git ls-remote` time, so this one is built on `main` and leaves the room the frame
needs (see "At 390" below). When the frame lands, merge it (never rebase).

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
director-ramp-wontfit-1440.png    director-ramp-wontfit-390.png
director-board-1440.png           director-board-390.png
director-board-empty-1440.png     director-board-empty-390.png
director-board-dragreject-1440.png director-board-dragreject-390.png
coordinator-ramp-1440.png         coordinator-ramp-390.png
coordinator-ramp-wontfit-1440.png coordinator-ramp-wontfit-390.png
coordinator-board-1440.png        coordinator-board-390.png
coordinator-board-empty-1440.png  coordinator-board-empty-390.png
coordinator-board-dragreject-1440.png coordinator-board-dragreject-390.png
frontdesk-ramp-1440.png           frontdesk-ramp-390.png
frontdesk-ramp-wontfit-1440.png   frontdesk-ramp-wontfit-390.png
```
Regenerate: `E2E_PORT=3211 E2E_DEMO_ROLE=DIRECTOR pnpm e2e e2e/rework-ramp-board.spec.ts` (then
3212/COORDINATOR, 3213/FRONT_DESK). `artifacts/` stays gitignored apart from this one directory.

## Tests
- **Targeted vitest, `--maxWorkers=2`, foreground:** `src/domain/plan src/modules/plan
  src/app/plan-routes src/app/ramp-ipad src/app/api src/ui src/auth src/modules/demo
  src/components` → **38 files, 3433 tests, all passing**.
- New files: `src/domain/plan/placement.test.ts` (1 051 assertions over 200 generated days per
  property), `src/modules/plan/memory.test.ts`, `src/ui/rebuilt-screens.test.ts`,
  `src/test/board-day.ts` (helper). Rewritten: `board.test.ts`, `map.test.ts`, `lines.test.ts`,
  `readiness.test.ts`, `sql.test.ts`, `seed.test.ts`, `setup/route.test.ts`, `copy.test.ts`.
- **Browser check:** `e2e/rework-ramp-board.spec.ts` — 14 passing as director, 14 as coordinator,
  7 as front desk (the board half is skipped for the role that cannot open it). Covers: counters
  change the verdicts live, the won't-fit line and Re-plan, Confirm → `CHECKED` → reload still
  says so, drag accepted, drag refused and snapped back with the reason announced, keyboard drag,
  Auto-plan → Save → reload shows the same plan, the count chip's link to the ramp, the front
  desk's 403 on the page **and** on `POST /api/plan/save`, the DOM lint (no `V\d`, no `1WC/3A`,
  no 24-hour time, no "Oct 14", no provider name), and the 390 layout.
- `pnpm typecheck` and `pnpm lint`: clean.
- **`drizzle/` diff against `origin/main` is empty** (checked before every push). No migration was
  written, generated or run; no database was touched.

## Access table
Two rows and two `API` entries, both strictly for the new endpoints — **no role row was changed**:
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
7. **No app frame.** No rail at 1440 and no tab bar at 390 — that is Rework 1's PR. At 390 both
   screens reserve `64px + safe-area` of bottom padding for it (asserted in the e2e), and nothing
   here hides or overrides main's nav.
8. **Live map still reads `src/fixtures/map.ts` and `replays.ts`** (four vehicles, V1–V4). It is
   untouched by this PR; the one van list is exported and ready for it (Downstream step 2).
