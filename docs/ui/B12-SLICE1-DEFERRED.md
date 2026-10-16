# B-12 — what slice 1 landed, and the slice every open item lands in

```
READER: Rudy (build), Veri (verify), Vera (taste). DECISION IT SERVES: what slices 2 and 3 have
to pick up, so nothing on this page is discovered twice.
STATUS: Written with slice 1, re-cut when B-12 was split into three. Nothing here is parked.
SOURCE: PRD §14 (SURF-01, SURF-02, SURF-03, SURF-05), DESIGN-DIRECTION §4.1, §4.2, §4.3, §4.5,
§5, §9, §10, COPY-GUIDE §5, MOCKS-AND-DEMO §1, §5, ADR-002, ADR-007, ADR-013, ADR-015.
```

**Nothing in B-12 is parked.** B-12 is **one founder-approved build step** (PPE-21, BUILD-PLAN
B-12). The team split it into three slices so it could be reviewed in pieces — that split is the
team's own, inside an approval the founder has already given, and it needs no second sign-off
(Firia, 2026-10-16 3:14 PM ET). The split is a review boundary, not a scope cut: **B-12 closes only
when slices 2 and 3 pass**, and every open item below names the slice it lands in. The file keeps
its old name so existing links still resolve; the word in it does not describe anything on the page.

Same rule as B-08 (DECISION-LEDGER row 63): an item whose slice nobody can name does not get to
stay on the page as a shrug.

| Slice | What it is | State |
|---|---|---|
| 1 | The Today board (SURF-01) and the child drawer (SURF-02), read-only, over the seeded scenario | **landed** — this page's §1 |
| 2 | Inbox, Exceptions & Approvals, the writes, and every fixture and taste item below | sequenced |
| 3 | Live updates (SSE) and the map pane | sequenced |

## 1. What slice 1 is

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

## 2. Slice 2 — the surfaces, the writes, and the sharpening

Everything in this table lands before B-12 closes.

| Thing | § | What slice 2 has to land |
|---|---|---|
| Inbox (SURF-03) and Exceptions & Approvals (SURF-05) | §4.3, §4.5 | both surfaces, for real. Exceptions is also where B-08's F9 lands — the approval *decision* screen over `ops.change_request` / `ops.approval_request`, which DECISION-LEDGER row 63 dated to B-12 |
| Writes: confirm handoff, **Override with reason**, snooze, approve | §4.2, §4.5 | the drawer's actions stop being read-only. Override is the one that has to work end to end: the dialog takes a required reason (`copy.ts overrideHeading` / `overrideReasonLabel`), the write commits, and the row and the drawer both move. "The action is rendered and says it is not connected" was slice 1's honest placeholder, not a shape to keep |
| A disabled Override that **looks** disabled, and says why in one line | §4.2, §9 | today `LegDrawer.tsx` renders it `disabled` but `.secondary:disabled` only mutes the text — the strong border keeps it reading as a live control — and the only reason on screen is the *handoff's*, sitting above it. Slice 2 gives the disabled state a visible treatment and gives Override **its own one-line reason, from `src/ui/copy.ts`** (never inline prose, never a tooltip alone) |
| 412 conflict toast and the merge view | §4.1 | with the writes: there is nothing to conflict with until the board writes |
| Provider / vehicle / AM-PM filter chips with counts | §4.1 | slice 1 shipped the "Only needs action" toggle and the §2 search; slice 2 adds the chips and their counts |
| History, pending approvals and agent changes in the drawer, with real rows | §4.2 | the drawer's three sections are empty-state prose today. Slice 2 fills **history** with real rows, and the pending-approval and agent-change rows come from the Exceptions work in the same slice |
| Drawer **timeline rows** | §4.2 | the day as a timeline of rows rather than two hairline cards — the dense treatment the board already uses (and Vera's call, §5) |
| A **date switcher** on the board | §2, §6.1 | Vera's answer to the two "Service date" labels (§5): one control that says which day the board is showing, so the header and the board stop disagreeing |
| An **AT-13 `HELD_NO_RECEIVER` ride in the scenario** | PRD §6.6, l.1327 | the scenario has the *family* for AT-13 — F2, no authorized receiving adult (`standard.ts:140`) — but no ride actually in the state, so the one leg state the board styles `crit` and AT-13 exists for is never on screen. Slice 2 seeds the ride, and the board, the drawer and AT-13's own check all read it |
| A tighter, **mutation-proven** AT-10 e2e | PRD SURF-01 acceptance | today's AT-10 line is a negative — `expect(page.getByText(/handed off to/i)).toHaveCount(0)` — which also passes on a board that renders nothing. Slice 2 rewrites it to assert positively on the arrived-at-drop-off ride (it is on screen, it reads as arrived, it does **not** read as handed off), and proves the test by mutation: flip the projection so an arrival completes a handoff, and the test must fail |
| **Afternoon route data aligned with the scenario** | ADR-007, §3 below | regenerate the committed routes against the scenario's own stops, AM and PM, so every rider gets a real window instead of "Window pending" |
| An unknown window reads **"Time not set yet"**, with an icon | COPY-GUIDE §5, §3 | where a window genuinely is not known yet, the cell says "Time not set yet" beside an icon — not the code-flavoured "Window pending" (`copy.ts:157`), and never colour or absence alone |
| A **named approver and a named verifier** on the seeded records | §4.2, COPY-GUIDE §5 | the seed gives the approved transport profile an `approved_by` and the verified ramp check a person, so the drawer can say "Verified 17 min ago by J.T." because it is true of the fixture — see §3.3 and §3.4 |

## 3. Known gaps in the fixtures — all four fixed in slice 2

Slice 1 did not work around any of these, and slice 2 does not work around them either: each is
fixed at the fixture, which is where the wrong fact is.

1. **The committed routes and the standard scenario disagree.** `src/fixtures/routes.ts` was
   authored before `src/modules/demo/fixtures/standard.ts`: `route2` carries V1 but stops at S4
   and S1, which in the scenario belong to another run's children, and the `familyLabel` on each
   stop names a different family than the scenario does. So slice 1 pairs a run with the committed
   geometry of **its own vehicle** and nothing else, and where the geometry does not name a
   child's stop the board says the window is pending rather than borrowing another run's
   numbers. **Slice 2 regenerates the ADR-007 fixtures against the scenario's own stops.** This is
   a change to committed routing data; it is the team's to make inside B-12's approval, and it
   needs no founder decision.
2. **The afternoon has no committed geometry at all**, so every PM ride's window reads
   "Window pending". Same fix, same slice — and where a window is still genuinely unknown
   afterwards, the cell reads "Time not set yet" with an icon (§2).
3. **A seeded transport profile has no named approver** (`approved_by` is NULL by design in
   `seed.ts`), so the drawer shows the approved version and no approver. §4.2 asks for both.
   **Slice 2 names the approver in the seed** — a synthetic staff name, from the same fixture the
   rest of the screen's people come from.
4. **A verified vehicle capability has no named verifier.** Every other person on this screen is
   named — the child, the adult on file to receive them, the dispatcher who can answer for a van
   — because the fixture has a name for them. The ramp observation does not: `capabilityFor` in
   `scenario.ts` derives "verified" from the one fact the day actually produced (the van has a
   displayable position, so it cannot have skipped the check), and no person is attached to it.
   So slice 1's drawer says "Checked at the ramp before this run." where COPY-GUIDE §5 asks for
   "Verified 17 min ago by J.T.". Inventing a verifier *in the view* would make the sentence read
   right and the screen wrong — so **slice 2 puts the verifier in the fixture instead**, as a
   seeded capability report with a person on it, and the view reads what the day recorded.

## 4. Deviations from the design direction — each one Vera's call, in slice 2

These five are where slice 1 departed from DESIGN-DIRECTION or COPY-GUIDE. Each is a **taste
call, and Vera makes it** — the outcome is either "fixed in slice 2" or "accepted, and the
direction is updated to match" — and recorded on this page when slice 2 lands. **No founder
decision is needed for any of them**: they sit inside B-12's approval, and none touches a founder
lock (D-5's violet reservation is kept, not traded — see the last row).

| § | What it asks | What slice 1 does | Why | Vera's call |
|---|---|---|---|---|
| §4.1 | row carries "provider/vehicle + capability chip" | the van's label and the capability chip on the row; the provider's name in the drawer's ride card | a provider name is three or four words and would take a third line on every row of a 56-row board, against the §4.1 two-line cap and the §1 density dial. The §2 search still finds a child by their provider | keep two lines, or spend a third — §5 |
| COPY-GUIDE §5 | four group headers | five: "Getting ready" is added | the guide's four were written for a mid-morning board where every ride has started. A ride that is planned but has not left is neither "on the way" nor "not riding today" | keep the fifth header (and amend the guide), or fold it into one of the four — §5 |
| §4.1 | row is one child's day, one AM/PM chip and one state chip | **one row per child and ride**: a child's morning and afternoon are two rows, grouped independently | the earlier cut had to pick which of a child's two rides "the row" was about, and then the other one was not on the board at all — a morning van on the road hid an afternoon nobody had reported on. AT-07 is the rule that the two rides are separate things; the board is now shaped like the rule. Rows stay dense (48 px, two lines) and the row count is 56, which is what the surface is for | expected to be accepted and written into §4.1, since AT-07 is the rule it follows |
| §4.1 | row ends in a "next-action owner avatar+name" | a **next step**: a sentence that opens with a verb and names the child — "Record who receives Noah O." | there was no owner to name in slice 1 (no task rows, no assignment), and the only honest alternative was the role — "Coordinator", which is the one fact a coordinator reading their own board already has. A step says what to do | slice 2 brings the Exceptions surface, which owns assignment — so Vera decides there whether the avatar returns beside the step, replaces it, or stays out |
| §2 | header adapter pills in the `src-sim` tone (Vera's interim, 2026-10-14) | the same interim pills, outlined, in `ink-muted` | D-5 reserves the violet for the DEMO bar and the Simulated chip. Four more violet chips in the header, beside a bar that already says "DEMO" and a chip that already says "Simulated", spend the reservation and the colour stops meaning "this is the demo". The §2/§10 *text* is untouched and waits on the live stream; `src/ui/tokens.test.ts` and `e2e/helpers.ts` hold the colour rule from both sides (stylesheets, and the computed colour of every element the browser lays out) | the **colour** is settled by D-5 (ledger row 33) and is not reopened. The **text** changes in slice 3, when the stream gives the pills real ages |

## 5. The calls slice 2 has to carry, and who makes them

All taste; all Vera's; none waits on the founder. Each is answered by something slice 2 is
building, so the answer lands with the code rather than ahead of it.

- **Is "Getting ready" the right fifth group header** (§4), or should a planned-but-not-departed
  ride sit under one of the four? Either way COPY-GUIDE §5 is amended to match what ships.
- **The row drops the provider's name to keep two lines** (§4). Confirm the two-line cap, or take
  the third line and accept the density cost on all 56 rows.
- **The drawer's two rides are still cards** (a hairline box, 12 px) where the board's cards are
  gone. Slice 2's drawer **timeline rows** are the dense answer; Vera confirms that shape or keeps
  the cards.
- **Two "Service date" labels.** The header's is today's real date; the board's is the seeded day
  the scenario replays. Both are true of what they describe, and together they read as a
  contradiction. Slice 2's **date switcher** is the fix: one control that says which day is on
  screen, so the board and the header agree on an answer instead of each asserting its own. (The
  demo-controls dock, §6.1, is what eventually gives the app a scenario clock; the switcher does
  not wait on it.)
- **Regenerating the ADR-007 route fixtures** against the scenario's own stops (§3.1, §3.2) is
  **in slice 2** and is Rudy's to build. It was written here as a founder question; it is not one.
  It is committed-data work inside an approved build step, and it is what gives every rider a real
  pickup window and the afternoon a real arrival before the demo.

## 6. Slice 3 — live updates and the map

| Thing | § | What slice 3 has to land |
|---|---|---|
| Live updates, reconnect delta, the amber "paused" bar over 15 s | §2, §4.1 | the SSE stream (ADR-002), and with it the U3 commit→screen measurement RISKS-AND-QUESTIONS has open |
| The map pane beside the rows, row-hover ↔ marker highlight, fly-to | §4.1, §5 | the split pane at ≥1280 px that D-6 (ledger row 34) decided. The pane itself already exists at `/map-preview` |
| Header adapter pills showing real ages instead of "· Simulated" | §2, §10 | the ages come from the same stream; the pills' **violet is already gone** (§4), so only the text is interim |

---

**B-12 closes when slices 2 and 3 pass** — not when slice 1 looks good. Nothing on this page is
somebody's "later": every row names its slice, and both slices are inside the step the founder
already approved.
