# Goal 5 — Live GPS map

Mockup: `mockups/live-map.html` · `png/live-map.png` (1440) · `png/live-map-390.png` (390).
Branch cut from #74's head (`31e7acf`), with `origin/main` merged in after #74 landed (merge,
never rebase). #74's frozen head `df64915` and its merge to main `caec0a7` are both ancestors of
HEAD. No migrations: `git diff 31e7acf -- drizzle/` is empty.

**Follow-up round (2026-10-18): the four S1s from Vera's 12:30 AM ET walk are fixed** — see
"S1s from Vera's walk" below. Per the parent's box rule for that round, Playwright was NOT run:
the e2e specs are written and updated but unexecuted, and vitest, tsc and lint carry the proof
that can be carried without a browser.

---

## What's in it

**The screen.** A 320 px list of vans beside the map at 1440; the map on top with the vans as
cards under it at 390. Each van: its number, its driver, where it is going next, how many kids
are on it, a stop-progress bar, and **exactly one state chip** — On route, At stop, Late, No GPS.
Above the list, the three filters (All N / Late / No GPS). Under it, the Auto texts feed. In the
frame's 64 px header bar, the leg switch and the three state counts.

**No ETA, anywhere.** Not a time, not a window, not "+12 min", not "last seen 4 min". The replay
still computes one and the screen reads it for exactly one question — *is this leg behind?* — and
that number never leaves `src/modules/live-map/van-state.ts`. Asserted over the whole DOM at both
widths, and over the data the screen is handed.

**One colour per van, all the way through.** Firia's final ruling (2026-10-17 11:25 PM ET): Van 1
`#1D4ED8`, Van 2 `#B45309`, Van 3 `#BE185D`, from **one** group — `VAN_COLORS` in
`src/ui/tokens.ts`. The square beside a van's name, its route line, its stop rings and its map pin
are the same literal. A **selected** van takes a border and a ring, never a fill in its own
colour. The map's own second palette (`map-route-2`/`map-route-3`) is retired, so the Plan routes
board draws a van the same colour this screen does.

**The blue ban is narrowed, not lifted, and it is tested.** `isBlue()` is one classifier over
hue/saturation/lightness, shared by the token test and the browser check, so a token added next
week is judged by the rule rather than by a list of three literals. Both halves of the ruling are
held: blue appears only inside `VAN_COLORS`, and no chrome token — and no colour a browser
actually computes on this screen — is blue.

**Credits collapse to an (i).** MapLibre's compact `AttributionControl`, with its two defaults
corrected: it ships *open*, and its toggle is named by a string this app does not own. ADR-008's
"never removed" holds — the licence text is in the page from the first paint, behind the button.

**Locked until a plan is saved** (REDESIGN-SPEC §9.1, the hard gate). The page reads
`ops.plan_run` / `ops.plan_assignment` for the date and leg in the address; with nothing saved it
draws the centre pin with the "No routes yet" card **over** the map (§9.5) — never a blank map —
and the list, the counts and the feed are honestly empty. The leg lives in the URL (§9.3), so a
reload, a bookmark and a second tab land on the same leg.

**Roles.** `access.ts` is unchanged, as §0 requires. All three staff roles can open the screen;
anonymous and no-role callers are refused by the table, not by a hidden link. The front desk's
menu is exactly Live map + Ramp iPad, they land on `/live-map`, and there are no scenario or demo
controls on this screen for anybody — which is part of what makes it safe as their home page.

**Engine reused, UI not.** #53's MapLibre engine comes over whole (`src/components/map/style.ts`:
the positron fetch and §5.1 overrides, the worker, the camera, the attribution, the `idle`
publication a browser check reads). Its UI does not: the "Fit all" button, the vehicle list with
its freshness pills and ETA windows, the notification-decision log, the injected-fault list, the
per-screen scenario clock and the two in-page "Open <screen>" links are all deleted.

---

## Reused from #73, byte-identical

Verified byte-for-byte against `origin/team/ppe-rework-ramp-board`:

- `src/domain/day/leg.ts`
- `src/modules/plan/when.ts`
- `src/modules/plan/staff.ts`

**What could not come over, and why.** The brief asks for #73's
`src/modules/plan/{types,store,sql,memory}.ts` byte-identical too. `types.ts` and `sql.ts` need
the `Placement` type from their `src/domain/plan/board.ts`; that file calls
`planMap(direction, vans)` from their `src/domain/plan/map.ts`, whose signature is **not** this
branch's (`planMap(plan)`). Taking the store therefore means taking their `map.ts`, which breaks
the Plan routes screen already on this branch — i.e. pulling #73's half-finished board rework onto
a branch somebody else is still writing.

So the read side is `src/modules/live-map/plan-read.ts`: a **read-only subset**, deliberately
parked *outside* `src/modules/plan/` so #73's five files land there with nothing of ours to
conflict with. It runs the same two statements against the same two tables as their
`loadPlanWith`. **The follow-up once both are on main is a deletion, not a merge:** delete that
file and call `planStore().loadPlan`. It is written at the top of the file as well as here.

---

## Specs added and rewritten

### `e2e/live-map.spec.ts` — rewritten wholesale (29 cases, from 25 `test()` blocks, two of which loop)

21 of them ran green in the previous round (19 + 2 front-desk). The **seven added for the S1s are
written and NOT run** — the parent's box rule for this round gives the only Playwright slot to
Veri — so they are listed here as new specs rather than as passing ones.

Layer 1 assertions each cite `live-map.html`, `png/live-map.png` or `png/live-map-390.png`;
Layer 2 assertions each name their ruling.

| Test | Source |
|---|---|
| Every element at 1440: DEMO bar, title, leg switch, the three counts, the three filters, three van rows with name + driver + stop + kids + progress + one chip, the Auto texts feed with 12-hour times, the legend, the zoom control, `scrollWidth ≤ 1440` | `live-map.html` `.top`/`.sh`/`.side`/`.mapw`/`.legend`/`.zoom`, `png/live-map.png` |
| Filters narrow the list to Late and to No GPS and back | `live-map.html` `.sh` |
| A selected van takes a border, and is never filled in its own colour | Firia, 11:25 PM ET |
| Credits start collapsed, the (i) opens them, a second click closes them | `png/live-map.png` + ADR-008 / §5.1 |
| Each van's square and its map pin are the same `VAN_COLORS` literal (computed colour) | Firia, 11:25 PM ET |
| No chrome colour the browser computed is blue | Firia, 11:25 PM ET |
| No ETA anywhere in the DOM (window, delta, "ETA", "last seen", "On time"), at 1440 and 390 | Firia's goal-5 brief, REDESIGN-SPEC §3 |
| No internal code: V-code, family key, child token, provider code, 24-hour time, route id, stop key | MOCKUP-TEST-CONTRACT §Rules 6 |
| Exactly one "Simulated" chip, in the DEMO bar, not in the page | §7.1 / NFR-09 |
| **Each of On route / At stop / Late / No GPS**, by driving the simulated source to that moment | Firia's goal-5 brief |
| No van ever has two chips, at any of the pinned instants | same |
| 390: map above the vans, counts hidden, three cards, every row ≥44 px, Live map is the current tab | `png/live-map-390.png`, §9 |
| Locked: "No routes yet" over the map with a Plan routes action, no vans, at both widths | §9.1, §9.5 |
| Unlocks once the board saves that leg; each leg gates on its own plan | §9.1 |
| Front desk lands on `/live-map` with no toast, menu is exactly Live map + Ramp iPad | Firia, 3:08 PM ET |
| Front desk gets no scenario or demo controls | same + `map-view.ts` `clockControls` |
| **Exactly three vans in the list and three pins on the map, and no "Van 4"** | Firia's 3-van ruling, 2026-10-18; `png/live-map.png` |
| **The DEMO bar's clock and Restart button do not intersect, at 1440 and at 390** | `png/live-map.png`, `png/live-map-390.png` |
| **The clock reads a bare 12-hour time, words only in its accessible name** | `png/live-map-390.png`, contract "reads as a 12-hour time" |
| **`scrollWidth <= 390` at 390, on the saved screen and the locked one** | `png/live-map-390.png`, contract §Rules 6 |
| **No internal code at 390, and for the front desk at both widths** | `live-map.html` `.van .t`, §Rules 6 |

The chip tests pin the clock with `?at=<scenario second>` — the same test path the board already
has (`?tick=`), through the **same** gate (`dateOverrideAllowed`: SYNTHETIC + `DEMO_MODE=1` + an
explicit `E2E_DATE_OVERRIDE=1`, and refused outright whenever `VERCEL_ENV` is set). On anything the
platform runs it is a parameter nothing reads.

Every test that wants vans first **saves a plan on the board** — Auto-plan, Save, and a wait for
the POST to land. That is the coordinator's own click, not a seeded row.

### Behaviour (vitest), 103 tests in `src/modules/live-map/`

- `src/modules/live-map/van-state.test.ts` (24) — the chip derivation, citing LOC-03 for the GPS
  bands, ASM-18's 100 m geofence for At stop, PRD §8 / `notifyGateConfig.shiftSeconds` for Late,
  and §3's worst-first order. The last block **walks the whole simulated day at 15-second steps**
  and asserts all four chips actually occur: a derivation that can only return two of its four
  values is a two-state screen, and no browser check sampling three instants would find that out.
- `src/modules/live-map/plan-read.test.ts` (26) — the gate (locked with nothing saved; unlocked
  the moment a `plan_run` exists; unlocked on an *empty* saved plan, because the run is the
  decision and not its rows), reading `plan_assignment` (only the VAN bucket counts), the
  vehicle-id join, the fail-closed memory rule with no override, a read-only grep over the file's
  own statements, and the no-database path with its per-leg gating. Citing DATA-MODEL.md "One
  source for the plan", §9.1, and Firia's rule 4.
- `src/modules/live-map/roles.test.ts` (17) — citing Firia's 3:08 PM ET ruling.
- `src/modules/live-map/fleet.test.ts` (14) — the 3-van ruling, 2026-10-18 (see S1 4 above).
- `src/modules/live-map/screen.test.ts` (22) — no internal code in the rendered markup, at every
  300 s of the day and for all three roles (see S1 3 above).
- `src/ui/tokens.test.ts` — a new van-palette block: the three colours, wrap-around, contrast at
  4.5:1 on both page surfaces (a van pin carries a white numeral, so it is text), blue only
  inside `VAN_COLORS`, no blue chrome token, no blue in any stylesheet, and the classifier's own
  judgement calls (the ink's navy lean, the slates and the reserved violet are not blue).

### Specs deleted

- **`e2e/live-map.spec.ts`, the whole previous file.** It drove #53's debug screen: the "Fit all"
  button, the vehicle list with its GPS freshness pills and ETA windows, the "Notification
  decisions" and "Injected faults" headings, the per-screen Pause, and van buttons named
  `/^V1 · /`. All of that is deleted from the build.
- **`e2e/screens.spec.ts`, the `"the live map draws tiles and V1-V3…"` block** (~95 lines,
  previously L76–L171). Same reason: `liveMap.pause`, `fleetMap.fitAll`, the `/^V1 · /` card, the
  in-page ×10 speed control, the `Open Ramp iPad` link and `data-vehicles-drawn="V1,V2,V3"` are
  all gone. What it was really checking — tiles drew, attribution present, ≥44 px targets, both
  widths, no internal codes — moved into `e2e/live-map.spec.ts` and grew. A comment in its place
  says so. Its now-unused `fleetMap` / `liveMap` imports went with it.

### Specs changed, with their source

- `src/ui/tokens.test.ts`: contrast pairs 34 → 32 and the token-key list loses `map-route-2` /
  `map-route-3` — both retired when the app went to one van palette (Firia, 11:25 PM ET).
- `src/components/map/style.test.ts`: `"the first one is the route colour the map already had"`
  asserted brand teal for `ROUTE_COLORS[0]`. Van 1 is `#1D4ED8` now, same ruling.

Nothing was loosened to pass. Where a run failed, the code changed — see the two defects below.

---

## Defects this work found and fixed

1. **`src/modules/demo/plan-store.ts` kept its state in a module-level `const Map`.** Next bundles
   a route handler and a server component separately, so `POST /api/plan/save` wrote into the
   route's copy and a page rendering on the server read its own, empty one. The board never
   noticed — it writes and reads through the endpoint, one bundle — but the Live map reads it on
   the server to answer §9.1 and got `null` every time. The map now hangs off `globalThis` under
   one well-known key, which is exactly how #73's `src/modules/plan/memory.ts` holds the same kind
   of state. No API change; its own tests pass unchanged.
2. **An internal code was reaching the screen.** The Auto texts feed printed the route stop's
   family *key* — "F7 · Van 1" — where `png/live-map.png` reads "Kim P. · Van 2". The key now
   resolves to the guardian the fixtures already name, and a key the fixtures do not know prints
   the van alone rather than itself. The new no-internal-codes test is what caught it.
3. **A van at the end of its run rendered " · 0 kids" after an empty space.** It reads
   "All stops done" now.

---

## Screenshots

**Not regenerated in the follow-up round** (the box rule forbids a headless browser), so the eight
PNGs below are from before the four S1 fixes: they still show the long "Scenario clock …" readout,
the 426 px phone and Van 1's line under Van 3's. The code and the specs are ahead of them.

`artifacts/rework-livemap/`

| File | What |
|---|---|
| `live-map-1440.png` | Director, 1440×900, pinned to the second the day reads "1 on route · 1 late · 1 no GPS" — `png/live-map.png`'s own summary line |
| `live-map-390.png` | Director, 390×844, the same instant |
| `live-map-midrun-1440.png` | Director, 1440×900, mid-run: three different chips at once and real stop names, which is closest to the mockup's own picture |
| `live-map-midrun-390.png` | Director, 390×844, mid-run |
| `live-map-locked-1440.png` / `live-map-locked-390.png` | The §9.5 "No routes yet" card over the map |
| `live-map-frontdesk-1440.png` / `live-map-frontdesk-390.png` | Front desk, both widths |

---

## S1s from Vera's walk (2026-10-18 12:30 AM ET)

### 1 + 2 — the DEMO bar at 390: a 426 px page, and the clock over the button

One cause: the readout said **"Scenario clock 7:31 AM ET"**. png/live-map-390.png and
png/live-map.png both draw **"3:24 PM"** there, and MOCKUP-TEST-CONTRACT.md says the same in
words ("the clock … reads as a 12-hour time (for example '2:47 PM')"). Three words and a zone
more than the mockup has room for is what pushed the row past the viewport — and a
`white-space: nowrap` span in a row that has run out of width does not give way, it draws over
its neighbour.

- The readout is the time. The words it lost are its **accessible name** (`liveMap.clockLabel`),
  so a founder reads four characters and a screen reader still hears what the number is.
- The layout half is the mockup's own phone rules (`live-map.html`: `.demo{gap:6px}`,
  `.demo .reset{padding:0 8px}`). 6 px is not a step on the §9 scale, so it takes the step below
  (4 px) — the row has more room than the mockup's, never less.
- The structural half, so it cannot return as a paint bug: `min-width: 0` plus an ellipsis on the
  readout and on the button's label. The row now elides its own longest label instead of
  overrunning the viewport.

Specs: `copy.test.ts` and `demo-clock.test.ts` assert **both** halves (visible time, accessible
name) — tightened, not loosened: they would still have passed unchanged, because the words are in
the markup as an `aria-label`, and they now fail if the sentence comes back into view. e2e adds
`scrollWidth <= 390` (on the saved **and** the locked screen) and non-intersecting bounding boxes
for the clock and the button at 390 **and** 1440.

### 3 — no internal codes on screen

`"V1 · Convertible van"`, `"Provider P1"` and `"V2 · Live 2 s"` came from #53's vehicle card,
which was still in the tree although nothing rendered it. **Deleted:**
`src/components/map/FleetMap.tsx`, `LiveFleetMap.tsx`, `fleet-map.module.css`, and the nine copy
keys they used (`vehicleRow`, `vehicleMeta`, `gps`, `source`, `stopped`, `fitAll`,
`vehiclesHeading`, `locationLost`, `stopFamily`). A template whose first placeholder is an
internal id is not a string to leave lying around.

A van reads `"Van 1 · Marco D."` and nothing else about the van (`live-map.html` `.van .t`;
REDESIGN-SPEC §6 item 5 hides providers, §7 C2 makes the vans generic).

New: **`src/modules/live-map/screen.test.ts`** renders the real screen with `react-dom/server`
and scans every word — eleven code shapes each asserted on its own, nine vehicle descriptions and
vendor names by name, at every 300 s of the simulated day, for all three roles, and on the locked
screen. That is the only way to catch this class: a code arrives interpolated out of a fixture at
render time, so it is neither a literal in a component nor a string in `copy.ts`, and none of the
greps in `no-codes.test.ts` can see it.

`src/components/map/pane.test.ts` was **retargeted, not deleted** — its §9 (44 px zoom targets)
and ADR-008 (attribution never clipped or covered) rules are Vera's review contracts, not #53's
styling. Carrying them over found that the new pane was **missing all three CSS rules**: it had
MapLibre's 29 px buttons and an unpinned attribution. Fixed, plus two new rules (the attribution
sits above all three overlays this screen floats; the pane floats no button of its own).

### 4 — exactly three vans

The map read `DEMO_RUNS` — #53's **four**-run fixture — and dropped the fourth at render time, by
whether its device happened to be bound. Three vans because one is invisible is one fixture edit
away from four, and nothing would have failed.

`src/modules/live-map/fleet.ts` now declares the screen's own fleet: three entries, V1/V2/V3, in
the order they are numbered. No index 3, no V4, and `day.ts` filters nothing.

**Van 3 is generic now**, which a count alone cannot catch: #53's third run was
`route2-substitute`, the *reserve* van's road, deliberately given route 2's geometry so the two
could not drift. Van 3 drives **route 1** (R3's morning — the Greenacres library and John Prince
Park, the stop png/live-map.png itself names), keeping the AT-03 jitter. Three vans, three roads,
three colours — which also **fixes mismatch 3 of the previous round**, where Van 1's blue line was
hidden underneath Van 3's pink one.

`fleet.test.ts` (14) asserts the three entries, that no two vans share a road or a stop list, that
the day yields three vans at **every 15 s** of the run (the old filter depended on the clock), that
the feed never names a van 4, and — by grep over every live-map source — that no V4,
`route2-substitute`, `SUBSTITUTE_ROUTE` or `DEMO_RUNS` appears in live-map *code*.

The pinned e2e second moved **3600 → 830**: with the fourth run gone the same day reaches the
mockup's own state earlier, and 830 is the one second where all of png/live-map.png is true at
once — counts "1 on route · 1 late · 1 no GPS", three different chips, every van with a named next
stop, and a row in the Auto texts feed. Found by walking the day in vitest, not by guessing.

---

## Remaining mismatches vs the mockup, honestly

1. **The 390 overflow and the clock/button overlap are FIXED** (S1s 1 and 2 above) — but the fix
   is **reasoned, not measured**: the parent's box rule for this round forbids running Playwright,
   so the two e2e assertions that would prove it (`scrollWidth <= 390`, non-intersecting boxes)
   are written and unexecuted. The arithmetic they rest on is the mockup's own: the bar carries
   "DEMO", a 20 px chip, seven characters of time and one button, at 4 px gaps inside 12 px
   padding. The `min-width: 0` + ellipsis backstop means that even if that arithmetic is off, the
   row elides rather than overruns — so the failure mode is a shortened label, not a scrollbar.
2. **Two tests fail in `e2e/screens.spec.ts`, and neither is this screen's.**
   "the board carries the DEMO bar and a rail that is not clipped" fails at 1024 and 1280 on
   `/today`: the rail measures 47 px where 64 is expected, and 215 where 232 is expected — a
   consistent 17 px squeeze, because the board's own content overflows (`scrollWidth` 1375 at a
   1280 viewport) and the flex row shrinks the rail to fit. Measured in the previous round, not
   assumed: this branch's only addition to shared chrome is one empty `[data-header-slot]` element
   in the page header, it measures **0 px wide**, and deleting it from the live DOM leaves the
   rail at exactly 47 and 215. The overflow is the board's. Reported, not fixed from here.
3. **The Auto texts feed has one row, where the mockup draws three.** The simulated day produces
   exactly one `NOTIFY` decision over its whole length (walked in vitest), so there is one text to
   list. Not a layout question — the feed renders up to three — but a fixture one: more families
   would have to cross the late threshold for the mockup's three rows to exist.

4. **The kid count is the plan's, not a live count of who is still aboard.** The brief's rule is
   that the saved plan decides which children are on which van, so the row shows the plan's count
   for that van all day. The mockup's "2 kids" reads as "still aboard". The two agree at the start
   of a run and diverge as children are dropped. Worth a ruling; not guessed at here.
5. **Filters are 22 px pills, not the mockup's 28 px chips.** `live-map.html` draws the filter row
   at 28 px (`.sh .chip`), and the audit's §4.1 rule — one pill, 22 px, everywhere, which the test
   contract repeats as a global check on every screen — is the one that binds. The filter buttons
   carry no shape of their own; the one pill inside them carries all of it.
6. **"Van 2" and "Dee R." are drawn apart, with no visible "·" between them** — which is what
   `png/live-map.png` shows. The dot is in the row's accessible name ("Van 1 · Marco D."), which
   is what the test contract's row 4 asks for and what the specs match on.
7. **The mockup's van popover on the map is not built** (`.pop`: next stop, kid chips, "Families
   texted", Call/Texts). Those actions belong to #61's Family texts and the call path, and a card
   with two buttons that do nothing is worse than no card. The list beside the map carries the
   same facts; selecting a van rings it and moves the camera.
8. **The driver names are this branch's data** (Marco D., Nadia P., Omar T.), not the mockup's
   fiction (Marcus L., Dee R., Tom W.). They come from `src/domain/plan/day.ts` through the frame's
   one name helper, so the board and the map name the same person.

---

## How to run it

```
pnpm vitest run src/modules/live-map/ src/ui/tokens.test.ts src/components/map/style.test.ts --maxWorkers=2
E2E_PORT=3231 npx playwright test e2e/live-map.spec.ts --workers=1
E2E_PORT=3231 E2E_DEMO_ROLE=FRONT_DESK npx playwright test e2e/live-map.spec.ts --workers=1 -g "front desk"
```

The front-desk block skips itself unless `E2E_DEMO_ROLE=FRONT_DESK`, because the role belongs to
the server. Its screenshots show the **locked** screen: on a server with no database only the
board can save a plan, and the front desk cannot open the board — so there is nobody to unlock it
for them in that run. The access-table half of their story is proved without a browser in
`src/modules/live-map/roles.test.ts`, and the two browser tests prove the landing, the menu and
the absence of controls.
