# PPEC transportation dashboard: copy guide

```
READER: Rudy (strings), Veri (copy check), founder (decisions D-1, D-3, D-8, D-9 in DESIGN-DIRECTION.md §11, decided 2026-10-14 11:39 ET).
STATUS: Decided: D-1, D-3, D-8, D-9 (founder, 2026-10-14 11:39 ET), D-10 source-mode badge labels (founder, 2026-10-14 13:15 ET), and the banner text change to "DEMO" (founder, 2026-10-14 13:18 ET, ledger row 40; Veri has flagged it against PRD l.1332 "synthetic banner" and the founder is deciding). The rest is Vera's copy direction, not a founder decision.
```

## 1. Voice
- **Calm.** Say what happened, then what to do. No alarm words, no exclamation marks. Urgency lives in the icon, the label "Urgent" and the position, not in shouting.
- **Plain.** Short sentences, everyday words, sentence case. Times as "8:12 AM", durations as "6 min".
- **Child-first, dignity-preserving.** The child is a person getting a ride, not a load. Person-first by default ("child who uses a wheelchair"), unless the center tells us a family prefers otherwise (D-8, decided by founder).
- **Needs, not diagnoses.** We describe transport needs ("wheelchair, tilt", "car seat", "nurse rides along"). We never show or invent conditions. Needs carry the caption "Derived from intake, not a diagnosis." (PRD SURF-02).
- **Honest about certainty.** "Reported by provider" ≠ "Verified". "Arrived (vehicle)" ≠ "Handed off". "Unknown until arrival" is normal, not an error.
- **Name the person.** "Dana approved" not "Approved by user". Agent actions say "Agent (auto)".

## 2. Banned words and swaps
| Don't write | Write instead | Why |
|---|---|---|
| wheelchair-bound, confined to a wheelchair | uses a wheelchair | dignity |
| special needs, handicapped, disabled kid, suffers from, victim of | (name the transport need) | dignity; needs not labels |
| load / unload / cargo / pax (for children) | board / help off / riders | children aren't freight (PRD: never "unloading") |
| drop / dropped (child) | dropped off / arrived | ambiguity |
| abandoned, stranded, lost child | Waiting: vehicle full / Held: no adult to receive | calm, specific |
| patient | child | not an EHR |
| ASAP, URGENT!!!, CRITICAL | Urgent (label) + due time | calm |
| Oops, Uh-oh, Whoops, 🎉 any emoji | plain sentence | tone |
| leg, outbox, SSE, idempotency, webhook, token, 412, enum names | ride (AM/PM), message, live updates, saved once, —, —, "Someone else changed this" | jargon (founder-facing rule) |
| Handed off (on geofence) | Arrived (vehicle) | PRD SURF-01 acceptance |
| guaranteed, safe (as a claim) | — | no promises the system can't keep |

Internal enum names may appear in Health/developer surfaces only.

## 3. Formats
- Child on staff screens: first name + last initial, synthetic only ("Mia R."). Families: "F4 family" in demo views. Phones: 555-01xx only.
- Times: "8:12 AM"; windows "8:12–8:22 AM"; deltas "+6 min" / "−3 min" / "On time".
- Ages: "2 min ago", "Verified 17 min ago by J.T."
- Buttons: verb + object, ≤3 words: "Confirm boarding", "Approve change", "Take over".

## 4. Labels
State labels are fixed in DESIGN-DIRECTION.md §3 and must be used verbatim.

## 5. Microcopy per surface
### Header / shell
- Freshness pill (interim until B-12): "SMS · Simulated", "GPS · Simulated", "Teams · Simulated", "Agent · Simulated". After B-12: "SMS · Live" / "GPS · Stale 4 min" / "Teams · Down, use Exceptions page".
- SSE down: "Live updates paused. Reconnecting… Board may be up to 40 s old."
- Search placeholder (with visible label "Search"): "Child, route or vehicle".

### SURF-01 Board
- Group headers: "Needs action (2)", "On the way (11)", "Done (9)", "Not riding today (4)".
- Empty: "No rides scheduled for Tue, Oct 14. Change the date or reset the demo."
- Error: "Couldn't load the latest. Showing 8:04 AM data." [Retry]
- Conflict: "Someone else changed this ride. Review the changes." [Review]
- Toggle: "Only needs action".

### SURF-02 Drawer
- Needs caption: "Derived from intake, not a diagnosis."
- Unapproved need: "Not approved yet. Ask the director to review."
- Capability: "Verified 17 min ago by J.T." / "Reported by provider, not checked at the ramp."
- Handoff disabled: "Confirm at the ramp first. The vehicle hasn't been checked." [Override with reason]
- Override dialog: title "Override ramp check", field "Reason (required)", button "Confirm handoff".
- History item: "Dana changed AM ride to Center van · ramp check didn't fit · 9:41 AM".

### SURF-03 Inbox
- Identity: "Matched to F4 family · high confidence" / "Unknown number. Don't share ride details." 
- Extracted change: "Absent today: Mia R. (AM and PM)".
- Ambiguity (agent): "Thanks for letting us know. Which child is staying home: Mia, Leo, or both?"
- Plan changed banner: "The plan changed at 8:04 AM. Check before you reply."
- Take over: "Take over" → banner "You're replying. The agent is paused on this thread." [Release to agent]
- Agent down: "Agent paused. Keyword replies only: ABSENT, SICK, YES, READY, STOP."

### Outbound family SMS (simulated)
- Confirmation: "PPEC: Got it. Mia's morning ride is canceled. Her afternoon ride home is still on. Reply HELP for help, STOP to opt out. [DEMO]"
- Delay window: "PPEC: Mia's ride is running about 10 min late. New pickup window 8:20–8:30 AM. [DEMO]"
- Never include needs, health, addresses, or other children in a message.

### SURF-04 Ramp iPad
- Vehicle tile: "V1 · Provider P1 · arriving 8:52 · 3 riders".
- Checklist rows: "Lift works?", "Wheelchair positions free", "Securement: L-track", "Walking seats free", "Car-seat anchors (LATCH)" with Yes / No / Not sure.
- Feasibility: "Fits: 1 wheelchair, 1 walking seat." / "Doesn't fit: needs 2 wheelchair positions, has 1. Coordinator alerted."
- Child card buttons: "Confirm boarding", "Not on vehicle", "Left early". Left early asks "Who picked up?" (role list, no free-text names in demo).
- Offline: "Offline · 3 saved on this iPad. They'll send when Wi-Fi is back." After sync: chip "Recorded late".
- Undo: "Boarding confirmed for Leo B." [Undo] (3 s).

### SURF-05 Exceptions
- Row: "Urgent · Vehicle too full · Leo B. AM · 6 min · Dana · Due in 4:12".
- Proposal: "Move Leo B. to Center van. Arrives 6 min later. F7 family will be told."
- Buttons: "Approve", "Reject", "Reassign", "Snooze…", "Handle manually". Reason field: "Why? (required)".
- Race: "Already decided by Dana at 9:41 AM: approved."
- Empty: "Nothing needs action right now."

### SURF-06 / SURF-07
- Breaker: "Paused after 5 failures. Retrying at 9:50 AM." Degraded: "SMS is down. Call families from the Contacts sheet and log the call."
- ROI note: "Synthetic data, n = 28 children. Not a real result."

### Dispatcher link
- Intro: "PPEC needs to know what this vehicle can carry today."
- Expired: "This link has expired. Call PPEC at (561) 555-0100."
- Done: "Thanks. PPEC has your answers. You can close this page."

### Demo panel
- Reset confirm: title "Reset the demo?", body "This clears today's rides, messages and exceptions and reloads the sample data. Sign-ins and settings stay." Buttons "Reset demo" / "Cancel".
- Clock toast: "Clock moved to 7:30 AM. 4 reminders rescheduled."
- Fault toast: "Stall added to V1 (simulated)." Active fault chip: "Stall · V1 · 3 min" [Clear].
- Export: "Building evidence file…" → "Evidence ready (2.4 MB)." [Download]

## 6. DEMO banner text (founder, 2026-10-14 13:18 ET; supersedes D-1 wording; ledger row 40)
- Banner: **"DEMO"**
- Compact (<768 px): same text, "DEMO".
- Screen reader: aria-label "Demo environment" (role="status", announced once on load).
- Message suffix: "[DEMO]". Export header: "DEMO".

### 6.1 Source-mode badge labels (D-10, Decided by founder, 2026-10-14 13:15 ET)
Simulated · Replay · Manual entry · Sandbox · Live. Screen reader: "Source: {label}". Shown on every screen, record and outbound message (NFR-09); spec in DESIGN-DIRECTION §7.1.

## 7. What demo copy may contain (ADR-015)
Allowed: `SYN-` synthetic first names + last initial, family codes F1–F8, 555-01xx numbers, example.com emails, public landmark names from MOCKS §1, transport needs from the PRD dataset. Never: real names, DOBs, home addresses, diagnoses, medications, school names, photos of people, Medicaid ids, or any free text that reads like a medical note.
