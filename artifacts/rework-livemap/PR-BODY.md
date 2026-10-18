# Goal 5 — Live GPS map

Mockup: `mockups/live-map.html` · `png/live-map.png` (1440) · `png/live-map-390.png` (390).
Branch cut from #74's head (`31e7acf`). No migrations: `git diff 31e7acf -- drizzle/` is empty.

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

### `e2e/live-map.spec.ts` — rewritten wholesale (20 tests, all passing)

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

The chip tests pin the clock with `?at=<scenario second>` — the same test path the board already
has (`?tick=`), through the **same** gate (`dateOverrideAllowed`: SYNTHETIC + `DEMO_MODE=1` + an
explicit `E2E_DATE_OVERRIDE=1`, and refused outright whenever `VERCEL_ENV` is set). On anything the
platform runs it is a parameter nothing reads.

Every test that wants vans first **saves a plan on the board** — Auto-plan, Save, and a wait for
the POST to land. That is the coordinator's own click, not a seeded row.

### Behaviour (vitest), 67 tests

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

## Remaining mismatches vs the mockup, honestly

1. **At 390 the page's `scrollWidth` is 426 for a director.** The 36 px over is the DEMO bar's
   "Restart demo day" button, which is **frame chrome on every route** — `/today` is 766 at the
   same width, `/ramp-ipad` is 390. Not this screen's content: the widest thing the Live map
   itself draws at 390 is 390, and the front desk — the role that actually lands here, and has no
   Restart button — measures exactly 390. It belongs to the DEMO bar (#74), so it is reported
   rather than fixed from this branch.
2. **The Family texts badge shows "2".** The ruling hides it until #61 lands
   (MOCKUP-TEST-CONTRACT row 5). Pre-existing frame behaviour on this branch, visible in every
   screenshot here. It also **fails two existing tests** that are nothing to do with this screen:
   `e2e/screens.spec.ts` "the board carries the DEMO bar and a rail that is not clipped" at 1024
   and 1280, where the rail renders `title="Family texts, 2 waiting"` against an expected
   `"Family texts"`. Nothing in this branch's diff touches `NavRail`, `menu-badge.ts` or the nav
   copy — the 28 changed files are listed in the commits — so this is reported, not owned. The
   rest of `screens.spec.ts` passes (24 of 26 in the combined run).
3. **Van 1's route line is drawn underneath Van 3's.** The fixtures give the substitute van
   (`route2-substitute`) *route 2's own geometry* on purpose, so the two cannot drift — which
   means two of the three lines coincide and the blue one is hidden under the pink. The mockup
   draws three separate routes. A fixture question, not a paint one: the pins separate as the two
   runs diverge, and the colours are correct wherever they are visible.
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
