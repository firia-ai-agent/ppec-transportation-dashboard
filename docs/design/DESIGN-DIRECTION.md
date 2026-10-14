# PPEC transportation dashboard: design direction

```
READER: Rudy (build), Veri (verify), founder (decisions D-1 to D-9, §11). DECISION IT SERVES: what the UI looks and behaves like before any UI code is written.
STATUS: Decided, nothing pending: D-1 to D-9 (founder, 2026-10-14 11:39 ET); banner text "DEMO" incl. screen-reader label (founder, 13:18 ET; override of PRD l.1332 confirmed 13:30 ET, ledger row 40); D-10 (founder, 13:15 ET). See §11. The rest of this doc (layouts, references, checklist) is Vera's design direction, not a founder decision.
SOURCE: PRD v1.0 §14 (SURF-01..07), NFR-07 (WCAG 2.1 AA), NFR-09 (DEMO/LIVE banner), MOCKS-AND-DEMO.md, schema-draft.ts enums, ADR-008/014/015.
COMPANION: COPY-GUIDE.md (words), contrast.py (token ratios; run it, don't trust this table).
```

## 0. Linear coverage (label `vera-taste`)
| Issue | Covered in |
|---|---|
| PPE-6 Epic: UI (B-12, B-13) | whole doc; §9 acceptance checklist is the epic's taste gate |
| PPE-21 B-12 Console (board, drawer, inbox, exceptions, map) + SSE | §4.1 SURF-01, §4.2 SURF-02, §4.3 SURF-03, §4.5 SURF-05, §5 map, §2 header/SSE banner |
| PPE-22 B-13 Ramp iPad, dispatcher form, setup + vehicle config | §4.4 SURF-04, §4.8 dispatcher form + setup |
| PPE-17 B-04 Messaging SIM + persona phones | §6.3 persona phones, COPY-GUIDE §5 SURF-03 / outbound |
| PPE-16 B-06 Teams mock panel, cards, 409 race | §6.4 Teams panel, §4.5 "already decided" |

## 1. Design Read
```
DESIGN READ: coordinators/director (desktop ≥1280, sometimes iPad), ramp staff (iPad 1024×768 and 820×1180, gloves/standing, outdoors),
provider dispatchers (phone 390, signed link) doing "know where every child is, what they need, and what is wrong right now".
Surface class: app-dense (board, exceptions), app-pipeline/inbox (SURF-03), app-form big-tap (SURF-04, dispatcher link), ops-health (SURF-06/07).
Dials: VARIANCE 2-3 / MOTION 2 / DENSITY 7 on console; DENSITY 3 on ramp iPad (reason: safety-critical, calm, glanceable; no decoration).
Success = a coordinator spots the one child at risk in under 5 s without reading colour; ramp staff confirm a boarding in ≤2 taps.
```
| Persona (role enum) | Job line | Surfaces | Widths walked |
|---|---|---|---|
| Coordinator (COORDINATOR) | needs to see every child's leg state and fix exceptions so no child is stranded or unexpected | SURF-01/02/03/05 | 1280, 1440, iPad 1024 landscape |
| Director (DIRECTOR) | needs to approve plan changes and run the demo so decisions are owned and the demo is repeatable | SURF-05, 06, 07, demo panel | 1280, 1440 |
| Ramp staff (FRONT_DESK) | needs to verify vehicle capability and confirm boarding so each child rides safely | SURF-04 | iPad 1024×768 landscape, 820×1180 portrait |
| Provider dispatcher (link, no login) | needs to report vehicle seats/lift so the center knows the vehicle fits | /p/verify/{token} | 390×844, 1280 |

## 2. Global shell
- **Header (persistent, every surface):** DEMO banner (§7) → site, date, scenario clock, per-adapter freshness pills (SMS, Teams, GPS, Agent: icon + label + age). **Interim, approved by Vera (design lead) 2026-10-14 13:25 ET as an interim build default; not a founder decision: until B-12 wires real ages, each pill reads "<adapter> · Simulated" with `flask-conical` in src-sim tone (7.10:1), matching the D-10 source badge. It must switch to real ages when B-12 lands (§10).**, global search (child first name/initial, route, vehicle). One identity location: avatar menu top-right only.
- **Nav (PRD §14):** Today (board + drawer + inbox) · Exceptions & Approvals (count badge) · Setup · Health & ROI. Ramp iPad is its own full-screen route. ≥1280: left rail 232 px; 768-1279: 64 px icon rail; each item has a tooltip and an aria-label with its name, and the rail expands to show labels on hover or keyboard focus; <768: hamburger drawer holding nav + identity + Sign out.
- **Nav icons:** Claude Code picks them when building, with two rules: no nav icon may reuse any §3 state icon, and `flask-conical` is reserved for the Simulated source badge. The chosen icons come back to Vera for a design check before merge.
- **SSE down >15 s:** amber bar under the header, icon `wifi-off` + "Live updates paused. Reconnecting… Board may be up to 40 s old." Never hide data; dim the "updated" timestamps.
- **Source-mode badge** on every row, record and outbound message (NFR-09): spec in §7.1 (D-10, decided by founder). The screen-level Simulated badge appears on every screen, including sign-in: in the app header once signed in, and on the sign-in page directly under the DEMO banner, next to the card title (NFR-09, PRD l.537–538).
- Icons: Lucide (single set, 1.75 stroke). No emoji anywhere, including freshness (the PRD's 🟢🟡🔴 become icon + label chips, §3).
- Type: **Atkinson Hyperlegible Next** for UI and numerals (designed for low-vision legibility; fits the center's mission), tabular figures for times/ETAs; **JetBrains Mono** only for ids. Scale 12/14/16/20/24/32; body 14 console, 18 ramp iPad. Min 12 px only for chips with icon.

## 3. State vocabulary (icon + label always; colour is the third cue, never the only one)
Tone tokens map to the hexes in §8. Icons are Lucide names.
| Domain state (enum) | Icon | Label (UI) | Tone token | fg / bg (ratio) |
|---|---|---|---|---|
| leg SCHEDULED | `calendar-clock` | Scheduled | neutral | #334155 / #E2E8F0 (8.40) |
| PROVISIONAL_ASSIGNED | `circle-dashed` | Provisional | neutral | 8.40 |
| CAPABILITY_PENDING | `circle-question-mark` | Vehicle check pending | warn | #854D0E / #FEF9C3 (6.38) |
| CAPABILITY_REPORTED | `message-square-check` | Reported by provider | info | #1E40AF / #DBEAFE (7.15) |
| CAPABILITY_VERIFIED | `shield-check` | Vehicle verified | ok | #166534 / #DCFCE7 (6.49) |
| MANIFEST_LOCKED | `lock` | Manifest locked | info | 7.15 |
| EN_ROUTE_PICKUP | `navigation` | On the way to pickup | info | 7.15 |
| ARRIVED_PICKUP | `map-pin` | At pickup (vehicle) | info | 7.15 |
| BOARDED_REPORTED | `user-check` | Boarded (reported) | info | 7.15 |
| BOARDED_VERIFIED | `badge-check` | Boarded, verified | ok | 6.49 |
| IN_TRANSIT | `truck` | In transit | info | 7.15 |
| ARRIVED_DROPOFF | `map-pin-check` | Arrived (vehicle) | info | 7.15 — never "Handed off" (PRD SURF-01) |
| COMPLETED_HANDOFF | `hand-heart` | Handed off to {receiver role} | ok | 6.49 |
| CANCELED_TRANSPORT | `circle-slash` | Ride canceled | neutral | 8.40 |
| CANCELED_ATTENDANCE | `calendar-x` | Not attending today | neutral | 8.40 |
| NO_SHOW | `user-x` | Not at pickup | crit | #991B1B / #FEE2E2 (6.80) |
| HELD_NO_RECEIVER | `hand` | Held: no adult to receive | crit | 6.80 |
| LEFT_BEHIND_CAPACITY | `triangle-alert` | Waiting: vehicle full | crit | 6.80 |
| EXCEPTION | `octagon-alert` | Needs action | crit | 6.80 |
| attendance AM_SELF_DROP | `car` | Family drop-off | neutral | 8.40 |
| EXPECTED_LATE / CHECKED_IN / EARLY_DEPARTURE / CHECKED_OUT / ABSENT_FULL_DAY | `clock-alert` / `log-in` / `log-out` / `door-open` / `calendar-x` | Running late / Checked in / Left early / Checked out / Absent today | warn / ok / warn / neutral / neutral | as above |
| capability UNKNOWN / REQUESTED / CHANGED / REJECTED / UNAVAILABLE / VERIFIED_INFEASIBLE | `circle-question-mark` / `send` / `refresh-cw` / `circle-x` / `ban` / `shield-x` | Unknown until arrival / Asked provider / Changed / Rejected / Vehicle unavailable / Verified: won't fit | warn / info / warn / crit / crit / crit | as above |
| reservation FEASIBLE / INFEASIBLE / NEEDS_REVIEW | `check` / `octagon-x` / `eye` | Fits / Doesn't fit / Needs review | ok / crit / warn | as above |
| attendance SCHEDULED | `calendar-clock` | Expected today | neutral | #334155 / #E2E8F0 (8.40) |
| capability REPORTED | `message-square-check` | Reported by provider | info | #1E40AF / #DBEAFE (7.15) |
| capability VERIFIED | `shield-check` | Checked at the ramp | ok | #166534 / #DCFCE7 (6.49) |
| reservation PROVISIONAL | `circle-dashed` | Seat held (not checked) | neutral | #334155 / #E2E8F0 (8.40) |
| reservation COMMITTED | `lock` | Seat confirmed | ok | #166534 / #DCFCE7 (6.49) |
| reservation RELEASED | `lock-open` | Seat released | neutral | #334155 / #E2E8F0 (8.40) |
| outbound DRAFTED | `file-pen` | Draft | neutral | #334155 / #E2E8F0 (8.40) |
| outbound POLICY_CHECKED | `list-checks` | Checked, ready to queue | neutral | #334155 / #E2E8F0 (8.40) |
| outbound SENDING | `send-horizontal` | Sending | info | #1E40AF / #DBEAFE (7.15) |
| outbound UNKNOWN | `circle-question-mark` | Delivery unknown | warn | #854D0E / #FEF9C3 (6.38) |
| outbound REDACTED | `eye-off` | Text removed (privacy) | neutral | #334155 / #E2E8F0 (8.40) |
| outbound CANCELED_STALE | `calendar-off` | Not sent (out of date) | neutral | #334155 / #E2E8F0 (8.40) |
| thread CLOSED | `archive` | Closed (quiet 24 h) | neutral | #334155 / #E2E8F0 (8.40) |
| ack PENDING / ACKNOWLEDGED / DECLINED / EXPIRED_ESCALATED / SUPERSEDED | `hourglass` / `check-check` / `circle-x` / `shield-alert` / `rotate-ccw-clock` | Waiting for reply / Acknowledged / Declined / No reply, escalated / Replaced by newer request | warn / ok / crit / crit / neutral | as above |
| task (exception) OPEN / IN_PROGRESS / RESOLVED_APPROVED / RESOLVED_OVERRIDE / CLOSED_VERIFIED / SNOOZED | `octagon-alert` / `loader` / `circle-check` / `hand` / `badge-check` / `circle-pause` | Open / Being handled by {name} / Resolved: approved / Resolved: staff override / Closed, checked / Snoozed until {time} | crit / info / ok / warn / ok / neutral | as above (`loader` never spins under reduced motion) |
| transport profile DRAFT / APPROVED / SUPERSEDED | `file-pen` / `badge-check` / `rotate-ccw-clock` | Draft, not used for rides / Approved v{n} / Older version | neutral / ok / neutral | as above |
| need item UNKNOWN / REPORTED / VERIFIED / APPROVED | `circle-question-mark` / `message-square-check` / `shield-check` / `badge-check` | Not known yet / Reported / Checked / Approved (used for seating) | warn / info / ok / ok | as above; unapproved items greyed "not used for allocation" (PRD VEH-01) |
| therapy session SCHEDULED / IMPACTED / THERAPIST_NOTIFIED / CANCELED | `calendar-clock` / `triangle-alert` / `send` / `calendar-x` | Therapy scheduled / Therapy affected / Therapist told / Therapy canceled | neutral / warn / info / neutral | as above |
| agent run QUEUED / RUNNING / WAITING_TOOL / SUCCEEDED / FAILED / ABORTED_SUPERSEDED_BY_HUMAN | `clock` / `bot` / `hourglass` / `circle-check` / `circle-x` / `user-round` | Agent queued / Agent working / Agent waiting / Agent done / Agent failed / Staff took over | neutral / info / neutral / ok / crit / neutral | as above (Inbox + Health only) |
| job (timer) SCHEDULED / CLAIMED / DONE / CANCELED / FAILED / DEAD | `clock` / `loader` / `check` / `circle-slash` / `circle-x` / `octagon-x` | Scheduled / Running / Done / Canceled / Failed, retrying / Failed, needs a person | neutral / info / ok / neutral / warn / crit | as above (Health / demo fire log only) |
| GPS fresh (<60 s) | `locate-fixed` | Live · {age} (e.g. Live · 12 s) | ok | 6.49 |
| GPS aging (60–179 s) | `locate` | Last seen {age} | neutral | 8.40 |
| GPS STALE (180–599 s) | `clock-alert` | Stale · {age} · ETA texts paused | warn | 6.38 |
| GPS lost (≥600 s) | `locate-off` | No signal · {age} | crit | 6.80 |
| outbound QUEUED / SENT / DELIVERED / UNDELIVERED / FAILED / BLOCKED_EGRESS | `clock` / `send` / `check-check` / `circle-alert` / `circle-x` / `shield-ban` | Queued / Sent / Delivered / Not delivered / Failed / Blocked (opted out or policy) | neutral / info / ok / warn / crit / crit | as above |
| severity GREEN / AMBER / RED | `circle-check` / `triangle-alert` / `octagon-alert` | Low / Medium / Urgent | ok / warn / crit | as above |
| thread OPEN / PAUSED_HUMAN | `bot` / `user-round` | Agent handling / Staff: {first name} | info / neutral | as above |
Icons: every name above is a canonical (non-alias) icon verified in lucide-static 1.57.0 (`icons/<name>.svg` returns HTTP 200, checked 2026-10-14). "No signal" uses the single icon `locate-off` (GPS crosshair struck through). It reads as lost location, and it doesn't collide with `wifi-off` (live-updates bar) or `cloud-off` (iPad offline). Rejected: `satellite-dish` plus a custom slash (overlay), `signal-zero` (reads as phone signal), `wifi-off` (collides), `map-pin-off` (reads as "no stop"). All tones reuse the §8 pairs, so there are no new colour pairs.
GPS `{age}` is human-formatted: under 60 s as "12 s", then minutes "4 min", then hours and minutes "1 h 5 min". Never show raw seconds over 60 (no "245 s").
Note: PRD freshness bands (<60 / 60–600 / >600 s) and the STALE badge at 180 s (MOCKS §5, PRD l.456) disagree; this table uses four bands to honour both. Decided: D-2 (four bands).

## 4. Surfaces
### 4.1 SURF-01 Board (Today)
- **References:** Samsara Fleet Overview (list + map split, freshness on each asset), Onfleet Dispatcher (task list grouped by state with driver panel), Linear list view (dense rows, keyboard j/k, no truncation, grouping).
- **Patterns taken:** split pane (rows left 60%, map right 40%, collapsible); group-by (Needs action → In progress → Done) with sticky group headers; row hover syncs map marker highlight; `j/k`, `Enter` opens drawer, `/` search.
- **Row (48 px min, 2 lines max):** child label (first name + last initial, e.g. "Mia R.", synthetic) · AM/PM leg chip · leg state chip · provider/vehicle + capability chip · GPS freshness chip · ETA window "8:12–8:22" + delta "+6 min" (warn tone, `arrow-up-right`) · receiver/therapy · next-action owner avatar+name · source-mode chip. Columns hide in this order below 1280: receiver → owner → source chip moves into the drawer.
- **Filters:** state groups, provider, vehicle, AM/PM, "Only needs action" toggle. Counts in every filter.
- **States:** loading = skeleton rows (8) with the header live; empty = "No rides scheduled for {date}. Change the date or reset the demo." ; error = inline banner with Retry, keep last good data dimmed with its timestamp; 412 conflict = toast "Someone else changed this ride. Review the merge." opening a diff.
- **iPad landscape:** map collapses to a toggle; rows keep 48 px, tap targets 44+. **Phone:** list only, map as a full-screen tab; drawer becomes a sheet.

### 4.2 SURF-02 Trip / child drawer
- **References:** Linear issue side peek (overlay, keeps list context, history inline), Stripe Dashboard payment detail (timeline of events with actor + time), Zendesk user sidebar (profile facts at top).
- **Layout:** 480 px right drawer (full-screen sheet <768). Sections in order: Today's legs (AM/PM cards with state + ETA) → Approved needs (version, approver, "Derived from intake, not a diagnosis." caption; unapproved items greyed with `circle-dashed` "Not approved yet") → Vehicle capability evidence ("Verified 17 min ago by J.T.") → Receiver readiness → Pending approvals → Agent changes → History (collapsed; each entry actor · reason · when; "Show diff").
- **Primary action (one, sticky footer):** "Confirm handoff". Disabled while IN_TRANSIT without ramp verification; disabled state shows the reason inline, not a tooltip only, plus "Override with reason" secondary.
- **States:** loading skeleton per section; unknown capability = warn chip "Unknown until arrival" (this is the normal morning state, not an error).

### 4.3 SURF-03 Inbox
- **References:** Front shared inbox (assign / take over, conversation + context side panel), Linear Inbox (triage list, keyboard, unread dots + labels), Intercom (bot vs human handoff badges).
- **Layout:** 3 columns ≥1280 (threads 320 / conversation / context 320); 2 columns iPad; list-or-thread with Back on phone.
- **Each message card:** sender + resolved identity + confidence ("Matched to F4 · high" / "Unknown number" warn), linked child chips, extracted change ("Absent today: Mia R., AM+PM"), resulting action link, delivery status chip, author badge "Agent (auto)" vs "Staff (Dana)".
- **Header actions:** "Take over" / "Release to agent" (one visible at a time). Composer banner when the plan version changed since the thread's last read: "The plan changed at 8:04. Check before you reply."
- **States:** empty = "No messages yet today."; agent down = triage banner "Agent paused. Keyword replies only (ABSENT, SICK, YES, READY, STOP)."

### 4.4 SURF-04 Ramp iPad
- **References:** Uber Driver app (one huge primary action, high-contrast, glanceable at arm's length), Onfleet Driver (stop checklist, proof-of-completion), Square POS (big tiles, offline queue badge).
- **Layout:** landscape 1024×768 primary; portrait supported. Top: DEMO banner + arriving-vehicle selector (large segmented tiles: vehicle name, provider, ETA, children count). Left: capability checklist (lift, WC positions, securement types, ambulatory seats, LATCH) as 64 px toggle rows with Yes / No / Not sure. Right: slot allocation matrix (seats as tiles; drag or tap-to-assign, never drag-only). Bottom sticky feasibility banner: ok "Fits: 1 wheelchair, 1 walking seat" / crit "Doesn't fit: 2 wheelchairs needed, 1 position". Per-child cards: "Confirm boarding & securement" (primary), "Not on vehicle", "Left early (who picked up)".
- **Targets ≥56 px** (exceeds 44), 16 px gap, body 18 px. No hover-only anything. Confirmation is a 2-step "Confirm" → 3 s undo snackbar, not a modal.
- **Offline:** persistent pill `cloud-off` "Offline · 3 saved on this iPad" ; each queued action shows local time; on sync, late items get "Recorded late" chip.

### 4.5 SURF-05 Exceptions & approvals
- **References:** PagerDuty incident list (severity, age, owner, acknowledge/resolve), Opsgenie (SLA countdown, snooze with reason), GitHub PR review (structured diff + approve/reject).
- **Layout:** table ≥1280 (severity · type · child/leg · age · owner · SLA countdown · proposed resolution · agent attempts); detail pane right. iPad: list + sheet.
- **Proposed resolution** renders as a diff ("C8: Route 2 → Center van (+6 min)") with Approve (primary) / Reject / Reassign / Snooze… / Convert to manual. Snooze and Reject require a reason.
- **Race (409, AT-18):** loser sees an info-tone card "Already decided by Dana at 9:41: approved." Buttons disappear; no error tone.
- **SLA countdown** text "Due in 4:12" (tabular); at <2 min warn tone + icon; overdue crit "Overdue 1:05". Countdown never animates per-second for screen readers (aria-live off; announce at thresholds only).

### 4.6 SURF-06 Health & replay / SURF-07 ROI
- **References:** Vercel / Statuspage component status (mode + last success + incidents), Datadog service tiles; Amplitude cohort charts for ROI.
- Health: one row per adapter: mode chip, last event, last success, error rate, queue depth, breaker state (Closed / Open / Half-open with icons), degraded instruction in plain words. ROI: baseline vs current, n, confidence note; a diagonal "SYNTHETIC" watermark on every chart; cohorts never on one axis.

### 4.7 Demo panel (DIRECTOR, `DEMO_MODE=1`)
See §6.

### 4.8 Dispatcher link form + Setup (PPE-22)
- Dispatcher form (phone first, 390): Typeform-style one-question-per-section with steppers (WC positions 0–4, seats 0–8), lift Yes/No tiles, Submit. Expired link page: "This link has expired. Call the center at {number}." References: Typeform, Onfleet driver forms.
- Vehicle config: layout cards ({1WC/3A}) with a seat diagram, edit in sheet; "Unknown until arrival" is the default chip each day.

## 5. Map and trucks (must feel real)
- **Style:** see §5.1. Center pin = building icon "PPEC center". Stops = landmark name labels (public places only, MOCKS §1).

### 5.1 Map styling (MapLibre GL + OpenFreeMap)
- **Styles checked** at `https://tiles.openfreemap.org/styles/<name>` on 2026-10-14: `positron`, `liberty`, `bright`, `dark`, `fiord` all exist (HTTP 200). Note: ADR-008 (Proposed) still says OSM raster tiles; the build stack is OpenFreeMap vector tiles, so ADR-008 should be updated by its owner.
- **Base style: `positron`.** It is the quiet, near-monochrome style, so trucks, routes and state chips carry all the colour. `liberty`/`bright` are full-colour (green parks, yellow roads) and would compete with state tones; `dark`/`fiord` hurt daytime ramp/iPad legibility.
- **Overrides** (apply with `map.setPaintProperty` after `style.load`, or patch the fetched style JSON; keep layer ids):
  | Layer | Positron default | Override | Why |
  |---|---|---|---|
  | `background` | `#F2F3F0` | keep | muted land |
  | `park`, `landcover_wood`, `landuse_residential` | `#E6E9E5`, `#DCE0DC`, `#EAEAE6` | keep | already muted |
  | `water` | `#C2C8CA` | **`#D9E2E7`** | the default fails 3:1 for ok/stale trucks (2.96:1, 2.91:1); lighter water passes |
  | `highway_*` casings/inner | greys | keep; motorway inner opacity 0.8 | roads stay below route lines |
  | `label_*`, `highway-name-*` | dark grey text | `text-color #475569` (ink-muted), halo `#FFFFFF` 1.5 px | AA-tone labels, calmer than black |
  | `building` | grey | hide below zoom 15 | reduces noise at fleet zoom |
  | POI / `airport` | icons | hide, except our own landmark stop layer | no competing pins |
- **Our layers (on top, in order):** route planned (line 4 px `route #1D4ED8` at 0.6 opacity), route driven (solid `#1D4ED8`), stops (white circle, 2 px `ink #0F172A` ring, landmark label), center pin (`ink #0F172A`), trucks (36 px glyph in the state tone `map-truck-ok #15803D` / `map-truck-stale #A16207` / `map-truck-crit #B91C1C`, 2 px white halo, state icon badge). **Violet `#6D28D9` never appears on the map**; it stays reserved for the DEMO banner and the Simulated badge.
- **Contrast (non-text, 3:1):** every truck tone, the route line and the center pin are checked against every positron fill (background, park, residential, wood, road casing, overridden water) and against the white halo. All pass; the lowest is stale truck on road casing at 3.35:1. Run `python3 docs/design/contrast.py`.
- **Attribution:** "© OpenFreeMap © OpenStreetMap contributors" stays visible at all times, bottom-right, using MapLibre's compact attribution control (collapsible "i" that can be expanded, never removed). Drawers, the demo panel and sheets must inset the map (map container shrinks) or offset the control, never cover it. Checklist line in §10.
- **Camera:** "Fit all vehicles" and row selection use `flyTo` with ≤600 ms; under `prefers-reduced-motion` use `jumpTo` (no animated camera at all).
- **Markers:** 36 px top-down van glyph rotated to heading, white 2 px halo (keeps ≥3:1 against any tile), state badge (icon) on the corner, vehicle label "V1" beside. Freshness via icon badge + label on hover/focus, plus ring style: solid (live), dashed (stale), hollow with slash (no signal). Never colour alone.
- **Motion:** interpolate between 5 s sim points with linear tween along route geometry (not straight lines), ease on stop/start; heading smooths over 300 ms. Stall = marker stops, a pulsing ring (disabled under reduced motion) and a clock label "Stopped 3 min". Jitter fault: marker wobbles ±40 m but ETA text does not change (visible proof of suppression).
- **Route lines:** planned route 4 px brand at 60%, driven portion solid; selected vehicle raises z-order, others dim to 40%.
- **Cluster/fit:** "Fit all vehicles" button; selecting a row flies (≤600 ms, instant under reduced motion).

## 6. Demo controls (polished, honest)
### 6.1 Panel UX
- References: Stripe test-mode clock (test clocks), Chrome DevTools sensors/throttling panel, LaunchDarkly targeting toggles.
- A right-side dock "Demo controls" (DIRECTOR only), collapsible to a 48 px tab, never covering the DEMO banner. Sections: **Scenario** (Reset & seed with confirm dialog showing what is wiped and what is kept), **Clock** (big time readout 06:00, Play/Pause, ×1/×10/×60, Jump to… with presets "T−90 capability", "17:30 close"), **Replay** (pick run, ×1/×5/×20, scrubber), **Faults** (pick target vehicle/persona, then fault tiles: Stall, Traffic ×1.5, GPS gap, Jitter, Duplicate points, Unbound device, SMS fail/delay/duplicate/out-of-order), **Drills** (Restart drill with live fire log), **Evidence** (Export zip + progress).
- **Active faults** list with Clear per fault and "Clear all". Every injected fault writes a timeline entry with `SIMULATED` chip, visible on the affected row.
- **12-step script rail:** optional checklist of PRD §18.2 steps with "Run step" shortcuts and done ticks; this is the polish that makes the founder demo repeatable.
### 6.2 Timing
SMS delivery 1–3 s (seeded), SSE board update target <2 s with a subtle 1 s row highlight (no flash under reduced motion), clock jumps re-arm jobs then toast "Clock moved to 07:30. 4 timers re-armed."
### 6.3 Persona phones
iPhone-shaped panels (no Apple marks), F1–F8 tabs, family label "F4 · 555-0104", status ticks Queued → Sent → Delivered under bubbles, typing posts through the real webhook path. Each phone shows both banners: the DEMO banner on top ("DEMO", D-1 superseded by ledger row 40; it goes everywhere) and the "Simulated phone" banner directly under it.
### 6.4 Teams panel
Teams-like (not Teams-branded) side panel with adaptive-card-style approval cards; two-session race shows the "Already decided" state identically to SURF-05.

## 7. DEMO banner (NFR-09)
- 32 px full-width bar above everything, `demo-bg #6D28D9` / white text (7.10:1), icon `flask-conical`, text exactly "DEMO" (D-1 as superseded by ledger row 40; COPY-GUIDE §6). Screen reader: aria-label "DEMO". Not dismissible. Violet is reserved for demo only, so it never reads as a status colour. Printed/exported files and every outbound simulated message carry the same marker. In LIVE (future) the bar becomes a slim neutral "LIVE" chip; the demo violet must never appear in LIVE.

### 7.1 Source-mode badge (D-10, Decided by founder, 2026-10-14 13:15 ET)
NFR-09 (PRD l.537–538) requires a source-mode badge on every screen, record and outbound message but leaves its form open. Decided form: an **outlined** chip (1 px `border-strong`, white fill, 12 px text + 14 px icon, height 20 px; 24 px on ramp iPad) so it never reads as a filled state chip. Screen reader: "Source: Simulated".
| source_mode | Icon (Lucide) | Label | Text token | Contrast (contrast.py) |
|---|---|---|---|---|
| SIMULATED | `flask-conical` | Simulated | src-sim `#6D28D9` on surface | 7.10:1 |
| REPLAY | `rotate-ccw-clock` | Replay | ink-muted `#475569` on surface | 7.58:1 |
| MANUAL | `hand` | Manual entry | ink-muted | 7.58:1 |
| SANDBOX | `box` | Sandbox | ink-muted | 7.58:1 |
| LIVE | `radio-tower` | Live | ink `#0F172A` on surface | 17.85:1 (never violet) |
Placement: screen = header next to the DEMO banner (sign-in: next to the card title, under the banner); record = board row end, drawer header, exception row, inbox message card, history entries; outbound message = under each bubble in inbox and persona phones, plus the "[DEMO]" text suffix (COPY-GUIDE §5) in the message body.

## 8. Tokens and computed contrast
Computed by `python3 docs/design/contrast.py` (WCAG 2.1 relative luminance; exits non-zero on any FAIL). Text needs 4.5:1, UI parts/focus 3:1.
| Foreground | Background | Ratio | Needs | Result |
|---|---|---|---|---|
| ink `#0F172A` | bg `#F8FAFC` | 17.06:1 | 4.5:1 | PASS |
| ink `#0F172A` | surface `#FFFFFF` | 17.85:1 | 4.5:1 | PASS |
| ink-muted `#475569` | surface `#FFFFFF` | 7.58:1 | 4.5:1 | PASS |
| ink-muted `#475569` | bg `#F8FAFC` | 7.24:1 | 4.5:1 | PASS |
| border-strong `#64748B` | surface `#FFFFFF` | 4.76:1 | 3:1 | PASS |
| brand `#1D4ED8` | surface `#FFFFFF` | 6.70:1 | 4.5:1 | PASS |
| surface `#FFFFFF` | brand `#1D4ED8` | 6.70:1 | 4.5:1 | PASS |
| focus `#1D4ED8` | surface `#FFFFFF` | 6.70:1 | 3:1 | PASS |
| focus `#1D4ED8` | bg `#F8FAFC` | 6.41:1 | 3:1 | PASS |
| ok-fg `#166534` | ok-bg `#DCFCE7` | 6.49:1 | 4.5:1 | PASS |
| info-fg `#1E40AF` | info-bg `#DBEAFE` | 7.15:1 | 4.5:1 | PASS |
| warn-fg `#854D0E` | warn-bg `#FEF9C3` | 6.38:1 | 4.5:1 | PASS |
| crit-fg `#991B1B` | crit-bg `#FEE2E2` | 6.80:1 | 4.5:1 | PASS |
| neutral-fg `#334155` | neutral-bg `#E2E8F0` | 8.40:1 | 4.5:1 | PASS |
| demo-fg `#FFFFFF` | demo-bg `#6D28D9` | 7.10:1 | 4.5:1 | PASS |
| ok-fg `#166534` | surface `#FFFFFF` | 7.13:1 | 4.5:1 | PASS |
| warn-fg `#854D0E` | surface `#FFFFFF` | 6.85:1 | 4.5:1 | PASS |
| crit-fg `#991B1B` | surface `#FFFFFF` | 8.31:1 | 4.5:1 | PASS |
| src-sim `#6D28D9` | surface `#FFFFFF` | 7.10:1 | 4.5:1 | PASS |
| src-sim `#6D28D9` | bg `#F8FAFC` | 6.79:1 | 4.5:1 | PASS |
| ink-muted `#475569` | surface `#FFFFFF` | 7.58:1 | 4.5:1 | PASS |
| ink `#0F172A` | surface `#FFFFFF` | 17.85:1 | 4.5:1 | PASS |
| border-strong `#64748B` | bg `#F8FAFC` | 4.55:1 | 3:1 | PASS |
| map-truck-ok `#15803D` | surface `#FFFFFF` | 5.02:1 | 3:1 | PASS |
| map-truck-stale `#A16207` | surface `#FFFFFF` | 4.92:1 | 3:1 | PASS |
| map-truck-crit `#B91C1C` | surface `#FFFFFF` | 6.47:1 | 3:1 | PASS |
| map-truck-ok `#15803D` | osm-bg `#F2F3F0` | 4.50:1 | 3:1 | PASS |
| map-truck-ok `#15803D` | osm-park `#E6E9E5` | 4.10:1 | 3:1 | PASS |
| map-truck-ok `#15803D` | osm-resid `#EAEAE6` | 4.16:1 | 3:1 | PASS |
| map-truck-ok `#15803D` | osm-wood `#DCE0DC` | 3.76:1 | 3:1 | PASS |
| map-truck-ok `#15803D` | osm-road `#D5D5D5` | 3.42:1 | 3:1 | PASS |
| map-truck-ok `#15803D` | osm-water `#D9E2E7` | 3.82:1 | 3:1 | PASS |
| map-truck-stale `#A16207` | osm-bg `#F2F3F0` | 4.42:1 | 3:1 | PASS |
| map-truck-stale `#A16207` | osm-park `#E6E9E5` | 4.02:1 | 3:1 | PASS |
| map-truck-stale `#A16207` | osm-resid `#EAEAE6` | 4.08:1 | 3:1 | PASS |
| map-truck-stale `#A16207` | osm-wood `#DCE0DC` | 3.69:1 | 3:1 | PASS |
| map-truck-stale `#A16207` | osm-road `#D5D5D5` | 3.35:1 | 3:1 | PASS |
| map-truck-stale `#A16207` | osm-water `#D9E2E7` | 3.75:1 | 3:1 | PASS |
| map-truck-crit `#B91C1C` | osm-bg `#F2F3F0` | 5.81:1 | 3:1 | PASS |
| map-truck-crit `#B91C1C` | osm-park `#E6E9E5` | 5.28:1 | 3:1 | PASS |
| map-truck-crit `#B91C1C` | osm-resid `#EAEAE6` | 5.36:1 | 3:1 | PASS |
| map-truck-crit `#B91C1C` | osm-wood `#DCE0DC` | 4.85:1 | 3:1 | PASS |
| map-truck-crit `#B91C1C` | osm-road `#D5D5D5` | 4.41:1 | 3:1 | PASS |
| map-truck-crit `#B91C1C` | osm-water `#D9E2E7` | 4.92:1 | 3:1 | PASS |
| route `#1D4ED8` | osm-bg `#F2F3F0` | 6.02:1 | 3:1 | PASS |
| route `#1D4ED8` | osm-park `#E6E9E5` | 5.47:1 | 3:1 | PASS |
| route `#1D4ED8` | osm-resid `#EAEAE6` | 5.56:1 | 3:1 | PASS |
| route `#1D4ED8` | osm-wood `#DCE0DC` | 5.02:1 | 3:1 | PASS |
| route `#1D4ED8` | osm-road `#D5D5D5` | 4.57:1 | 3:1 | PASS |
| route `#1D4ED8` | osm-water `#D9E2E7` | 5.10:1 | 3:1 | PASS |
| center-pin `#0F172A` | osm-bg `#F2F3F0` | 16.03:1 | 3:1 | PASS |
| center-pin `#0F172A` | osm-park `#E6E9E5` | 14.58:1 | 3:1 | PASS |
| center-pin `#0F172A` | osm-resid `#EAEAE6` | 14.80:1 | 3:1 | PASS |
| center-pin `#0F172A` | osm-wood `#DCE0DC` | 13.38:1 | 3:1 | PASS |
| center-pin `#0F172A` | osm-road `#D5D5D5` | 12.16:1 | 3:1 | PASS |
| center-pin `#0F172A` | osm-water `#D9E2E7` | 13.59:1 | 3:1 | PASS |

Map truck colours are checked against white because every marker has a white halo; tile backgrounds are not relied on.

## 9. Accessibility rules (WCAG 2.1 AA)
- Focus: 2 px `focus #1D4ED8` outline + 2 px offset, never removed; visible on every interactive element incl. map markers (markers are buttons in a list mirror, see below).
- Targets: ≥44×44 console, ≥56 ramp iPad. Spacing 8 px between targets.
- Map is never the only way: every marker has a row in the board; a "Vehicles" list mirrors the map for keyboard/screen reader.
- Screen reader: chips read "State: Needs action"; ETA "Arriving 8:12 to 8:22, 6 minutes later than planned"; live region `polite` only for new exceptions and delivery failures; countdowns announced at thresholds.
- Reduced motion (`prefers-reduced-motion`): marker tween replaced by position jumps every 5 s, no pulses, no fly-to animation, no row flash.
- Text resize to 200% without loss; no horizontal scroll at 320 CSS px for the dispatcher form and drawer.
- Forms: visible labels (no placeholder-only), errors in text next to the field with `aria-describedby`.

## 10. Acceptance checklist (Rudy builds to it, Veri and Vera walk it; per taste-clear-walk)
Walk each persona at **1280×800, 1024×768 iPad landscape, 820×1180 iPad portrait, 390×844** (dispatcher link and drawer).
- [ ] DEMO banner visible on every route, every width, inside persona phones (on top, with "Simulated phone" under it, §6.3), Teams panel, exports.
- [ ] Every state on screen shows icon + label; grayscale screenshot test: all states still distinguishable.
- [ ] `python3 docs/design/contrast.py` passes; token-drift grep (design-taste-frontend §5) clean.
- [ ] Keyboard-only: board → drawer → approve exception → back, with visible focus throughout.
- [ ] Ramp iPad: all targets ≥56 px; confirm boarding in ≤2 taps; offline queue shows count and "Recorded late" after sync.
- [ ] Reduced motion on: no tween, pulse or fly-to (camera uses `jumpTo`).
- [ ] Map attribution visible with drawer open, demo panel open and on iPad portrait; no violet on the map; positron style with the §5.1 water override.
- [ ] VoiceOver (iPad) reads a board row and an exception in a sensible order.
- [ ] Whole demo job: Reset → F1 self-drop → ramp infeasible → approve C8 → second approver sees "Already decided" → GPS gap STALE then No signal → EOD close blocked → Export. Non-seeded state, reload persists.
- [ ] Header adapter pills show real ages ("SMS · Live 12 s", "GPS · Stale 4 min") once B-12 lands; the interim "<adapter> · Simulated" text is gone.
- [ ] Every icon in §3 renders from lucide (no missing-icon fallbacks).
- [ ] "Arrived (vehicle)" never shows as "Handed off".
- [ ] Empty, loading, error, SSE-down, 412 conflict, expired dispatcher link states all seen.
- [ ] No horizontal scroll; no "+N more" truncation hiding children; one primary CTA per region; one identity location.
- [ ] Copy matches COPY-GUIDE; no banned words; no data beyond COPY-GUIDE §7.
- [ ] Screenshots attached for every persona × width, opened by the walker; NOT WALKED list written.

## 11. Decisions (product calls)
All nine recommendations accepted by the founder as written in PR #2. Recorded in docs/DECISION-LEDGER.md rows 29–37; D-10 in row 39 (source: Founder widget answer "Approve as proposed", Vera chat, 2026-10-14 13:15 ET; relay message id not available; timestamp is the reference). Source: Founder widget answer "Accept all 9 of Vera's recommendations", Firia chat, 2026-10-14 11:39 ET; relay message id not available; timestamp is the reference.
| # | Question | Options | Decision | Owner | Status |
|---|---|---|---|---|---|
| D-1 | Banner text: PRD step 1 says "SYNTHETIC DATA", NFR-09 says "DEMO/LIVE" | (A) "DEMO · Synthetic data, no real children" (B) "SYNTHETIC DATA" only | A (meets both) | founder | Decided by founder, 2026-10-14 11:39 ET (relayed by Firia); banner text superseded 2026-10-14 13:18 ET by founder: exactly "DEMO" (ledger row 40); explicit founder override of PRD §18.2 step 1 "synthetic banner" (l.1332); NFR-09 still met (confirmed 13:30 ET) |
| D-2 | GPS freshness bands: PRD 60/600 s vs STALE badge 180 s | (A) four bands as in §3 (B) PRD three bands only | A | founder | Decided by founder, 2026-10-14 11:39 ET (relayed by Firia) |
| D-3 | Child label on staff screens: first name + last initial (synthetic "SYN-" names) vs token only | (A) first + initial (B) child token | A, matches PRD Teams "first names" | founder | Decided by founder, 2026-10-14 11:39 ET (relayed by Firia) |
| D-4 | Font: Atkinson Hyperlegible Next vs system UI | A / B | A | founder | Decided by founder, 2026-10-14 11:39 ET (relayed by Firia) |
| D-5 | Demo violet `#6D28D9` reserved for demo | yes / pick another | yes | founder | Decided by founder, 2026-10-14 11:39 ET (relayed by Firia) |
| D-6 | Map in board by default (split) vs board-only with map tab | split / tab | split ≥1280 | founder | Decided by founder, 2026-10-14 11:39 ET (relayed by Firia) |
| D-7 | Ramp iPad orientation priority (iPad model unknown, CA-08) | landscape-first / portrait-first | landscape-first | founder (landscape-first is the POC layout default; CA-08 stays open.) | Decided by founder, 2026-10-14 11:39 ET (relayed by Firia) |
| D-8 | "Person-first" default vs any center preference (CA-15 languages, identity-first requests) | person-first default / ask center | person-first, ask center | founder | Decided by founder, 2026-10-14 11:39 ET (relayed by Firia) |
| D-9 | Spanish/Haitian Creole copy for outbound family SMS in POC | English only / add languages | English only in POC, design for 40% expansion | founder | Decided by founder, 2026-10-14 11:39 ET (relayed by Firia) |
| D-10 | Form of the NFR-09 source-mode badge (PRD mandates it, leaves form open) | (A) outlined icon + label chip as in §7.1 (B) text-only suffix | A | founder | Decided by founder, 2026-10-14 13:15 ET |
