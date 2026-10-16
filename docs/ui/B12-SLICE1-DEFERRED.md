# Console slice 1: what landed, what is sequenced, what is open

```
READER: Rudy (build), Veri (verify), Vera (taste). DECISION IT SERVES: what the next console
change has to pick up, so nothing on this page is discovered twice.
STATUS: Written with the slice. The "open" rows are questions, not decisions.
SOURCE: PRD §14 (SURF-01, SURF-02), DESIGN-DIRECTION §4.1, §4.2, §9, §10, COPY-GUIDE §5,
MOCKS-AND-DEMO §1, §5, ADR-007, ADR-013, ADR-015.
```

## 1. What this slice is

The Today board (SURF-01) and the child drawer beside it (SURF-02), on the synthetic day
`demo reset --scenario=standard` seeds. Every fact on a row is computed by a module that
already owns the question — the leg machine for the ride's state, the capacity solver for
whether the van fits its riders, the ETA/replay engine over the committed ADR-007 routes for
the arrival window and the van's location. There is no table of board rows and no mock row in
the rendering path; `src/domain/board/` is the whole projection and it is pure.

| Surface | File |
|---|---|
| Projection (machine + solver + ETA over the demo scenario) | `src/domain/board/board.ts`, `src/domain/board/scenario.ts` |
| The board | `src/app/(app)/today/TodayBoard.tsx` |
| The drawer | `src/app/(app)/today/LegDrawer.tsx` |

## 2. Sequenced — named, not built

| Thing | §  | Lands with |
|---|---|---|
| Live updates, reconnect delta, the amber "paused" bar over 15 s | §2, §4.1 | the SSE slice (ADR-002) |
| The map pane beside the rows, row-hover ↔ marker highlight, fly-to | §4.1, §5 | the map slice (the pane itself already exists at `/map-preview`) |
| Inbox (SURF-03) and Exceptions & Approvals (SURF-05) | §4.3, §4.5 | their own changes |
| Header adapter pills showing real ages instead of "· Simulated" | §2, §10 | the SSE slice; the ages come from the same stream |
| Writes: confirm handoff, override with reason, snooze, approve | §4.2, §4.5 | the first console write slice. The drawer renders the action, says in text why it is unavailable, and says out loud that it is not connected |
| 412 conflict toast and the merge view | §4.1 | the first console write slice: there is nothing to conflict with until the board writes |
| Provider / vehicle / AM-PM filter chips with counts | §4.1 | the next board change. This slice ships the "Only needs action" toggle and the §2 search |
| History, pending approvals and agent changes in the drawer, with real rows | §4.2 | after Exceptions and the agent surfaces, which own those rows |

## 3. Known gaps in the fixtures (not worked around)

1. **The committed routes and the standard scenario disagree.** `src/fixtures/routes.ts` was
   authored before `src/modules/demo/fixtures/standard.ts`: `route2` carries V1 but stops at S4
   and S1, which in the scenario belong to another run's children, and the `familyLabel` on each
   stop names a different family than the scenario does. So a run is paired with the committed
   geometry of **its own vehicle** and nothing else, and where the geometry does not name a
   child's stop the board says the window is pending rather than borrowing another run's
   numbers. Fixing this means regenerating the ADR-007 fixtures against the scenario's own
   stops — a change to committed routing data, which is its own decision.
2. **The afternoon has no committed geometry at all**, so every PM ride's window reads
   "Window pending". Same fix as above.
3. **A seeded transport profile has no named approver** (`approved_by` is NULL by design in
   `seed.ts`), so the drawer shows the approved version and no approver. §4.2 asks for both.

## 4. Deliberate deviations from the design direction

| § | What it asks | What this slice does | Why |
|---|---|---|---|
| §4.1 | row carries "provider/vehicle + capability chip" | the van's label and the capability chip on the row; the provider's name in the drawer's ride card | a provider name is three or four words and would take a third line on every row of a 28-row board, against the §4.1 two-line cap and the §1 density dial. The §2 search still finds a child by their provider |
| COPY-GUIDE §5 | four group headers | five: "Getting ready" is added | the guide's four were written for a mid-morning board where every ride has started. A ride that is planned but has not left is neither "on the way" nor "not riding today" |
| §4.1 | row is one child's day | the row shows the ride that is *happening*, marked AM or PM; the drawer shows both | §4.1's own row sketch is one AM/PM chip and one state chip, two lines at most |

## 5. Open questions

- **Vera:** is "Getting ready" the right fifth group header (§4), or should a planned-but-not-departed ride sit under one of the four?
- **Vera:** the row drops the provider's name to keep two lines (§4). Confirm, or take a third line?
- **Rudy / founder:** regenerating the ADR-007 route fixtures against the scenario's own stops (§3.1) would give every rider a real pickup window and the afternoon a real arrival. Worth the committed-data change before the demo?
