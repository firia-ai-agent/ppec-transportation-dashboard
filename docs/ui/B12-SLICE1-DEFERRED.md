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
| 2 | Inbox, Exceptions & Approvals, the writes, and every fixture and taste item below | **in progress** — the first part landed (docs/ui/B12-SLICE2-DEFERRED.md); §2 marks which rows it closed |
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

Everything in this table lands before B-12 closes. Slice 2 is being built in parts; the rows
marked **landed** are closed by its first part and written up in
`docs/ui/B12-SLICE2-DEFERRED.md`. A row still marked "slice 2" is ahead of us, not parked —
slice 2 does not close until all of them are in.

| Thing | § | What slice 2 has to land |
|---|---|---|
| Inbox (SURF-03) and Exceptions & Approvals (SURF-05) | §4.3, §4.5 | **slice 2, ahead.** Both surfaces, for real. Exceptions is also where B-08's F9 lands — the approval *decision* screen over `ops.change_request` / `ops.approval_request`, which DECISION-LEDGER row 63 dated to B-12 |
| Writes: confirm handoff, **Override with reason**, snooze, approve | §4.2, §4.5 | **slice 2, ahead.** The drawer's actions stop being read-only. Override is the one that has to work end to end: the dialog takes a required reason (`copy.ts overrideHeading` / `overrideReasonLabel`), the write commits, and the row and the drawer both move. "The action is rendered and says it is not connected" was slice 1's honest placeholder, not a shape to keep |
| A disabled Override that **looks** disabled, and says why in one line | §4.2, §9 | **half landed.** The disabled *treatment* is in (`src/ui/tokens.ts`, `today.module.css`): a disabled control no longer wears a live control's border, and `tokens.test.ts` holds it weaker than every usable tone. Override still has **no one-line reason of its own** — `LegDrawer.tsx` renders it under the *handoff's* reason — so that half is **slice 2, ahead**, and the line comes from `src/ui/copy.ts` (never inline prose, never a tooltip alone) |
| 412 conflict toast and the merge view | §4.1 | **slice 2, ahead**, with the writes: there is nothing to conflict with until the board writes |
| Provider / vehicle / AM-PM filter chips with counts | §4.1 | **slice 2, ahead.** Slice 1 shipped the "Only needs action" toggle and the §2 search; slice 2 adds the chips and their counts |
| History, pending approvals and agent changes in the drawer, with real rows | §4.2 | **slice 2, ahead.** The drawer's three sections are empty-state prose today. Slice 2 fills **history** with real rows, and the pending-approval and agent-change rows come from the Exceptions work in the same slice |
| Drawer **timeline rows** | §4.2 | **landed.** The day is a timeline of rows — time column, stops, icon + label state, no box — rather than two hairline cards, the dense treatment the board already uses (Vera's call, §5) |
| **One service date on screen**, in the board's own header | §2, §6.1 | **landed, and it is not a switcher.** Vera's final call (§5): one date, the replayed demo day, labelled as the demo day, with nothing on screen offering another. The shell's duplicate — today's real date on every page — is gone, which is what the two "Service date" labels were. The board takes a service date (`src/domain/board/day.ts`) and other days are reached by a `?date=` URL and by nothing on screen |
| An **AT-13 `HELD_NO_RECEIVER` ride in the scenario** | PRD §6.6, l.1327 | **landed.** The scenario had the *family* for AT-13 — F2, no authorized receiving adult (`standard.ts:140`) — but no ride in the state. C2's afternoon on the finished day is now that ride: `ARRIVED_DROPOFF → HELD_NO_RECEIVER` by the system (CA-04, ledger row 47), with no automatic return because the machine's `noWildcardFrom` gives it no edge out but a staff one. The board, the drawer and AT-13's own check all read it |
| A tighter, **mutation-proven** AT-10 e2e | PRD SURF-01 acceptance | **landed.** Slice 1's AT-10 line was a negative — `expect(page.getByText(/handed off to/i)).toHaveCount(0)` — which also passed on a board that rendered nothing. It now asserts positively on the finished day, where an arrival and a handoff are both on screen and told apart: C6's van arrived and no custody event was recorded, so the row reads "Arrived (vehicle)" and does **not** read as handed off |
| **Afternoon route data aligned with the scenario** | ADR-007, §3 below | **landed for the plan.** `src/fixtures/run-routes.ts` is one route per run per direction, built from the scenario's own stops; the afternoon is the morning reversed (`reverseRoute`) and `plannedEta` gives each stop its family's 10-minute window. No row says "Window pending" any more. The three **ADR-007 replay** routes are untouched — that is still a committed-routing-data change and still the founder's call (§3.1, §5) |
| An unknown window reads **"Time not set yet"**, with an icon | COPY-GUIDE §5, §3 | **moves to slice 3.** Slice 2's geometry made the case unreachable in the committed scenario, but the fallback is still there and still says the code-flavoured "Window pending" (`copy.ts:157`, `TodayBoard.tsx` `WINDOW_PENDING`). The wording is the whole of what is left, so it travels with slice 3's other copy work — never colour or absence alone |
| A **named approver and a named verifier** on the seeded records | §4.2, COPY-GUIDE §5 | **moves to slice 3.** Slice 2 left both fixtures as they were (§3.3, §3.4): `approved_by` is still NULL in `seed.ts` and the ramp check still has no person on it, so the drawer still cannot say "Verified 17 min ago by J.T." and truthfully mean it. Slice 3 puts the approver and the verifier in the seed |

> **Slice 2 (docs/ui/B12-SLICE2-DEFERRED.md) answers §3.1, §3.2 and the service-date question in
> §5.** The afternoon has committed geometry aligned to the scenario, the board carries one
> service date in its own header — the replayed demo day, labelled as the demo day, with no
> switcher beside it — and the day before the demo day carries the rides that *ended*, which is
> where AT-13's held ride and AT-10's arrived-but-not-handed-over van live. That day is reached
> by a `?date=` URL and by nothing on screen: it is where those two acceptance tests are read.
> The rows below are left as they were written, so the two slices can be read in order.

## 3. Known gaps in the fixtures — the slice each one closes in

Slice 1 did not work around any of these, and neither does slice 2: each is fixed at the
fixture, which is where the wrong fact is. Two are closed, one is half closed, and the state of
each is the first thing its row says.

1. **The committed routes and the standard scenario disagree.** `src/fixtures/routes.ts` was
   authored before `src/modules/demo/fixtures/standard.ts`: `route2` carries V1 but stops at S4
   and S1, which in the scenario belong to another run's children, and the `familyLabel` on each
   stop names a different family than the scenario does. So slice 1 pairs a run with the committed
   geometry of **its own vehicle** and nothing else, and where the geometry does not name a
   child's stop the board says the window is pending rather than borrowing another run's
   numbers. **Half closed in slice 2:** `src/fixtures/run-routes.ts` is new, scenario-derived
   geometry — each run's own children's own stops, in `manifestFor`'s order — and every window on
   the board now comes from it. The three **ADR-007 replay** routes are deliberately untouched
   (one is a real OSRM response, and they are the live morning), so regenerating *them* against
   the scenario is still a change to committed routing data and still the founder's call — §5.
2. **The afternoon has no committed geometry at all**, so every PM ride's window reads
   "Window pending". **Closed in slice 2:** the afternoon is the morning reversed
   (`reverseRoute`), which is what the scenario says a run's afternoon is, and
   `run-routes.test.ts` holds every derived arrival to within ten minutes of the window the plan
   promised, stop by stop, in both directions. Where a window is still genuinely unknown the cell
   is the fallback whose wording moves to slice 3 (§2).
3. **A seeded transport profile has no named approver** (`approved_by` is NULL by design in
   `seed.ts`), so the drawer shows the approved version and no approver. §4.2 asks for both.
   **Unchanged by slice 2; moves to slice 3**, which names the approver in the seed — a synthetic
   staff name, from the same fixture the rest of the screen's people come from.
4. **A verified vehicle capability has no named verifier.** Every other person on this screen is
   named — the child, the adult on file to receive them, the dispatcher who can answer for a van
   — because the fixture has a name for them. The ramp observation does not: `capabilityFor` in
   `scenario.ts` derives "verified" from the one fact the day actually produced (the van has a
   displayable position, so it cannot have skipped the check), and no person is attached to it.
   So slice 1's drawer says "Checked at the ramp before this run." where COPY-GUIDE §5 asks for
   "Verified 17 min ago by J.T.". Inventing a verifier *in the view* would make the sentence read
   right and the screen wrong. **Unchanged by slice 2; moves to slice 3**, which puts the verifier
   in the fixture as a seeded capability report with a person on it, and the view reads what the
   day recorded. Slice 2 made it visible in one more place: a morning handoff says "Handed off to
   the ramp" rather than naming the person who received the child, for the same reason.

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

All taste; all Vera's; none waits on the founder — except the last, which is the founder's and
says so. Each is answered by something slice 2 is building, so the answer lands with the code
rather than ahead of it.

**The two service dates are answered.** The row that was here — the header's real date against
the board's seeded day, both labelled "Service date" — is closed. Vera's final call, 2026-10-16:

> One date on screen: the replayed demo day, labelled as the demo day. In demo mode the header doesn't show today's real date. No date switcher.

So there is no date switcher, and none is sequenced: the date lives in the board's own header,
is read and not changed, and the shell carries no date at all (a layout cannot read a day, so a
date up there could only be today's real one — the contradiction itself). The finished day stays
reachable by `?date=` with no control on screen, because that is where AT-13 and AT-10 are
proved. The demo-controls dock (§6.1) is what eventually gives the app a scenario clock; nothing
on this page waits on it.

Still open:

- **Is "Getting ready" the right fifth group header** (§4), or should a planned-but-not-departed
  ride sit under one of the four? Either way COPY-GUIDE §5 is amended to match what ships.
- **The row drops the provider's name to keep two lines** (§4). Confirm the two-line cap, or take
  the third line and accept the density cost on all 56 rows.
- **The drawer's two rides were still cards** (a hairline box, 12 px) where the board's cards are
  gone. Slice 2 landed the dense answer — **timeline rows** — so what is left is Vera confirming
  that shape, or asking for the cards back. The narrow-width extras (van, reason, step) still sit
  under each row because §4.1 folds those columns into this panel below 1280: is that the right
  amount, or should they be visually separated from the two-line ride?
- **A finished day's rows say "No position recorded"** in the van-location column, because this
  slice keeps no position history. Is a column that can only say that worth keeping on a finished
  day, or should it fold away like the three that fold below 1280?
- **Rudy / founder: regenerating the ADR-007 replay routes** against the scenario's own stops
  (§3.1). The run-aligned routes now exist and agree with the plan, so this is a smaller change
  than it was — it would give the live morning real per-child pickup arrivals, and it is the one
  item on this page that is a founder decision, because it changes committed routing data.
- **Rudy:** the finished day is a fixture in `standard.ts`, not something `demo reset` seeds. When
  the scenario clock lands (§6.1 dock), the honest version is the clock walking the real day and
  the board reading whatever it has reached. Does the clock subsume this fixture, or stay beside
  it as the "yesterday" the board can look back at?

## 6. Slice 3 — live updates, the map, and the two fixture names

| Thing | § | What slice 3 has to land |
|---|---|---|
| Live updates, reconnect delta, the amber "paused" bar over 15 s | §2, §4.1 | the SSE stream (ADR-002), and with it the U3 commit→screen measurement RISKS-AND-QUESTIONS has open |
| The map pane beside the rows, row-hover ↔ marker highlight, fly-to | §4.1, §5 | the split pane at ≥1280 px that D-6 (ledger row 34) decided. The pane itself already exists at `/map-preview` |
| Header adapter pills showing real ages instead of "· Simulated" | §2, §10 | the ages come from the same stream; the pills' **violet is already gone** (§4), so only the text is interim |
| A **named approver and a named verifier** in the seed | §4.2, COPY-GUIDE §5 | moved here from slice 2 (§2, §3.3, §3.4), which left both fixtures as they were |
| An unknown window reads **"Time not set yet"**, with an icon | COPY-GUIDE §5, §3 | moved here from slice 2 (§2): the case is unreachable in the committed scenario, and the fallback's wording is all that is left |

---

**B-12 closes when slices 2 and 3 pass** — not when slice 1 looks good. Nothing on this page is
somebody's "later": every row names its slice, and both slices are inside the step the founder
already approved.
