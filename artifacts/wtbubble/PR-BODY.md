# S1: Agent chat bubble on every page

Branch `team/ppe-agent-bubble`, cut from `origin/main` at `23258ff`, and **merged up to**
`origin/main` at `fd818d9` (the merge of #82, Ramp iPad). The merge was a merge, never a
rebase, and had no conflicts; `tsc`, `eslint` and the relevant vitest files are clean at the
merge commit itself (`7087608`) as well as at the commits on either side of it.

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

**Two follow-ups in the same pass, neither of them a ruling — they are the lane's items 1 and 2:**

5. **The send button is grey until there is something to send.** The round teal disc at the foot
   of the panel was live over an empty field, which is an offer the app cannot keep: `askAgent`
   writes nothing for an empty ask, so pressing it put a teal bubble of nothing in the thread and
   one grey "I can't answer right now." under it — the panel answering a question nobody asked.
   Whitespace counts as empty, because three spaces look exactly like none.
6. **One shared offset for a page's pinned bottom action bar**, now that #82 has merged and the
   ramp iPad pins Confirm to the floor below 768. Not a Ramp special case in the frame: a CSS
   custom property with a default of 0, declared by the page, read by the frame.

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

**The send button (item 1).** `disabled` — a real attribute, so it is out of the tab order — with
`aria-disabled` beside it for the readers that announce a state rather than skip the node, while
the field is empty or holds only whitespace, and while a request is in flight so one ask cannot
become two. Teal again on the first non-whitespace character. The grey is §4.2's
`--color-disabled-bg` / `--color-disabled-fg`, the pair `tokens.ts` documents at 4.34:1 so the
arrow inside the disc stays legible; no hex, and **no new string** — an empty field is its own
visible reason, and a sentence explaining it would be the panel talking about itself.

ONE PREDICATE, THREE READERS: `canSendAsk(text)` (`agent-ask-state.ts:120`) is read by the
button's `disabled` (`AgentCompose.tsx:101`), by the submit handler (`:53`), and by `sendAsk` in
front of the fetch (`agent-ask-state.ts:146`). Enter in a one-field form is a submit and a
disabled button is not the only way in, so the refusal has to be in the function that holds the
`post` as well — that is the only place it can be guaranteed. `sendAsk("   ", post)` returns
without calling `post` and without adding a bubble.

The bar is split into the stateful `AgentCompose` and a pure `ComposeBar` that takes the text as a
prop. That split is what makes the three states assertions about **real rendered markup**: this
repo's vitest runs in node with no DOM and no testing-library, so without it "grey over three
spaces, teal over 'hi'" could only have been a source grep.

**The sticky action bar offset (item 2).** The operator line says **#82 is merged into
`origin/main` (YES)**, confirmed with `git merge-base --is-ancestor fd818d9 origin/main` before
merging, so this item was done rather than skipped.

#82 pins Confirm to the floor below 768 (`arrival.module.css` `.confirmBar`, `position: fixed`
above the tab bar). The agent disc is pinned to the floor by the *frame*. At 390 they share the
bottom-right corner, and without an offset the disc's box is **y 707–763** against a Confirm bar at
**y 703–780** — the disc on the one button that screen exists for.

The fix is a contract, not a Ramp case:

- `--sticky-action-bar-height`, **default `0px`**, emitted into the one `:root` block from
  `tokens.ts` (`stickyActionBar`, `:498`; the var at `:555`);
- every frame rule that floats something at the bottom adds `var(--sticky-action-bar-height, 0px)`
  — the disc's `bottom` at <768 (`AgentBubble.module.css:142`) and the page's bottom padding at
  both widths (`AppShell.module.css:49`, `:65`, `:91`). The **explicit `0px` fallback** matters: a
  bare `var()` with no fallback is the guaranteed-invalid value inside `calc()`, which would drop
  the whole declaration and put the disc back on the window's floor;
- a page that pins a bar declares its own height on the document root, for as long as it is the
  page (`arrival.module.css:543`).

Nothing in `AgentBubble.module.css` or `AppShell.module.css` names the ramp iPad or knows it
exists, and `arrival.module.css` names no bubble geometry — both asserted, because a
`[data-page="ramp"]` selector is precisely what this is instead of. The next screen with a pinned
Confirm gets the clearance by declaring a height, not by somebody remembering to add a second
special case to the bubble's stylesheet.

**THE NUMBER IS DERIVED FROM THE BAR'S OWN CSS**, not measured off a screenshot:
`border-top` 1 + `padding` 8 + the Confirm button 60 + `padding` 8 = **77 px**. The bar holds
exactly one child (`VanArrival.tsx` renders `.confirm` and no hint beside it), so its `gap` never
applies and the height is its padding box plus that button. The 60 was a literal in two places and
is now `--ramp-confirm-height` written once (`arrival.module.css:17`) and read by both
`.confirm`'s `min-height` (`:303`) and the sum (`:544`) — and the sum is written as a sum, so a
changed padding moves the disc with it rather than leaving a stale 77 behind. The declaration sits
**inside the <768 media query only**: at 768 and above the bar is back in the flow at the foot of
its card and the frame's default 0 is the right answer.

At 390×844 that puts the disc at **y 630–686** against a bar at **y 703–780** — a **17 px gap**.

One honest consequence: on `/ramp-ipad` at 390 the bottom whitespace now stacks the shell's
bubble clearance (80) on top of the 77, on top of the page's own `padding-bottom` for its bar. That
is the cost of the frame and the page each clearing what they are responsible for; the alternative
is the frame knowing which pages pin bars, which is the thing this replaces. `.page`'s own
`padding-bottom` (#82's, `84px`) was **not** touched — changing it would move #82's measured
numbers, and that is not this lane's.

---

## Placement numbers

| | 1440 | 390 |
|---|---|---|
| disc | 56 px, 16 px from right and bottom | 56 px, 16 px from right |
| disc above the floor | 16 px | 64 px tab bar + 1 px bar hairline + 16 px + `--sticky-action-bar-height` + `env(safe-area-inset-bottom)` |
| …on `/ramp-ipad` at 390 | — | + 77 px of pinned Confirm bar → disc at y 630–686, bar at y 703–780 |
| page bottom padding | 88 px (`--layout-agent-bubble-clear-wide`) | 64 (bar) + 80 (`--layout-agent-bubble-clear-phone`) = 144 |
| panel | 400 px, `top: 32px` (DEMO bar), no scrim | full sheet, `left: 0`, over the tab bar |

**Tab bar**: `--layout-tab-bar-height` 64 px as a `min-height` on the tab (`TabBar.module.css:26`),
a 1 px `border-top` on the bar (`:110`), and `env(safe-area-inset-bottom, 0px)` of padding under it
(`:117`) — a 65 px box plus the inset. The disc clears all three
(`AgentBubble.module.css:142`, asserted at `src/ui/agent-bubble.test.ts:331`).

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
| **Ruling 1** — no Approve/Edit/Skip in the bubble | `src/ui/agent-bubble-thread.test.ts:136` — `:137` the question then the chip, **`:179` none of the three words and no `<button>` anywhere in the thread, and zero `href`s**, `:219` no decide writer in the bubble. In a browser: `e2e/agent-bubble.spec.ts:242` |
| **Ruling 4** — the chip is plain text, not a link | **`src/ui/agent-bubble-thread.test.ts:155`** — the words are present and rendered in a `<span>`, and the thread has no `<a`, no `href=`, no `role="link"`, no `tabindex` and no `<button>`/`<form>`; plus `AgentThread.tsx` (comments stripped) contains none of `next/link`, `FAMILY_TEXTS_FOR_YOU`, `href`, `onClick`, `role=`. `:195` the chip is the one `Pill` (`data-tone="warn"`, `data-pill="true"`, `_pill_`) and `AgentThread.module.css` has no `.chip`, no `--color-warn-*` and no hex left. The one-pill guard that was red on HEAD: `src/ui/pill.test.ts:126`. In a browser: **`e2e/agent-bubble.spec.ts:242`** |
| **Item 1** — the send button is grey until there is something to send | **`src/ui/agent-send-disabled.test.ts`**, 11 of them — `:50` empty → `disabled` + `aria-disabled="true"`; **`:56`** `"   "`, `"\t"`, `"\n"`, `" \n\t  "` → the same; **`:64`** `"hi"` and `"  hi  "` → no `disabled` attribute, `aria-disabled="false"`; `:75` in flight → disabled again; `:82` the field is never disabled, so a person may keep typing; `:92` the predicate itself, five cases; `:100` the button's two attributes are one value and the handler reads it too; **`:120`** no request and no bubble for `""`, `"   "`, `"\n"`, `"\t  "`; `:135` `"hi"` still sends, exactly once; `:154` both colours are tokens and the stylesheet has no hex; `:167` the bar renders no string literal of its own. In a browser: **`e2e/agent-bubble.spec.ts:283`** |
| **Item 2** — one shared sticky-action-bar offset | **`src/ui/sticky-action-bar.test.ts`**, 10 of them — `:48` the `0px` default reaches `:root`; `:58` every reader carries the explicit `0px` fallback; **`:70`** the disc's five-term `bottom` sum; `:76` both page paddings at both widths; **`:98`** neither frame file names a page, and the ramp page names no bubble geometry; `:114` the ramp page declares it on `:root` and **only** under 768; `:126` derived, with no literal `77px` anywhere; `:140` 1 + 8 + 60 + 8 = 77; **`:153`** the disc clears the bar by 17 px at 390×844; `:172` and would have been inside it without the offset. In a browser: **`e2e/agent-bubble.spec.ts:109`** |
| **Ruling 2 (a)** the teal bubble is there before the fetch resolves | `src/ui/agent-ask.test.ts:79` — **`:80`** the exact text in `.outbound` while a `post()` that never settles is in flight, `:96` shown even when the server thread is empty (not the empty line), `:104` still there after a 503 and after a success, `:113` the insert precedes every `await` in `sendAsk` |
| **Ruling 2 (b)** one grey line, whatever went wrong | `src/ui/agent-ask.test.ts:126` — **`:144`** six cases (network error, 503, 500, `ok:false` "unavailable", `ok:false` "skipped" preview, a non-JSON body): ask still present, the line exactly once, under the ask, grey/left, no "AI"; `:160` nothing at all when it was answered; `:167` never twice for one ask; `:174` the right ask of two in flight; `:188` no `console.`, no key, no parsing of the ask |
| **Ruling 2 (c)** the field clears, two asks are two bubbles in order | `src/ui/agent-ask.test.ts:201` — `:202` `setText("")` is in the handler ahead of the `await` and not conditional on the response, `:217` two asks in order, `:228` they sit under whatever the server thread held |
| **Ruling 2** the asks live in the persistent bubble | `src/ui/agent-ask.test.ts:245` — `:246` read as an external store with an empty server snapshot, `:258` nothing persisted and no fetch in the store |
| **Ruling 3** the disc clears the tab bar by 16 | `src/ui/agent-bubble.test.ts:331`. In a browser: `e2e/agent-bubble.spec.ts:84` |
| **(d)** a proposal from the bubble is PENDING and applies nothing | `src/modules/agent/ask/staff-ask.db.test.ts:110` — `:111` one run on a `staff.ask` trigger whose id is the ask's row, **`:132`** the approval request with `decided_at`/`decision` null, the task beside it, and `stateSnapshot()` unchanged, `:174` the ask row, `:186` empty/oversized writes nothing, `:199` a preview writes nothing |
| **(e)** model unavailable → the staff alert, no keyword parser reachable | `src/modules/agent/ask/staff-ask.db.test.ts:215` — `:221` `agentRunner()` refuses by name, `:227` NEEDS_PERSON/RED/OPEN and no run, `:244` no vendor, model, key-shape, endpoint or "AI" on the row or in what the route forwards, `:280` the same alert when the model is reached and fails, **`:310`** walks the ask module's import graph and proves `providers/keyword.ts` and `providers/remote.ts` are not on it |
| **(f)** state survives navigation | `src/ui/agent-bubble.test.ts:239` — `:246` the state lives in the shell that does not remount (external store, not `useState` per page, not the URL), `:256` subscribers, `:268` closed on the server, `:280` remembered across a full load, `:290` a storage that throws |

Plus the mockup's own numbers (`agent-bubble.test.ts:308-394`), the thread's grey/teal sides and
the compact card (`agent-bubble-thread.test.ts:104-177`), and the thread read
(`staff-ask.db.test.ts:350-399`: empty day, ask-then-proposal in order, a decided proposal stops
counting, another site sees nothing, fail-soft).

**Runs.** The full-suite figure below is from commit `e1223f3`, before the ruling commits:
`TZ=America/New_York npx vitest run --maxWorkers=2` — **7140 tests, 7133 passed, 4 skipped, 3
failed**, all three failures pre-existing (see below). **The full suite has not been re-run since**
— this lane forbids it — so that figure does not include the merge of `origin/main` (#82) or the
four commits after it. Each commit was verified with the named files only, in the foreground, as
this lane requires:

```
TZ=America/New_York npx vitest run --maxWorkers=2 \
  src/ui/sticky-action-bar.test.ts src/ui/agent-send-disabled.test.ts \
  src/ui/agent-ask.test.ts src/ui/agent-bubble.test.ts src/ui/agent-bubble-thread.test.ts \
  src/ui/tokens.test.ts src/ui/pill.test.ts src/ui/copy.test.ts src/ui/shell.test.ts \
  src/ui/one-menu.test.ts src/ui/no-hex.test.ts src/ui/no-codes.test.ts \
  src/ui/no-internals.test.ts src/ui/rebuilt-screens.test.ts src/ui/no-fixed-dates.test.ts \
  src/ui/header-slot.test.ts src/app/ramp-ipad/arrival/view.test.ts \
  src/app/ramp-ipad/arrival/lines.test.ts \
  src/modules/agent/no-network.test.ts src/modules/agent/no-hardcoded-models.test.ts
→ 20 files, 2325 passed
```

`npx tsc --noEmit` clean and `npx eslint .` clean at **every** commit on this branch, the merge
commit `7087608` included.

**One guard test went from red to green.** `src/ui/pill.test.ts:126` ("is the only pill in the
repository") was **failing on HEAD before ruling 4's commit**: the 9:17 chip left
`AgentThread.module.css` `.chip` as a second pill-shaped rule under `src/`. Making the chip
`<Pill tone="warn">` deleted that rule, so the test passes and the named-exception list stayed at
exactly one file. Verified as pre-existing by running `pill.test.ts` against `HEAD`'s copy of
`AgentThread.module.css` with everything else at this branch: the same one failure.

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

### E2E — `e2e/agent-bubble.spec.ts` (357 lines)

**Playwright was NOT run** (the lane forbids it). The spec typechecks under `tsc`, which covers
`e2e/`, and uses the repo's existing helpers (`boxOf`, `overlaps`, `shot`,
`expectNoInternalCodes`) and its `E2E_DEMO_ROLE` convention. `/workspace/ppec-b08/playwright-free.flag`
was not created.

It cites `agent-bubble.html` and all four `agent-bubble-*.png` in its header, plus
`family-texts.html` for the compact card, and at **390×844** and **1440×900**:

- `:68` the disc's 56 px box, 16 px off the corner, on Today, Plan routes and Live map at 1440;
- `:84` the disc **16 px** above the tab bar and not overlapping it, on the same three at 390
  (ruling 3: this is the assertion the missing hairline made measure 15);
- **`:109`** (item 2) on `/ramp-ipad` at 390 the disc's box intersects **neither `[data-confirm]`
  nor `[data-confirm-bar]`**, and sits *above* the bar rather than beside it. It skips itself if
  the demo day has no van arrived, because then there is no Confirm to clear;
- `:131` the disc overlaps neither `.maplibregl-ctrl-group` nor `.maplibregl-ctrl-attrib` at either
  width;
- `:160` the 400 px panel under the DEMO bar, no scrim, disc hidden;
- `:178` the full sheet at 390 with a 44 px close X, and close puts the disc back;
- `:203` the title, the compose bar pinned to the foot, no details table, no clock times;
- **`:242`** no `Approve`, `Edit` or `Skip` as a button or a link **anywhere in the panel**, and
  **no link or button carrying "Needs approval" either** — plus, for every proposal card that is
  drawn, the words are in the card and `a, [href], [role='link'], button, [tabindex]` inside it
  counts zero, and no `a[href="…/family-texts?tab=for-you"]` exists in the panel. (The chip is only
  drawn when something is actually waiting, which the demo day decides, so the ruling is asserted
  as the absence of a control rather than the presence of one — a claim that holds either way);
- **`:283`** (item 1) the send disc is `disabled` and `aria-disabled="true"` over an empty field
  and over `"   "`, is enabled over `"hi"`, goes back to grey when the field is emptied again, and
  **paints a different `background-color` when disabled than when live**; Enter on a
  whitespace-only field fires **no POST**, watched with `page.route` rather than inferred;
- `:323` the panel stays open across a navigation between tabs;
- `:339` no bubble on Family texts → For you; `:349` none anywhere for a role that may not decide.

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
5. **If #75 pins anything to the floor of For you**, it should declare
   `--sticky-action-bar-height` on the document root rather than pad around the disc — the contract
   is on this branch and is deliberately not a list of pages (`src/ui/tokens.ts`
   `stickyActionBar`). Nothing about the property is approvals-specific, so the two should not
   conflict.

Nothing in any of the above was read from `team/ppe-rework-approvals`. **#82 was merged** (operator
line: YES, `fd818d9`, confirmed an ancestor of `origin/main` before merging), with no conflicts.

---

## Existing assertions changed, with reasons

None is a loosening; each carries its reason in the source beside it.

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

3. **`src/ui/agent-bubble.test.ts:331`** — "sits 16 px above the tab bar…" now asserts a sum of
   **five** named lengths where it asserted four, the new one being
   `var(--sticky-action-bar-height, 0px)`. Every length named before is still named by name; this
   is an addition to the sum, never a substitution, so the assertion is strictly stronger.
4. **`src/ui/agent-bubble.test.ts:367`** — "pads the page clear of the disc at both widths" now
   asserts `calc(<clearance token> + var(--sticky-action-bar-height, 0px))` in all three rules
   rather than the bare clearance token. Same argument: both clearance tokens are still asserted by
   name.
5. **`src/ui/agent-bubble-thread.test.ts`'s chip tests** were rewritten for ruling 4, and the
   reason is in the commit body and beside them in the file. The one that mattered asserted the
   card carried **exactly one `href`** — a narrower claim about the markup and a weaker one about
   the behaviour than "no anchor, no `href`, no `role=link`, nothing focusable, anywhere in the
   thread, and no link machinery left in the component to re-grow one from". `e2e/agent-bubble.spec
   .ts:242` changed the same way: it checked the `href` of whatever chips were drawn, and now
   asserts the absence of a control carrying those words — true whether a chip is drawn or not.

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
- **the send button is grey until something is typed**, so there is no way to send an empty ask
  by accident, and Enter on an empty box does nothing at all;
- **on a Vercel preview, an ask writes nothing at all** (`previewSkip`) and the panel shows the
  same two bubbles: the teal ask, and the grey line under it;
- **on the ramp iPad at 390 the disc sits above the pinned Confirm bar**, 17 px clear of it, so
  the one button that screen exists for is never under it;
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
- **The send button's grey is the system's, not the mockup's.** `mockups/agent-bubble.html` draws
  `.snd` teal at all times — it has no empty state — so item 1's disabled look is §4.2's
  `disabled-bg` / `disabled-fg` pair rather than something measured off the mockup. A deliberate
  addition to it, not a match of it.
- **`/ramp-ipad` at 390 now has a tall stack of bottom whitespace**: the shell's 80 px bubble
  clearance, plus the 77 px the page declares for its pinned Confirm, plus the page's own
  `padding-bottom` for that bar. Each layer clears what its owner is responsible for; collapsing
  them would mean the frame knowing which pages pin bars, which is what item 2 replaces. #82's own
  `padding-bottom` was not touched.

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
5. **`--sticky-action-bar-height` has exactly one declarer today.** The ramp iPad's arrival page is
   the only screen that pins a bottom action bar, so the contract is proved by one caller. The two
   places that would naturally be next are Today's drawer footer (`today.module.css` already notes
   "room under the sticky drawer footer at narrow widths" and solves it with its own padding) and
   anything #75 pins on For you. Neither was in this lane; both should declare the property rather
   than pad around it, and `sticky-action-bar.test.ts:98` is what will catch a frame-side special
   case if somebody reaches for one instead.
6. **The `:global(:root)` declaration is route-scoped by Next, not by a guard.** The ramp page's
   stylesheet is only linked while that route is rendered, which is what makes a document-root
   declaration safe here. If a future page imports `arrival.module.css` from somewhere else, the
   77 px would follow it. A `data-*` attribute on the shell would be the sturdier shape; it needs
   the frame to read a page's attribute, which is a shell change this lane did not have room for.

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
push; no `gh`. `origin/main` was brought in with `git merge --no-edit origin/main` and nothing
else. Nothing read from `team/ppe-rework-approvals`. Playwright not run;
`/workspace/ppec-b08/playwright-free.flag` not created. Every string in `src/ui/copy.ts`, every
colour from `src/ui/tokens.ts`, violet still the DEMO bar's alone, no "AI" label and no vendor or
model name anywhere on a screen.
