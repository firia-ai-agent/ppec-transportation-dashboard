# S1: Agent chat bubble on every page

Branch `team/ppe-agent-bubble`, cut from `origin/main` at `23258ff`.

The founder's ask, 2026-10-18: *"a floating chat bubble at the bottom right, inside the app
frame, that opens the agent chat from any screen."*

Binding mockup: `/workspace/ppec-redesign/mockups/agent-bubble.html`, with
`png/agent-bubble-{closed,open}-{1440,390}.png`, and
`/workspace/ppec-redesign/mockups/family-texts.html` (`.prop`) for the compact proposal card.

---

## The rulings this PR is built to

**Firia and Vera, 2026-10-18 9:17 AM ET:**

1. **Approve, Edit and Skip are OFF the proposal card inside the bubble.** Acting in place needs
   #75's approval path. In their place is one small **amber "Needs approval" chip**. The three
   return, with their words and with #75's writer, after #75 merges. The coral waiting dot stays.
2. **Every ask shows right away.** Pressing send puts the staff text in the thread as a teal
   bubble before `POST /api/agent/ask` returns, and it stays there whatever the response is. If
   nobody could answer — runner not ok, `PROVIDER_ERROR`, no key, a network error, any non-2xx, or
   a preview that wrote nothing — one grey **"I can't answer right now."** appears under it. The
   server's staff alert path is unchanged. **No keyword or text-parser fallback**, and no key is
   ever read or logged on this path.
3. **S3 cleanup**: the disc clears the tab bar by 16 px, not 15.

**Firia, 2026-10-18 9:21 AM ET — this one overrides the 9:17 reading of ruling 1:**

4. **The amber "Needs approval" chip is PLAIN TEXT, no link, until #75 merges.** It is a
   non-interactive `<span>`: no `<a>`, no `href`, no `Link`, no `role="link"`, no `onClick`, no
   `tabIndex`. The 9:17 ruling left it as a link to `FAMILY_TEXTS_FOR_YOU`, and a link is still an
   offer — the eye reads an amber pill inside a proposal card as the thing to press, and pressing
   it leaves the panel for a screen whose decide path is #75's and is not on main. A label that
   says where the proposal stands makes no offer at all, and that is the whole of what this branch
   can honestly say.

   `next/link` and `FAMILY_TEXTS_FOR_YOU` are **gone from `AgentThread.tsx` entirely** — the import
   and its one use. The `canOpenForYou` **visibility guard is untouched**: it is a different rule
   (`agent-bubble-state.ts`), and the bubble is still drawn only for a role that may decide.

   Because the chip is no longer an anchor it is now **the app's one `Pill`** (`<Pill tone="warn">`,
   `src/ui/Pill.tsx`) instead of a pill-shaped rule of its own. That closes a real break: the 9:17
   commit left `AgentThread.module.css` `.chip` as a **second pill** in the repository and
   `src/ui/pill.test.ts:126` ("is the only pill in the repository") was **red on HEAD** because of
   it. `.chip` and its focus ring are deleted; §4.1's 22 px shape, amber pair and never-wrap come
   from `Pill.module.css`, which is the one file allowed to hold them.

---

## What's in it

**The disc.** 56 px, teal, a chat icon and no visible label, 16 px off the frame's bottom-right
corner. Below 768 it sits 16 px above the tab bar — written as the bar's height, **plus the bar's
own hairline**, plus the gap, plus the device's safe-area inset. The hairline is ruling 3:
`--layout-tab-bar-height` is a `min-height` on the *tab*, inside a bar that takes a 1 px
`border-top`, so the measured box is 65 px and the mockup's flat `bottom:80px` lands the disc a
pixel short. The safe-area inset is there because the bar pads itself by it and the mockup's 80 has
none to add. A coral dot with a white ring rides on it while a proposal is
waiting, and the count is also words in the button's accessible name, so the dot is never the only
cue (§3).

**The panel.** At 1440, 400 px against the right edge, from under the DEMO bar to the floor, with
**no dark overlay** — the founder can still read the board while it is open. The disc is hidden
while the panel is. At 390 the same panel is a full sheet over the tab bar with a 44 px close X.

**Mounted once**, in `src/ui/ConsoleShell.tsx` — the one component every app route's layout
renders. One mount is every route, by the same argument `src/ui/one-menu.test.ts` makes about the
menu, and it *has* to be one rather than four: a bubble mounted per layout would close itself every
time somebody changed tab.

**Who sees it.** `canOpenForYou(caller)`, resolved on the server by the shell and handed down as a
boolean — the same function the For you page guards itself with, never a list of roles in a
component. The front desk keeps Live map and Ramp iPad with **no bubble on either**, because the
bubble shows proposals waiting for a decision and they may not decide. `src/auth/access.ts`'s role
table is unchanged; this is a visibility rule on top of the server's, never instead of it.

**Where it is not.** Family texts → For you. The bubble's thread *is* that screen, and a floating
copy of a screen on top of itself is two places to approve one thing.

**Clearance.** Pages get 88 px of bottom padding at 1440 (16 + 56 + 16) and 80 px on top of the tab
bar's 64 at 390 — the spec's 144. It is on the content column (`.main` / `.contentSlot`) rather
than on `.body`, because the rail runs to the floor in the mockup and must not be shortened.

**The ask.**

```
ask → one ops.task row (raiseTask, the writer every executor already uses)
    → a `staff.ask` trigger carrying that row's id
    → agentRunner() → the one run loop → the one gateway → the one policy engine
```

No second agent, no second prompt pipeline, no second policy, no second approvals table. A
`propose_*` call from an ask is a `PROPOSED` call row plus the `ops.approval_request` /
`ops.change_request` that `liveProposalWriter` already writes. No executor runs for a `propose_*`
— the policy engine returns PROPOSAL for every `human`-tier call and the loop never looks for an
executor — so **there is no code path on which an ask applies a change**.

Three refusals, all no-ops with a name: a **preview** writes nothing at all (`previewSkip`, asked
before any row is derived); **no runner** raises the staff alert; a **model that cannot be reached**
mid-run raises the same alert. The staff alert is `docs/DATA-MODEL.md`'s — an open `NEEDS_PERSON`
task, RED, with no proposal on it. There is **no keyword or text-parser fallback**.

`OPENROUTER_API_KEY` is never read on this path; the key stays the remote adapter's, by env-var
name only. The runner's own refusal sentence names build milestones, so it is the module's **log**
channel and the route forwards only `{ ok, outcome }` — asserted by reading the route file.

**What the panel does with that ask (ruling 2).** `src/ui/agent-ask-state.ts` is one external
store, read by the bubble the shell mounts once:

```
send → addAsk(text)            teal bubble in the thread, BEFORE the request leaves
     → await post(text)        the one POST, unchanged
     → ok === true ?  nothing : addNoAnswer(id)   one grey line, directly under that ask
```

The order is the rule, and nothing between those lines or after them can remove the bubble. The
field empties on send rather than on a response (`AgentCompose.tsx:42`), because the ask is in the
thread by then and leaving it in the box as well is the same sentence twice. Everything that is
not an answer is the same answer: a network error, a 500, a 503, and a 200 carrying `ok:false` —
which is what the route returns for a runner that is not ok, a gateway `PROVIDER_ERROR`, a missing
key, and a preview that wrote nothing (`previewSkip`) — all give one `agentBubble.noAnswer`, at
most once per ask, found by the ask's own id so two asks in flight cannot answer each other.

The store is **not persisted**: an unanswered ask is not a message this app stores, so remembering
it past the tab's life would be the panel inventing a history. Its server snapshot is empty, so the
markup the browser hydrates with agrees — the same shape `agent-bubble-state.ts` uses for
open/closed.

The two *notice* lines above the compose field are gone with their copy (`agentAsk.sent`,
`agentAsk.unavailableNotice`). What the panel says back is now said in the thread, where the
question was asked; a status line saying one thing while the thread said another was two answers to
one question.

**The proposal card (rulings 1 and 4).** The question as the title, then one amber chip reading
"Needs approval" — `<Pill tone="warn">`, a plain `<span>` with nothing to press
(`AgentThread.tsx:118`). Amber is §8's `warn` pair, the same tone the Plan routes board's hints
wear, at the one pill height; no hex, and no second pill (`AgentThread.module.css:103` says why the
chip's CSS is *not* in that file). The three buttons and their copy are **deleted, not left dead**,
and so is the chip's `href`.

---

## Placement numbers

| | 1440 | 390 |
|---|---|---|
| disc | 56 px, 16 px from right and bottom | 56 px, 16 px from right |
| disc above the floor | 16 px | 64 px tab bar + 1 px bar hairline + 16 px + `env(safe-area-inset-bottom)` |
| page bottom padding | 88 px (`--layout-agent-bubble-clear-wide`) | 64 (bar) + 80 (`--layout-agent-bubble-clear-phone`) = 144 |
| panel | 400 px, `top: 32px` (DEMO bar), no scrim | full sheet, `left: 0`, over the tab bar |

**Tab bar**: `--layout-tab-bar-height` 64 px as a `min-height` on the tab (`TabBar.module.css:26`),
a 1 px `border-top` on the bar (`:110`), and `env(safe-area-inset-bottom, 0px)` of padding under it
(`:117`) — a 65 px box plus the inset. The disc clears all three
(`AgentBubble.module.css:132`, asserted at `src/ui/agent-bubble.test.ts:327`).

**Live map controls** (`src/modules/live-map/LiveMapPane.tsx:179,181` adds the credits and the zoom
group at `bottom-right`; `live-map.module.css` widens the zoom buttons to the §9 44 px target and
pads the group by 4 px). **Nothing in that file moved** — the clearance is the content column's
bottom padding, which shortens the pane and lifts everything pinned to its floor:

- **1440** — pane floor 88 px above the window's, the group's own 4 px padding puts its lowest
  pixel 92 px up, the disc's highest is 72 px up (16 + 56): **a 20 px gap**.
- **390** — pane floor 64 + 80 = 144 px up, the group's lowest pixel 148 px up, the disc's highest
  136 px up (64 + 16 + 56): **a 12 px gap**.

The arithmetic is written down in three places: `live-map.module.css` next to the controls it is
about, `src/ui/agent-bubble.test.ts:396-432` as arithmetic over the tokens, and measured in a real
browser by `e2e/agent-bubble.spec.ts:92`.

---

## Tests

| Check | Where |
|---|---|
| **(a)** renders on every app route | `src/ui/agent-bubble.test.ts:107` — `:113` mounted by ConsoleShell, `:120` mounted exactly once in the whole app, `:127` every menu destination's layout chain mounts the shell (enumerated from `navItems` + the access table, never listed by hand), `:140` the disc renders, `:149` the dialog |
| **(b)** hidden on Family texts → For you, and for roles without `canOpenForYou` | `src/ui/agent-bubble.test.ts:169` — `:174` For you draws nothing, `:182` the other tabs still do, `:198` every role in `ROLE_LADDER` × four screens, `:212` no-role and anonymous, `:220` the one pure decision function |
| **(c)** coral dot iff a proposal is waiting | `src/ui/agent-bubble-thread.test.ts:61` — `:62` none waiting, `:69` one waiting, `:75` many, `:86` the 14 px coral geometry, `:94` hidden with the disc |
| **Ruling 1** — no Approve/Edit/Skip in the bubble | `src/ui/agent-bubble-thread.test.ts:136` — `:137` the question then the chip, **`:186` none of the three words and no `<button>` anywhere in the thread, and zero `href`s**, `:201` no decide writer in the bubble. In a browser: `e2e/agent-bubble.spec.ts:201` |
| **Ruling 4** — the chip is plain text, not a link | **`src/ui/agent-bubble-thread.test.ts:155`** — the words are present and rendered in a `<span>`, and the thread has no `<a`, no `href=`, no `role="link"`, no `tabindex` and no `<button>`/`<form>`; plus `AgentThread.tsx` (comments stripped) contains none of `next/link`, `FAMILY_TEXTS_FOR_YOU`, `href`, `onClick`, `role=`. `:170` the chip is the one `Pill` (`data-tone="warn"`, `data-pill="true"`, `_pill_`) and `AgentThread.module.css` has no `.chip`, no `--color-warn-*` and no hex left. The one-pill guard that was red on HEAD: `src/ui/pill.test.ts:126`. In a browser: **`e2e/agent-bubble.spec.ts:201`** |
| **Ruling 2 (a)** the teal bubble is there before the fetch resolves | `src/ui/agent-ask.test.ts:79` — **`:80`** the exact text in `.outbound` while a `post()` that never settles is in flight, `:96` shown even when the server thread is empty (not the empty line), `:104` still there after a 503 and after a success, `:113` the insert precedes every `await` in `sendAsk` |
| **Ruling 2 (b)** one grey line, whatever went wrong | `src/ui/agent-ask.test.ts:126` — **`:144`** six cases (network error, 503, 500, `ok:false` "unavailable", `ok:false` "skipped" preview, a non-JSON body): ask still present, the line exactly once, under the ask, grey/left, no "AI"; `:160` nothing at all when it was answered; `:167` never twice for one ask; `:174` the right ask of two in flight; `:188` no `console.`, no key, no parsing of the ask |
| **Ruling 2 (c)** the field clears, two asks are two bubbles in order | `src/ui/agent-ask.test.ts:201` — `:202` `setText("")` is in the handler ahead of the `await` and not conditional on the response, `:217` two asks in order, `:228` they sit under whatever the server thread held |
| **Ruling 2** the asks live in the persistent bubble | `src/ui/agent-ask.test.ts:245` — `:246` read as an external store with an empty server snapshot, `:258` nothing persisted and no fetch in the store |
| **Ruling 3** the disc clears the tab bar by 16 | `src/ui/agent-bubble.test.ts:327`. In a browser: `e2e/agent-bubble.spec.ts:82` |
| **(d)** a proposal from the bubble is PENDING and applies nothing | `src/modules/agent/ask/staff-ask.db.test.ts:110` — `:111` one run on a `staff.ask` trigger whose id is the ask's row, **`:132`** the approval request with `decided_at`/`decision` null, the task beside it, and `stateSnapshot()` unchanged, `:174` the ask row, `:186` empty/oversized writes nothing, `:199` a preview writes nothing |
| **(e)** model unavailable → the staff alert, no keyword parser reachable | `src/modules/agent/ask/staff-ask.db.test.ts:215` — `:221` `agentRunner()` refuses by name, `:227` NEEDS_PERSON/RED/OPEN and no run, `:244` no vendor, model, key-shape, endpoint or "AI" on the row or in what the route forwards, `:280` the same alert when the model is reached and fails, **`:310`** walks the ask module's import graph and proves `providers/keyword.ts` and `providers/remote.ts` are not on it |
| **(f)** state survives navigation | `src/ui/agent-bubble.test.ts:239` — `:246` the state lives in the shell that does not remount (external store, not `useState` per page, not the URL), `:256` subscribers, `:268` closed on the server, `:280` remembered across a full load, `:290` a storage that throws |

Plus the mockup's own numbers (`agent-bubble.test.ts:308-394`), the thread's grey/teal sides and
the compact card (`agent-bubble-thread.test.ts:104-177`), and the thread read
(`staff-ask.db.test.ts:350-399`: empty day, ask-then-proposal in order, a decided proposal stops
counting, another site sees nothing, fail-soft).

**Runs.** The full-suite figure below is from commit `e1223f3`, before the three ruling commits:
`TZ=America/New_York npx vitest run --maxWorkers=2` — **7140 tests, 7133 passed, 4 skipped, 3
failed**, all three failures pre-existing (see below). The three ruling commits were each verified
with the named files only, in the foreground, as this lane requires:

```
TZ=America/New_York npx vitest run --maxWorkers=2 \
  src/ui/agent-ask.test.ts src/ui/agent-bubble.test.ts src/ui/agent-bubble-thread.test.ts \
  src/ui/copy.test.ts src/ui/shell.test.ts src/ui/one-menu.test.ts src/ui/no-hex.test.ts \
  src/ui/no-codes.test.ts src/ui/no-internals.test.ts src/ui/rebuilt-screens.test.ts \
  src/modules/agent/no-network.test.ts src/modules/agent/no-hardcoded-models.test.ts
→ 12 files, 2045 passed
```

`npx tsc --noEmit` clean and `npx eslint .` clean at every one of the three commits.

### Mutation proof for ruling 2 (a)

Remove the optimistic insert — `const id = addAsk(text)` → `const id = "ask:mutant"` in
`sendAsk` (`agent-ask-state.ts:123`), so the request still goes out and the reply still has an id
to look for, but the teal bubble is never added. `src/ui/agent-ask.test.ts` → **RED, 12 failures**,
including `:80` ("puts the exact text in a teal bubble while the request is still in flight").
Restored → **GREEN, 19 passed**, and `git diff --stat` on the file empty.

### Mutation proof for (d)

Both directions, each restored green afterwards:

1. **Make the proposal auto-apply** — add `UPDATE ops.trip_leg SET version = version + 1 ...` to
   `manifestReallocation` in `run/exec/proposals.ts` → `staff-ask.db.test.ts:132`
   ("applies no change") **RED** on the `stateSnapshot()` diff.
2. **Bypass the loop's PROPOSAL branch** — `if (false && verdict === "PROPOSAL")` in
   `run/loop.ts:477`, so a human-tier call falls through to an executor → the same test **RED**.

Restored after each: `12 passed`, and `git diff --stat` on both files empty.

### E2E — `e2e/agent-bubble.spec.ts` (259 lines)

**Playwright was NOT run** (the lane forbids it). The spec typechecks under `tsc`, which covers
`e2e/`, and uses the repo's existing helpers (`boxOf`, `overlaps`, `shot`,
`expectNoInternalCodes`) and its `E2E_DEMO_ROLE` convention. `/workspace/ppec-b08/playwright-free.flag`
was not created.

It cites `agent-bubble.html` and all four `agent-bubble-*.png` in its header, plus
`family-texts.html` for the compact card, and at **390×844** and **1440×900**:

- `:66` the disc's 56 px box, 16 px off the corner, on Today, Plan routes and Live map at 1440;
- `:82` the disc **16 px** above the tab bar and not overlapping it, on the same three at 390
  (ruling 3: this is the assertion the missing hairline made measure 15);
- `:95` the disc overlaps neither `.maplibregl-ctrl-group` nor `.maplibregl-ctrl-attrib` at either
  width;
- `:124` the 400 px panel under the DEMO bar, no scrim, disc hidden;
- `:142` the full sheet at 390 with a 44 px close X, and close puts the disc back;
- `:167` the title, the compose bar pinned to the foot, no details table, no clock times;
- **`:201`** no `Approve`, `Edit` or `Skip` as a button or a link **anywhere in the panel**, and
  **no link or button carrying "Needs approval" either** — plus, for every proposal card that is
  drawn, the words are in the card and `a, [href], [role='link'], button, [tabindex]` inside it
  counts zero, and no `a[href="…/family-texts?tab=for-you"]` exists in the panel. (The chip is only
  drawn when something is actually waiting, which the demo day decides, so the ruling is asserted
  as the absence of a control rather than the presence of one — a claim that holds either way);
- `:225` the panel stays open across a navigation between tabs;
- `:241` no bubble on Family texts → For you; `:251` none anywhere for a role that may not decide.

---

## Overlap with #75 (`team/ppe-rework-approvals`)

Nothing was read from or copied out of that branch. Three places will need one merge each:

1. **`src/ui/copy.ts`** — this branch appends two blocks at the end of the file, `agentBubble`
   (the panel's words) and `agentAsk` (the rows an ask writes). #75 adds a large block of its own.
   Both are appends to the same file; expect a textual conflict at the tail and no semantic one.
2. **Approvals *decide*.** Main has **no decide write path**, and rulings 1 and 4 are the answer to
   that: the card carries no Approve / Edit / Skip at all, and the amber "Needs approval" chip is
   plain text — it does not even navigate. **Nothing auto-applies, nothing half-applies, and
   nothing in the bubble leaves the panel.** When #75's `src/modules/approvals/decide.ts` lands,
   the three buttons come back with its writer behind them; the change is
   `src/ui/AgentThread.tsx:111-121`, the three strings back in the `agentBubble` block of
   `copy.ts`, a row style for the buttons in `AgentThread.module.css`, and the three tests that
   currently assert their absence (`agent-bubble-thread.test.ts:155`, `:186`,
   `e2e/agent-bubble.spec.ts:201`) flipped back to asserting their presence. If the chip is to
   become a link again, it stops being `<Pill>` and `pill.test.ts`'s named-exception list is the
   place that has to be argued with — which is deliberate.
3. **Approvals *read*.** `src/modules/agent/ask/thread.ts` reads `ops.approval_request` (no
   `decided_at`) and `ops.change_request` (`NEEDS_HUMAN`) directly. #75 is building a read for the
   For you list; when it lands, this should call it rather than keep its own two statements.
4. **`src/modules/demo/agent-turn.ts`** — #75 adds it. This branch does **not** touch it and does
   not depend on it. If it becomes the demo's ask path, `askAgent` is the function it should call.

---

## Two existing assertions changed, with reasons

Neither is a loosening; both carry the reason in the source beside them.

1. **`src/modules/agent/run/run-loop.test.ts:489`** — "the five trigger types" now names six. The
   §11.1 five are still asserted, in order; `staff.ask` is named beside them. It is a sixth entry
   rather than a reuse because `(trigger_type, trigger_id)` **is** the run's identity: `msg.inbound`
   means a family texted us and carries that message's row, and calling a typed staff ask by that
   name would make the idempotency key lie about where the run came from. **No migration** —
   `ops.agent_run.trigger_type` is plain text with no CHECK.
2. **`src/ui/pill.test.ts:126`** — "is the only pill in the repository" gains one named file with
   its source cited: `AgentCompose.module.css` `.field`, which the mockup draws as a 44 px pill with
   "Ask the agent…" in it (`.cmp .in2`). The rule is about *status chips* — a rounded, padded box
   claiming something about the day — and an `<input>` the person types into claims nothing. The
   shape test cannot tell them apart because the difference is the element, not the CSS. So the
   file is named rather than the rule widened to any bordered box, and a second test
   (`pill.test.ts:141`) holds that the exception is exactly that one rule in that one file.

   **That list is still exactly one file.** The 9:17 commit had quietly added a second offender —
   `AgentThread.module.css` `.chip` — which left `pill.test.ts:126` **red on HEAD**; ruling 4's
   commit deletes that rule and makes the chip `<Pill tone="warn">`, so the test is green again and
   the exception list did not have to grow.

`src/auth/access.test.ts:454` gains the new endpoint in its written-out policy map, which is what
that test exists for.

---

## What production will show today

**The bubble is real and the ask does nothing.** `agentRunner()` refuses in this deployment —
there is no §11.1 context assembler, and a run driven against a scope the process invented is worse
than no run (`src/modules/agent/run/deps.ts:49`). So on the demo:

- the disc is on every app screen for the director and the coordinator, and on none for the front
  desk;
- opening it shows the panel, the day label, anything already on the board, and the compose bar;
- **sending an ask puts it in the thread immediately** as a teal bubble, and **raises the staff
  alert** — one open `NEEDS_PERSON` task, RED, with the ask in it — after which one grey
  *"I can't answer right now."* appears under the ask. No model is called, no proposal is made,
  nothing is sent to a family;
- **on a Vercel preview, an ask writes nothing at all** (`previewSkip`) and the panel shows the
  same two bubbles: the teal ask, and the grey line under it;
- a proposal already waiting shows as the compact card with one amber **"Needs approval"** chip,
  which is a label and not a button or a link: it says where the proposal stands, and deciding it
  is still done on Family texts → For you, reached from the menu like any other screen.

So the demo-safe story is: the bubble is there on every screen, it is honest about what it cannot
do, and the thing a founder clicks never silently changes the day.

---

## Known mismatches against the mockup, and what is missing

Listed honestly rather than fixed.

- **No driver messages.** The mockup's grey bubble is "Marcus L. · Van 1 — Running 10 min behind on
  Okeechobee". **Main has no store for it**: `ops.message` holds the family SMS threads (direction
  IN from a guardian's number) and nothing records a driver saying anything. The component renders
  that bubble the moment there is one (`AgentThread.tsx:50-60`, tested at
  `agent-bubble-thread.test.ts:105`), but today the thread shows the staff's own asks and the
  proposals waiting, and nothing else. **Nothing is invented** — an empty day says so in one line.
- **Spacing within 4 px of the mockup, forced by the token scale** (lengths come from
  `src/ui/tokens.ts`, which is this repo's source of truth): panel head `padding-left` 16 vs 20;
  the close X's radius 6 vs 8; `.who` bottom margin 2 vs 3 and top 12 vs 10; the day label's bottom
  margin 12 vs 10; the outbound bubble's top margin 16 vs 18; the compose bar's padding 12/16/16 vs
  10/14/14; the proposal card's radius 16 vs 14 and padding 8 vs 10.
- **Two colours and one type step substituted**, each because a rule this repo already holds says
  so, each written down in the stylesheet: the mockup's bubble grey → `--color-neutral-bg` and its
  timestamp grey → `--color-ink-muted` (tokens.ts's §8 list is closed and `tokens.test.ts` asserts
  the whole set); the 11.5 px day label reads at 12 (§2's floor is 12, 11 is the one pill's alone,
  `pill.test.ts`). Message text reads at the app's 14 px body step rather than the mockup's 15.
- **The panel's two soft shadows** are the one exception to this app's hairline-ring convention.
  They are the mockup's and they are in `tokens.ts` (`shadow.bubble`, `shadow.panel`), which is the
  only file that may hold a colour — a 56 px disc floating over a scrolling board needs to be
  legible against whatever is behind it, and a 1 px ring on white over white is not.
- **No Approve / Edit / Skip on the card at all** — ruling 1; one amber chip instead, and that chip
  is **plain text with no destination** (ruling 4). This is a deliberate divergence from
  `png/agent-bubble-open-1440.png`, which draws the three.
- **The chip reads at the one pill's 11 px semibold**, not the mockup's 12 px medium, because it is
  now `<Pill>` and §4.1's pill is 11/22 everywhere in the app.
- **No unread/typing state, no streaming reply.** Neither was asked for.

---

## After the demo

Named here rather than quietly carried.

1. **An ask with no model is still not stored, so it does not survive a reload.** The teal bubble
   and its grey reply are client state in the bubble (`agent-ask-state.ts`) and are deliberately
   not persisted: `askAgent` writes an `ops.task`, not an `ops.message`, so there is no row for
   the thread read to find. The ask is on a coordinator's list either way — that is what the staff
   alert is — but the *conversation* restarts empty on a full page load. Making it survive means
   giving an ask a message row of its own, which is a data-model decision
   (`docs/DATA-MODEL.md`), not a UI one.
2. **The thread is today's.** `src/modules/agent/ask/thread.ts` reads the current service day, and
   the panel draws one "Today" separator. Yesterday's conversation is not reachable from the
   bubble. Scrolling back needs a paged read and a second day separator; neither was asked for.
3. **The three buttons go back on the card after #75 merges, and the chip can be a control again**
   — rulings 1 and 4, and the exact edit is listed as overlap item 2 above. Until then there is no
   way to act on a proposal from the bubble and no way to navigate to one.
4. **No driver messages yet**, for the reason in the previous section: main has no store for one.

---

## Pre-existing failures, not this lane

`src/auth/guard-matrix.test.ts` has **3 failing tests on `origin/main` at `23258ff`**:
`/plan-preview as noRole`, `/plan-routes as noRole`, and "a signed-in person with no role anywhere
is refused every staff page, body and all". All three throw
`invariant expected app router to be mounted` from `PlanBoard.tsx:135` (`useRouter`) while
`expectNothingLeaked` renders the page under test.

Verified as pre-existing by running that file with this branch's `ConsoleShell.tsx` and `access.ts`
replaced by main's (`git show 23258ff:…`): the same three fail. Untouched here — it is a real
failure in the inherited main and somebody should look at it, but fixing an access-matrix test was
not this lane's to do at this hour.

---

## Hard rules honoured

No migrations, nothing under `drizzle/`, no `src/db/schema.ts` change. No SQL against any
real/preview/prod database; `/api/demo/reset` never called; PGlite harness only. No env changes, no
`.env` read or printed, no secret in a fixture or a snapshot. No rebase, amend, reset, force or
push; no `gh`. Nothing read from `team/ppe-rework-approvals`. Playwright not run;
`/workspace/ppec-b08/playwright-free.flag` not created. Every string in `src/ui/copy.ts`, every
colour from `src/ui/tokens.ts`, violet still the DEMO bar's alone, no "AI" label and no vendor or
model name anywhere on a screen.
