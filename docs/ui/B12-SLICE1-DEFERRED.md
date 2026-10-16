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

A row is one child's **one ride**: "Mia R., morning" and "Mia R., afternoon" are two rows, each
with its own state, van, window, needs-action reasons and next step (AT-07). 28 children, 56
rows, dense and no cards. The drawer is still per child — it is where the two rows are read as
one day.

| Surface | File |
|---|---|
| Projection (machine + solver + ETA over the demo scenario) | `src/domain/board/board.ts`, `src/domain/board/scenario.ts` |
| The board | `src/app/(app)/today/TodayBoard.tsx` |
| The drawer | `src/app/(app)/today/LegDrawer.tsx` |
| The words of a next step and a needs-action reason, shared by both | `src/app/(app)/today/next-step.ts` |

## 2. Sequenced — named, not built

| Thing | §  | Lands with |
|---|---|---|
| Live updates, reconnect delta, the amber "paused" bar over 15 s | §2, §4.1 | the SSE slice (ADR-002) |
| The map pane beside the rows, row-hover ↔ marker highlight, fly-to | §4.1, §5 | the map slice (the pane itself already exists at `/map-preview`) |
| Inbox (SURF-03) and Exceptions & Approvals (SURF-05) | §4.3, §4.5 | their own changes |
| Header adapter pills showing real ages instead of "· Simulated" | §2, §10 | the SSE slice; the ages come from the same stream. The pills' **violet is already gone** (§4 below): only the text is still interim |
| Writes: confirm handoff, override with reason, snooze, approve | §4.2, §4.5 | the first console write slice. The drawer renders the action, says in text why it is unavailable, and says out loud that it is not connected |
| 412 conflict toast and the merge view | §4.1 | the first console write slice: there is nothing to conflict with until the board writes |
| Provider / vehicle / AM-PM filter chips with counts | §4.1 | the next board change. This slice ships the "Only needs action" toggle and the §2 search |
| History, pending approvals and agent changes in the drawer, with real rows | §4.2 | after Exceptions and the agent surfaces, which own those rows |

> **Slice 2 (docs/ui/B12-SLICE2-DEFERRED.md) answers §3.1, §3.2 and the service-date question in
> §5.** The afternoon has committed geometry aligned to the scenario, the board carries one
> service date in its own header — the replayed demo day, labelled as the demo day, with no
> switcher beside it — and the day before the demo day carries the rides that *ended*, which is
> where AT-13's held ride and AT-10's arrived-but-not-handed-over van live. That day is reached
> by a `?date=` URL and by nothing on screen: it is where those two acceptance tests are read.
> The rows below are left as they were written, so the two slices can be read in order.

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
4. **A verified vehicle capability has no named verifier.** Every other person on this screen is
   named — the child, the adult on file to receive them, the dispatcher who can answer for a van
   — because the fixture has a name for them. The ramp observation does not: `capabilityFor` in
   `scenario.ts` derives "verified" from the one fact the day actually produced (the van has a
   displayable position, so it cannot have skipped the check), and no person is attached to it.
   So the drawer says "Checked at the ramp before this run." where COPY-GUIDE §5 asks for
   "Verified 17 min ago by J.T.". Inventing a verifier is the one thing that would make the
   sentence read right and the screen wrong.

## 4. Deliberate deviations from the design direction

| § | What it asks | What this slice does | Why |
|---|---|---|---|
| §4.1 | row carries "provider/vehicle + capability chip" | the van's label and the capability chip on the row; the provider's name in the drawer's ride card | a provider name is three or four words and would take a third line on every row of a 56-row board, against the §4.1 two-line cap and the §1 density dial. The §2 search still finds a child by their provider |
| COPY-GUIDE §5 | four group headers | five: "Getting ready" is added | the guide's four were written for a mid-morning board where every ride has started. A ride that is planned but has not left is neither "on the way" nor "not riding today" |
| §4.1 | row is one child's day, one AM/PM chip and one state chip | **one row per child and ride**: a child's morning and afternoon are two rows, grouped independently | the earlier cut had to pick which of a child's two rides "the row" was about, and then the other one was not on the board at all — a morning van on the road hid an afternoon nobody had reported on. AT-07 is the rule that the two rides are separate things; the board is now shaped like the rule. Rows stay dense (48 px, two lines) and the row count is 56, which is what the surface is for |
| §4.1 | row ends in a "next-action owner avatar+name" | a **next step**: a sentence that opens with a verb and names the child — "Record who receives Noah O." | there is no owner to name in this slice (no task rows, no assignment), and the only honest alternative was the role — "Coordinator", which is the one fact a coordinator reading their own board already has. A step says what to do; the avatar comes back with the Exceptions surface, which owns assignment |
| §2 | header adapter pills in the `src-sim` tone (Vera's interim, 2026-10-14) | the same interim pills, outlined, in `ink-muted` | D-5 reserves the violet for the DEMO bar and the Simulated chip. Four more violet chips in the header, beside a bar that already says "DEMO" and a chip that already says "Simulated", spend the reservation and the colour stops meaning "this is the demo". The §2/§10 *text* is untouched and still waits on the live stream; `src/ui/tokens.test.ts` and `e2e/helpers.ts` now hold the colour rule from both sides (stylesheets, and the computed colour of every element the browser lays out) |

## 5. Open questions

The two-service-dates row that was here — the header's real date against the board's seeded day,
both labelled "Service date" — is answered. Vera's final call, 2026-10-16:

> One date on screen: the replayed demo day, labelled as the demo day. In demo mode the header doesn't show today's real date. No date switcher.

- **Vera:** is "Getting ready" the right fifth group header (§4), or should a planned-but-not-departed ride sit under one of the four?
- **Vera:** the row drops the provider's name to keep two lines (§4). Confirm, or take a third line?
- **Vera:** §4.2 writes the drawer's two rides as cards, and they are still cards (a hairline box, 12 px). The board's own cards are gone. Keep the drawer's, or make them dense rows too?
- **Rudy / founder:** regenerating the ADR-007 route fixtures against the scenario's own stops (§3.1) would give every rider a real pickup window and the afternoon a real arrival. Worth the committed-data change before the demo?
