# Console slice 3: the live map, what it proves, and what it does differently from ADR-002

```
READER: Rudy (build), Veri (verify), Vera (taste), founder for the two rows marked as questions.
DECISION IT SERVES: what the live board is, which acceptance tests it closes, and the one
architectural difference a reviewer should not have to discover from the code.
STATUS: Written with the slice. The "open" rows are questions, not decisions.
SOURCE: PRD §8, §14 (SURF-01, SURF-02), §18.2 steps 7–8, §18.3 (AT-03, AT-10, AT-11,
TEST-SEC-02), LOC-01/02/03, ASM-11/14/15, DESIGN-DIRECTION §2, §3, §4.1, §5, §5.1, §6.2, §9,
§10, COPY-GUIDE §1–§2, §5, MOCKS-AND-DEMO §5–§6, ADR-002, ADR-007, ADR-008, ADR-013, ADR-015,
DECISION-LEDGER rows 30, 33, 34, 50. Slices 1 and 2: docs/ui/B12-SLICE1-DEFERRED.md §6 (this
slice's own list), docs/ui/B12-SLICE2-DEFERRED.md.
```

## 1. What this slice is

Five things, and the first two are one change seen from each end.

| # | Change | Where |
|---|---|---|
| 1 | **Live updates**: `GET /api/stream`, a snapshot then deltas, a reconnect that resumes rather than restarts | `src/app/api/stream/route.ts`, `src/modules/realtime/{sse,live-board-stream}.ts`, `src/ui/LiveStream.tsx` |
| 2 | **The board at a tick**, and the difference between two ticks | `src/domain/board/live.ts`, `src/domain/board/day.ts` (`demoDayAtTick`) |
| 3 | **The scenario clock**, as B-10 work rather than B-12's | `src/domain/eta/scenario-clock.ts` |
| 4 | **The map pane beside the rows** (§4.1 split pane), with row-hover ↔ marker highlight and fly-to | `src/app/(app)/today/BoardMap.tsx`, `src/components/map/{FleetMap.tsx,live-fixture.ts}`, `today.module.css` |
| 5 | **The §2 chrome that was waiting on a stream**: the amber "paused" bar past 15 s, the GPS pill's real age, the scenario clock's readout | `src/ui/{LiveUpdatesBar,GpsAdapterPill,ScenarioClock}.tsx`, `src/ui/AppShell.tsx` |

And the thresholds all five of them read now live in one file: `src/config/live.ts` holds the
PRD §8 parameter table (the 60/180/600 s bands, the ASM-14 hysteresis, the ASM-11 recompute
policy) plus the stream's own settings, because every one of those numbers is a calibration the
PRD itself offers an alternative for. `live.test.ts` fails if a module declares one again.

## 2. The one difference from ADR-002, and why

ADR-002 says: tail `ops.event_log` over Neon HTTP every second, emit `id: seq`, honour
`Last-Event-ID`, self-close at 290 s. **This stream does not tail `event_log`**, because there is
nothing in it to tail: the demo day's positions come from the committed ADR-007 routes driven by
the B-10 simulator, and **nothing in this build writes a telemetry row**. A tail would have
emitted an empty stream and a board that never moved.

So the stream walks the same deterministic replay the board is already computed from, and keeps
the two properties the ADR's own test is about:

- **monotone ids** — the id is a *tick* of the scenario clock (5 scenario seconds, the cadence
  every replay emits positions at), which is also an instant, the same instant for every client;
- **no missed and no duplicate event after a reconnect** — the client names the tick it holds and
  the walk continues from there. A reconnecting client is sent no snapshot at all, and the next
  delta is measured from its own tick.

Everything else the ADR fixes is unchanged: Node runtime, `retry:`, the 290 s self-close under
the platform's 300 s default, one route, behind the one access table.

**What changes when slice 4 lands:** the writes put the board's facts in `ops.event_log`, and the
tail then replaces one function — `advance()` in `live-board-stream.ts`. The client, the delta
shape and the merge rule are unaffected.

**One consequence, stated rather than hidden.** The walk is **per connection**: two browsers that
open the board a minute apart are a minute apart in the replay, and a client that was away
resumes where it stopped rather than jumping forward. For a replayed demo day that is the honest
reading — the board says "Demo day", every row carries the Simulated chip, and the §2 bar says the
board may be stale while a client is disconnected. It stops being honest the moment the board is
about a real morning, which is the same moment `event_log` becomes the source.

## 3. What is now proved on the surface, and where

| Test | What the surface shows | Held by |
|---|---|---|
| **AT-03** | The gate opens **once** in the whole morning, for the stop **ahead** of the stall; the stop behind it holds no window and is told nothing. The moved window then holds instead of being re-rounded. On screen: the row's "Arriving" cell changes once, and one "Window updates" row names the place, the shift and the new window — labelled a decision, because nothing is sent | `src/domain/board/live.test.ts`, `e2e/live-map.spec.ts` ("one window moves, downstream, and the board says so once") |
| **AT-11** | 180 s: the STALE badge and "ETA texts paused" **with the window still on the row** (§4.1: never hide data). 600 s: "No signal", the ride in Needs action, and "Find {child}'s van." Duplicate and out-of-order points are counted under the map — used, dropped, and why — rather than drawn | `live.test.ts`, `location/ingest.test.ts` (unchanged), `e2e/live-map.spec.ts` ("the stale badge, the paused texts, then the exception and the step") |
| **AT-10** | Still holding, now with a clock running: no tick of the morning puts "Handed off" on a van or a row, and the arrival the geofence does report says "Arrived (vehicle)" | `live.test.ts`, `e2e/live-map.spec.ts` ("a van that arrives is never a child handed over, however long the clock runs") |
| **LOC-01** | The van whose device is not linked to it has no marker, no route and no stop list, and is named in words underneath the map with its unbound count | `live.test.ts`, `live-fixture.test.ts`, the e2e above |
| **TEST-SEC-02** | Zero `*.googleapis.com`; every off-origin request is the one configured basemap host (ADR-008); nothing posts; no child, place, vehicle or token appears in any request, including the stream's own URL, which carries a clock speed and nothing else | `e2e/live-map.spec.ts` ("zero *.googleapis.com, and no token in anything that leaves") |

The existing `/map-preview` is unchanged and still the place the §5.1 motion rules (tween, stall
label, jitter) are reviewed: the console board reads **where a van was last seen**, not an
interpolated position, because the same snapshot is what its GPS ages and published windows are
read from.

## 4. Deliberate decisions in this slice

| Decision | Why |
|---|---|
| **The page arrives with the board *and* the first snapshot**, computed on the server at the same tick | A board that waited for a connection would flash empty, and a stream that never connects would leave a surface with no map at all. The server-rendered snapshot is ~15 KB of JSON and makes the first paint the whole screen; the stream then only ever *updates* |
| **One subscription per tab, in the shell** rather than in the board | The §2 header ages its own GPS pill off the same snapshot the rows use. Two connections would drift apart within a minute, and the chrome would be contradicting the rows underneath it |
| **The console runs the demo day at ×1**; `?speed=` is the review and test path | A board that ran the morning at ×10 by default would be a demo instrument on a coordinator's screen. The faster speeds are the same shape as `?date=`: typed in a URL, named in §6.2, and they change only how long we *wait* between ticks — never what a tick contains (PRD §8) |
| **The clock holds at the end of the committed runs** instead of looping | A console that quietly restarted the morning would be claiming a day that is not happening. `/map-preview` loops, because it is a preview of the motion rules |
| **Only the demo day streams.** A finished day (`?date=`) and an unstarted one open nothing | Neither has a van on the road, so a stream on either could only ever contradict the page — and it keeps AT-13's and AT-10's finished-day checks reading exactly the board slice 2 left them |
| **Rows are regrouped on the client after a merge** | A van going quiet moves its rides into Needs action (LOC-03 → `LOCATION_LOST`). A row left under "On the way" while it says "Nothing has been heard from V2 for ten minutes" would contradict itself. The grouping is the same function the server uses, and `live-view.test.ts` holds the two outputs identical for an un-merged board |
| **A delta that does not fit is refused, and the connection is rebuilt** | Applying it would leave the board a mixture of two instants. A redraw is cheap; a half-applied board is not |
| **`idle` events, with no id** | A tick where nothing moved still has to prove the connection is alive, or the §2 bar would rise on a quiet morning. It carries no resume point, so it cannot move a client's `Last-Event-ID` |
| **The ring and the camera are different signals** | Hover rings the marker; opening a ride flies to it. A pointer sliding down 56 rows would otherwise fly the map 56 times — and a tick moves every van's coordinate several times a minute, so the camera follows the *selection*, never the position |
| **The pane publishes `data-ringed-vehicle` and `data-camera-vehicle`** | Both effects happen inside a WebGL canvas and leave no trace in the DOM. The pane already publishes what it drew for the same reason (`data-vehicles-drawn`); without this a browser check could only assert that nothing crashed |
| **"Window pending" is now "Time not set yet"** | Slice 2 moved the wording here. "Pending" is our state name; the row should carry the fact. The case is unreachable in the committed scenario, so this is a fallback's wording rather than a line the demo shows |
| **The three other adapter pills still say "Simulated"** | There is no SMS, Teams or agent age to print yet. §10's switch is for the adapter that has one |
| **The payload is filtered by role before it is written**, using the map preview's own matrix (`src/domain/access/map-view.ts`) | That matrix already answers "which of this data may this role hold" — the family labels, the stop windows, the notification decisions and the demo internals. `/today` is open to both console roles, so in practice a coordinator is not sent the dropped-point counts or the unlinked van. Filtering in the payload rather than in the component is the rule the preview already states: a role that may not see something never receives it, which is the only version a browser cannot undo |

## 5. What this slice did **not** land

- **A named approver and a named verifier in the seed** (slice 1 §6, moved here from slice 2).
  Still not done: `approved_by` is NULL in `src/modules/demo/seed.ts` and the ramp observation
  still carries no person, so the drawer cannot say "Verified 17 min ago by J.T." and mean it.
  It is a seed and drawer change with nothing to do with the live map, and it is the one row of
  slice 3's own list that is still open — **it belongs to whoever opens the next console PR**,
  and it is small.
- **The U3 commit→screen measurement** (RISKS-AND-QUESTIONS). The stream exists now, so the
  measurement is possible; nothing in this slice measured it. NFR-01's p95 <3 s is therefore
  still unverified, and the §6.2 "<2 s with a 1 s row highlight" row-flash polish is not built.
- **The demo dock's clock controls** (§6.1): Start is still inert and still says so. Play, pause,
  speed and jump-to belong to the demo panel, which is B-15's.
- **Any write.** Confirm handoff, Override, snooze and approve are slice 4's, and the drawer still
  says so.

## 6. Open questions

- **Vera:** the pane carries three lists under the map — what ingest dropped per van, the van that
  is not on the map, and the windows the gate moved. That is the evidence a demo needs and it is
  more words than a coordinator needs every day. Keep all three on the board, or move the two
  counts behind the demo dock when it exists?
- **Vera:** below 1280 **there is no pane at all**. D-6 (ledger row 34) decided the split at
  ≥1280 and nothing decided anything below it; stacking the map under the rows was tried first
  and is worse — it puts half a screen of basemap between the last ride and the bottom of the
  page, on the width where the board has already folded three of its own columns. So a 1024 iPad
  gets the rows and no map. Right, or should the pane come back at that width in some other
  shape? (One cost of the CSS answer, named so it is not discovered later: the pane is still
  *rendered* below 1280 and hidden, so MapLibre still fetches its style there. If the answer is
  "no map below 1280", it should stop mounting rather than stop showing.)
- **Rudy / founder:** the per-connection walk (§2). It is right for a replay and wrong for a real
  morning. Confirm that it stays until `event_log` carries positions, rather than being swapped
  for a process-wide clock now — a process-wide clock would make two tabs agree and make the
  board's first paint depend on how long the server has been up.
- **Veri:** the browser checks drive the clock at ×10 and ×60 to reach the 180 s, 600 s and
  stall thresholds inside a test. The evidence package will show accelerated runs; the §18.2
  evidence rules say nothing about clock speed. Is an accelerated run acceptable evidence for
  AT-03 and AT-11, given the tick's contents are identical at any speed?
