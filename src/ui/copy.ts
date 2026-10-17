/**
 * Every user-facing string the app renders. Source of truth: COPY-GUIDE.md
 * (§5 microcopy per surface, §6 banner text, §6.1 source-mode labels) and
 * DESIGN-DIRECTION.md §2 (nav), §3 (state labels, which live in states.ts).
 *
 * Components must not contain user-facing string literals; a copy change is a change here.
 * Voice: calm, plain, child-first, honest about certainty (COPY-GUIDE §1).
 */

/**
 * Fills `{name}` placeholders. Keys may contain spaces, because some §3 labels are written
 * that way ("Handed off to {receiver role}", "Staff: {first name}"). Unknown placeholders are
 * left in place so a missing value is visible in review instead of printing "undefined".
 */
export function fill(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{([^{}]+)\}/g, (match, key: string) =>
    key in values ? String(values[key]) : match,
  );
}

/**
 * Closes a sentence with exactly one full stop. Needed because §3 writes a child as first name
 * plus last initial ("Leo B."), so a template that supplied its own period would print "Leo B..".
 */
export function sentence(text: string): string {
  return /[.?\u2026]$/.test(text) ? text : `${text}.`;
}

export const app = {
  /** Site name in the header. */
  siteName: "PPEC transportation",
  /** <title> */
  documentTitle: "PPEC transportation dashboard",
  skipToContent: "Skip to content",
} as const;

/**
 * COPY-GUIDE §6 (founder, 2026-10-14 13:18 ET, ledger row 40): the banner reads exactly
 * "DEMO", and that decision covers the screen-reader label too — COPY-GUIDE §6 and
 * DESIGN-DIRECTION §7 both fix it as aria-label "DEMO", announced once on load.
 */
export const demoBanner = {
  text: "DEMO",
  ariaLabel: "DEMO",
} as const;

/** DESIGN-DIRECTION §2 nav labels. Exceptions carries a count badge once the live board lands. */
export const nav = {
  today: "Today",
  exceptions: "Exceptions & Approvals",
  setup: "Setup",
  health: "Health & ROI",
  landmarkLabel: "Main",
  openMenu: "Open menu",
  closeMenu: "Close menu",
  menuLabel: "Menu",
} as const;

/** COPY-GUIDE §5: visible label "Search", placeholder "Child, route or vehicle". */
export const search = {
  label: "Search",
  placeholder: "Child, route or vehicle",
  submit: "Search",
} as const;

export const identity = {
  menuLabel: "Account",
  signOut: "Sign out",
  signedInAs: "Signed in as {name}",
} as const;

/**
 * COPY-GUIDE §5 header: freshness pills read "<adapter> · Simulated" until the live board
 * wires real ages.
 */
export const adapters = {
  sms: "SMS",
  teams: "Teams",
  gps: "GPS",
  agent: "Agent",
  /** Interim value, approved for build (DESIGN-DIRECTION §2); replaced by real ages later. */
  simulatedValue: "Simulated",
  separator: " · ",
  groupLabel: "Adapter freshness",
  /** Says out loud that no time on this screen is real, so the header never over-claims. */
  interimNote: "Times are simulated until the live board is connected.",
} as const;

/**
 * Ages, humanized (COPY-GUIDE §1 "durations as '6 min'", §3 "'2 min ago'"). Raw seconds never
 * reach the screen above a minute; `humanizeAge` in src/ui/age.ts picks the template.
 */
export const age = {
  seconds: "{n} s",
  minutes: "{n} min",
  hours: "{h} h",
  hoursMinutes: "{h} h {m} min",
  /**
   * The same ages in full words, for the ear only (§9). A screen reader reads "12 s" as
   * "twelve ess" and "4 min" as "four min", so the eye keeps the short form and the
   * screen-reader text says "12 seconds". Singular at exactly one, never "1 minutes".
   */
  spoken: {
    second: "{n} second",
    seconds: "{n} seconds",
    minute: "{n} minute",
    minutes: "{n} minutes",
    hour: "{h} hour",
    hours: "{h} hours",
    /** Joins the two halves of "1 hour 5 minutes". */
    separator: " ",
  },
} as const;

/** COPY-GUIDE §5: SSE down >15 s. "SSE" is jargon and never reaches the screen. */
export const liveUpdates = {
  downTitle: "Live updates paused",
  downBody: "Live updates paused. Reconnecting… Board may be up to 40 s old.",
} as const;

/** COPY-GUIDE §6.1 / DESIGN-DIRECTION §7.1. Screen reader: "Source: {label}". */
export const sourceMode = {
  SIMULATED: "Simulated",
  REPLAY: "Replay",
  MANUAL: "Manual entry",
  SANDBOX: "Sandbox",
  LIVE: "Live",
} as const;

export const screenReader = {
  /** §9: chips read "State: Needs action". */
  state: "State: {label}",
  /** §7.1 */
  source: "Source: {label}",
  freshness: "{adapter}: {value}",
} as const;

/**
 * Places every surface names the same way. The centre is named, never addressed: the demo
 * fixture carries its street, and no screen may print an address (COPY-GUIDE §7).
 */
export const places = {
  center: "PPEC center",
} as const;

/**
 * Deltas and windows (COPY-GUIDE l.36). U+2212 for the minus, so "−3 min" lines up with the
 * digits instead of using a hyphen. `unknown` is what an unusable delta says: a missing or
 * non-finite shift is not "On time", and it is never printed as "−NaN min".
 */
export const etaText = {
  ahead: "+{n} min",
  behind: "−{n} min",
  onTime: "On time",
  unknown: "Not known yet",
  /**
   * No window has been worked out for this ride yet. Never read as "no ride".
   *
   * It said "Window pending" until this slice — a status written the way a queue writes one,
   * which is how a coordinator ends up asking what a window is and what it is pending on. The
   * sentence a person would say instead was already written down and waiting (COPY-GUIDE §5,
   * docs/ui/B12-SLICE1-DEFERRED.md §2): the time is not set yet, and the clock beside it says
   * which kind of fact that is.
   */
  pending: "Time not set yet",
  /** LOC-03: the last published window, with the pause spelled out. */
  paused: "{window} · ETA texts paused",
} as const;

/**
 * SURF-01 Board (Today) — COPY-GUIDE §5 "SURF-01", DESIGN-DIRECTION §4.1.
 *
 * `empty` is the §5 sentence verbatim. The group headers are the §5 headers verbatim too, with
 * one addition: §5 names four groups, written for a mid-morning board where every ride has
 * started, and a ride that is planned but has not left is neither "on the way" nor "not riding
 * today" — so there is a fifth, and it says plainly what it is.
 *
 * The board's unit is one child's one ride: a row is "Mia R., morning", so the morning and the
 * afternoon are two rows with their own state, van, window and next step. That is why
 * the counts below are counted in rides rather than children.
 */
export const board = {
  heading: "Today",
  /**
   * The same board, another day. The §5 heading is "Today", and it may only say that on the day
   * it is true of: a board showing the day before, with every ride on it finished, under a
   * heading that said "Today" would be the one sentence on the screen that was false.
   */
  headingOtherDay: "Rides on {date}",
  /**
   * The three ways this board can be empty, each one line and each ending in the one thing to
   * do about it. They are three strings and not one because they are not the same fact: a day
   * with no rides in it is not a search that matched nobody, and neither is a filter that is
   * hiding everything. One sentence for all three would be wrong twice.
   */
  empty: "No rides scheduled for {date}. Change the date or reset the demo.",
  emptySearch: "No child matches {query}. Clear the search to see the whole day.",
  emptyNeedsAction: "Nothing needs action right now. Turn the filter off to see the whole day.",
  dateLabel: "Service date",
  /** §5: "Needs action (2)", "On the way (11)", "Done (9)", "Not riding today (4)". */
  groups: {
    NEEDS_ACTION: "Needs action",
    GETTING_READY: "Getting ready",
    ON_THE_WAY: "On the way",
    DONE: "Done",
    NOT_RIDING: "Not riding today",
  },
  groupHeading: "{group} ({count})",
  onlyNeedsAction: "Only needs action",
  /** Said above the rows, so a filtered board never looks like the whole day. */
  showing: "Showing {shown} of {total} rides",
  /** The one search term the shell's box carried in, echoed so it can be cleared. */
  searchedFor: "Search: {query}",
  clearSearch: "Clear search",
  /** §4.1: the row's own columns, in order. Used as the table's column headers. */
  columns: {
    child: "Child",
    ride: "Ride",
    state: "Ride state",
    vehicle: "Van",
    gps: "Van location",
    eta: "Arriving",
    receiver: "Receiver and therapy",
    nextStep: "Next step",
    source: "Source",
  },
  tableLabel: "Today's rides, one row for each child's morning and afternoon",
  /**
   * The same table on another day. "Today's rides" is read out by a screen reader before the
   * first row, so on a finished day it is the heading's falsehood said again where only the ear
   * can catch it — and the ear is the one reader who cannot see the date beside it.
   */
  tableLabelOtherDay: "Rides on {date}, one row for each child's morning and afternoon",
  am: "AM",
  pm: "PM",
  /** The ride in words, for the ear and for the row opener's accessible name. */
  amSpoken: "morning",
  pmSpoken: "afternoon",
  /** A ride the family drives themselves: there is no van to show, and that is not a gap. */
  familyDrives: "Family drives",
  /**
   * "The center van · Greenacres center fleet" — the van, then who runs it. Drawer only
   * (§4.1 density).
   *
   * Both halves are display names, not fixture keys: `{van}` is `vanTitle` and `{provider}` is
   * the company with the synthetic marker already off it, because this line read
   * "V2 · SYN Greenacres center fleet" on prod (Vera, 2026-10-17 2:48 PM ET).
   */
  vanAndProvider: "{van} · {provider}",
  /** The vehicle is assigned but has sent nothing we may draw (an unlinked device, LOC-01). */
  noPosition: "No van location yet",
  /**
   * The same column on a day that is over. "No van location yet" promises one is coming, which
   * is true of a van that has not left and false of a day whose vans are back in the yard: this
   * slice keeps no position history, so the honest answer is that none was kept.
   *
   * It says "van location" rather than "position", because that is what the column is called
   * and what a coordinator calls the thing: a position is the word the ingest path uses for a
   * row it stored (COPY-GUIDE §1–§2).
   */
  noPositionRecorded: "No van location kept",
  /** No window has been worked out for this ride yet — a state, so it gets an icon and a label. */
  windowPending: etaText.pending,
  /** §5.1: a stall is words and a clock, never a colour. */
  stopped: "Stopped {minutes} min",
  /** The therapy detail beside the "Therapy scheduled" chip: "9:30 AM · Tasha L." */
  therapyAt: "{time} · {therapist}",
  /** TRP-02: nobody on file may take the child at the end of the afternoon ride. */
  noReceiver: "No adult on file to receive",
  /** §1 "name the person": the adult on file is named, never called "a receiver on file". */
  receiverNamed: "{adult} receives",
  /**
   * What fills the §3 handoff label, "Handed off to {receiver role}". §1 asks for a person and
   * the afternoon has one — the adult on file, by name. A morning ride is received by the ramp,
   * which the fixture gives no name (B12-SLICE1-DEFERRED §3.4: the ramp observation carries no
   * person), so it is named as the place it happened rather than as a person who might not have
   * been there.
   */
  receivedByRamp: "the ramp",
  /**
   * Why a ride is in "Needs action", in the order the board ranks them. Each one names the
   * thing it is about — the child, or the van — because "this child" and "this van" are only
   * unambiguous next to the row they came from, and these are read in the drawer too.
   */
  reasons: {
    /**
     * The no-adult-at-home case (PRD §6.6 CA-04). Two facts, in the order a coordinator needs
     * them: where the child is, and why nobody has taken them.
     *
     * It used to carry a third clause — that nothing brings the child back to the centre on its
     * own — which is the most important sentence on this panel and the reason it is no longer
     * here: a reason in a board cell is read at a glance over 56 rows, and a third clause put
     * the one line a coordinator must not skim at the end of a line they skim. It is said in
     * full in the drawer instead (`drawer.heldNoReturn`), which is where this row leads.
     */
    CHILD_HELD: "{child} is waiting with the van. No adult on file can receive them.",
    /**
     * `{van}` is the van's name in the middle of a sentence ("the convertible van"), never its
     * fixture key — "V1 does not fit everyone on this run." was on the board (Vera's prod walk,
     * 2026-10-17 2:48 PM ET). Which is why the sentence turned round: a van's name is a common
     * noun with an article in front of it, so it cannot open a sentence the way a code could.
     */
    DOES_NOT_FIT: "Not everyone on this run fits in {van}.",
    NO_RECEIVING_ADULT: "No adult on file may receive {child} at the end of the afternoon ride.",
    /**
     * The end of a day with a handoff missing from it: the van arrived, the day is over, and no
     * custody event was ever recorded. It names the vehicle's fact and then what is missing, in
     * that order, because the first half is the one a coordinator can see for themselves on the
     * row — the state chip beside it says "Arrived (vehicle)" — and the second is the one only
     * this line says.
     *
     * It is a *reason*, not a state: the row still says the van arrived and nothing more, which
     * is the rule about arrivals and handoffs. What changed is where the row sits, because a day
     * whose vans are back in the yard has nobody left to record the handoff unless a person is
     * asked to.
     */
    HANDOFF_UNRECORDED: "{child}'s van is back and nobody recorded who received them.",
    RIDE_STATE: "{child}'s ride needs a person to decide what happens next.",
    /** `{van}` is the van's name, mid-sentence, like every other `{van}` on this board. */
    LOCATION_LOST: "Nothing has been heard from {van} for ten minutes.",
  },
  /**
   * The next step on a ride: a sentence that opens with a verb and names the child.
   *
   * This column used to name a role — "Coordinator", "Front desk" — which is the one thing a
   * coordinator reading their own board already knows. A step is a thing to do and the person
   * it is done for has a name (COPY-GUIDE §1 "name the person", §3 "verb + object"), so each of
   * these is written as one, and `NOTHING` is the only entry that is not an instruction because
   * it is the only one that is not a step.
   */
  nextSteps: {
    /** CA-04's own instruction: every authorized and emergency contact, and then a record. */
    CALL_CONTACTS: "Call {child}'s contacts and record who receives them.",
    MOVE_TO_FITTING_VAN: "Move {child} to a van that fits.",
    /** Closed with `sentence()`: "{child}" already ends in the last initial's full stop. */
    RECORD_RECEIVER: "Record who receives {child}",
    DECIDE_RIDE: "Decide what happens to {child}'s ride.",
    FIND_VAN: "Find {child}'s van.",
    CONFIRM_BOARDING: "Confirm {child} boarded.",
    CONFIRM_HANDOFF: "Confirm the handoff for {child}",
    /**
     * A van nobody has reported on. Which step it is depends on whose van it is: a provider's
     * van is somebody's answer to give, and that somebody is named. The centre's own van has no
     * dispatcher to ring because the people who can answer are the ones at the ramp.
     */
    ASK_ABOUT_VAN: "Ask {dispatcher} about {child}'s van.",
    CHECK_VAN_AT_RAMP: "Check {child}'s van at the ramp.",
    NOTHING: "Nothing to do",
  },
  /** §4.1 keyboard: j / k move, Enter opens. Said once, above the rows. */
  keyboardHint: "Use J and K to move between rides, Enter to open one.",
  /** "Open Mia R., morning ride" — one opener per row, so two rows are two distinct buttons. */
  openRow: "Open {child}, {ride} ride",
} as const;

/**
 * The service date (§2 header, PRD §6.1).
 *
 * One date on screen, and it is the demo day: the chrome used to carry today's real date while
 * the board carried the seeded day the scenario replays, both labelled "Service date" — two
 * different days, the same words, and nothing on the screen to say which one a row belonged to.
 * The board's own header now carries that one date, and the shell carries none, so in demo mode
 * nothing on screen claims to be today.
 *
 * It is read rather than changed (Vera's final call): no switcher, no arrows. The day is the one
 * the scenario replays, and a control offering another one would offer days this build does not
 * replay — the chrome would be promising what the data cannot keep.
 *
 * The date says what kind of day it is, because that is the answer to the first question the
 * board raises: "Demo day" is said plainly rather than "Today", since the demo clock has not
 * started (the readout beside it says so) and the seeded day is the day being shown and not the
 * day it is. The other two phases belong to a finished or an unstarted day, which the projection
 * can still be asked for by URL; neither is a day the console offers a way to reach.
 */
export const serviceDate = {
  groupLabel: "Service date",
  phases: {
    LIVE: "Demo day",
    ENDED: "Day ended",
    PLANNED: "Not started",
  },
} as const;

/** The day a heading is about: its phase, and the date it is labelled by (src/domain/board/day.ts). */
export type LabelledDay = { phase: keyof typeof serviceDate.phases; label: string };

/**
 * A heading that may only say "Today" on the day that is true of (Veri #49).
 *
 * Three places read one day and name it — the board's own heading, the table's screen-reader
 * caption, and the drawer's first section heading — and each carried the same ternary beside it.
 * Three copies of one rule is three places it can be broken, and the two hardest to catch by
 * looking are in there: the caption only the ear hears, and a panel that covers the header
 * carrying the date, so a day that is *not* the demo day could be introduced as "Today's rides"
 * with nothing on screen to correct it.
 *
 * So the rule is here, once, and it is the narrow one: the words that say "Today" are used on
 * the live demo day and on no other phase. A finished day and a day that has not started are
 * both named by their date, because neither of them is today.
 */
export function onDay(words: { today: string; otherDay: string }, day: LabelledDay): string {
  return day.phase === "LIVE" ? words.today : fill(words.otherDay, { date: day.label });
}

/**
 * Scenario clock in the header (§2). The demo-controls dock (§6.1) owns the clock; until it
 * is wired the readout says the demo has not started and Start says honestly why it is inert.
 */
export const scenarioClock = {
  label: "Scenario clock",
  notStarted: "Demo not started",
  /**
   * COPY-GUIDE §3, "Buttons: verb + object, ≤3 words". It read "Start" — a verb with nothing
   * after it, sitting next to "Demo not started", so the one thing a founder is about to click
   * did not say what it starts. COPY-GUIDE §5 sketches this control as "[Start]"; that line
   * predates §3's button rule and is the shorter of the two, so the rule wins.
   */
  start: "Start demo day",
  /** Shown on hover and on focus; the button stays focusable so this can be read (§9). */
  startUnavailable: "Demo controls aren't connected yet.",
} as const;

/**
 * Surfaces that exist in the nav but whose data and interactions are not built yet. Each one
 * says so in its heading and then says, in one plain sentence, what it will do. No ticket
 * codes: a build-step name means nothing to a coordinator (COPY-GUIDE §1).
 *
 * Today is not in here any more, and nor is Health & ROI: both are built, so a sentence
 * promising either would be the one thing this table exists to prevent — a screen saying
 * something that is not true of it.
 */
export const unbuilt = {
  /** `{page}` is the nav label, so the heading reads "Setup isn't built yet". */
  heading: "{page} isn't built yet",
  exceptions:
    "This page will list what needs action, who is handling it, and when it is due.",
  setup: "This page will hold the vans, their seat layouts, and the people allowed to receive a child.",
} as const;

/**
 * Health & ROI — SURF-06 (what each part of the system is doing) and SURF-07 (today, counted),
 * COPY-GUIDE §5, DESIGN-DIRECTION §4.6.
 *
 * Two rules shape every string here, and both are about not over-claiming.
 *
 *  1. **A number says what it was counted over.** §4.6 asks for "baseline vs current, n,
 *     confidence note", and this build has no four-week baseline to compare against (§17.4 is
 *     the study that produces one). So every number below is today's own count, the cohort is
 *     named under it, and `sampleNote` ends on the sentence that keeps a screenshot honest.
 *     The two figures a baseline would produce — hours saved and money saved — are in
 *     `baseline` instead: rows that say so, carrying no digit at all.
 *  2. **A mocked adapter never reads as a working one.** `allMockedIntro` is the first thing on
 *     the health panel, because a table of rows a reader skims is exactly where "everything is
 *     fine" gets inferred from nothing being red.
 *
 * Each metric has three sentences rather than one. A count is a subject, and "1 rides need a
 * person" is the kind of sentence that makes a reader distrust the number next to it — so the
 * zero, the one and the many are written out, and `src/app/(app)/health/lines.ts` picks.
 */
export const health = {
  /** <title> for the route, so the tab says which screen is open. */
  documentTitle: "Health & ROI · PPEC transportation dashboard",
  /**
   * What the screen is, in the order it is read: the numbers, then the parts of the system.
   * It promises the drill-down because the drill-down is the point — a number nobody can open
   * is a number nobody can check.
   */
  intro:
    "Today's rides, counted. Every number opens the rides it was counted from, and every ride opens the child's day.",
  roiHeading: "Today, counted",
  /**
   * COPY-GUIDE §5: "Synthetic data, n = 28 children. Not a real result." The ride count is added
   * because three of the four numbers are counted per ride and not per child, so the n a reader
   * needs is both.
   */
  sampleNote: "Synthetic data, n = {children} children, {rides} rides. Not a real result.",
  /** SURF-07: one diagonal watermark across the numbers, so a screenshot cannot lose it. */
  watermark: "SYNTHETIC",
  /** The control on each number. It opens the rides behind that number and nothing else. */
  showRides: "Show the rides",
  hideRides: "Hide the rides",
  /** "Needs a person: 1 ride" — the heading of the list a number opens. */
  ridesHeading: "{label}: {rides}",
  /**
   * The accessible name of a table that is wider than the screen it is on.
   *
   * At 390 px — a phone held in portrait, which is what a director opens this screen on away
   * from their desk — the five-column rides table and the four-column adapter table are wider
   * than the panel, and the panel clips what does not fit (§4.6's watermark needs the overflow
   * hidden). So there were columns on this screen that no amount of scrolling reached: the van
   * and the next step on one table, the runbook line on the other (Vera's review of 53423de,
   * 2026-10-17). They scroll sideways now, inside a region a keyboard can reach and focus,
   * which is what makes a scrollable area operable without a mouse (§9) — and a region a
   * screen reader lands in has to say what it is and what it does, which is this.
   *
   * `{table}` is the table's own heading, never a second name written for this line.
   */
  tableScroll: "{table}. Scroll sideways to see every column.",
  /** A number that counted nothing still opens, and says so rather than showing an empty table. */
  noRides: "Nothing was counted here today, so there is no ride to open.",
  /**
   * The columns of that list. Fewer than the board's: this is a way back to a child, not a
   * board. There is no opener string here either — the row's button is announced with the
   * board's own `board.openRow`, because it is the same control doing the same thing, and a
   * click learned on one screen has to work on the other.
   */
  rideColumns: {
    child: "Child",
    ride: "Ride",
    state: "Ride state",
    vehicle: "Van",
    nextStep: "Next step",
  },
  metrics: {
    /**
     * Whether the capacity check found every child a place. The ratio is the headline because
     * the shortfall is the thing that cannot be allowed to hide inside a percentage.
     */
    CHILDREN_PLACED: {
      label: "Children with a seat",
      value: "{count} of {total}",
      all: "Every child who rides with us has a seat on a van today.",
      /** Said rather than counted: "0 of the 9 children" opens a sentence on a zero. */
      none: "No child who rides with us has a seat on a van today.",
      one: "One of the {total} children who ride with us has a seat on a van today.",
      many: "{count} of the {total} children who ride with us have a seat on a van today.",
      /** A day the scenario does not run at all: no child rides with us, so none is placed. */
      nobody: "No child rides with us today.",
      why: "A seat is a place the capacity check agreed to, for the needs that child's plan has approved.",
    },
    /** PRD §6.3: a van is checked before it carries a child, so this counts what is still unknown. */
    VAN_UNCHECKED: {
      label: "Waiting on a van check",
      value: "{count} of {total}",
      none: "Every van carrying a child today has been checked.",
      one: "One ride is on a van nobody has checked today.",
      many: "{rides} are on a van nobody has checked today.",
      why: "A van is checked before it carries a child, so what it can take today is known rather than assumed.",
    },
    /** Measured against the window the family was first given, not against the plan on paper. */
    ARRIVING_LATE: {
      label: "Arriving later than planned",
      value: "{count}",
      none: "No ride is arriving later than planned.",
      one: "{child}'s ride is arriving about {minutes} later than planned.",
      many: "{rides} are arriving later than planned, the furthest by about {minutes}.",
      why: "Measured against the arrival time the family was first given, not against the plan on paper.",
    },
    /** The board's own needs-action count: a ride nothing resolves on its own. */
    NEEDS_A_PERSON: {
      label: "Needs a person",
      value: "{count}",
      none: "No ride needs a person right now.",
      one: "{child} has a ride that needs a person right now.",
      many: "{rides} need a person right now.",
      why: "A ride nothing in the system will close on its own, so it waits for somebody to act.",
    },
  },
  /**
   * The two savings that have no number — hours saved and money saved (PRD §17.3's reclaimed
   * hours and NetCash, src/domain/health/metrics `BASELINE_ROWS`).
   *
   * They are on the screen, under the counted numbers and never among them, because the two
   * ways of leaving them out are both worse than saying it. Printed from §17.3's parameter
   * table they would be an assumption wearing a result's clothes — and §17.3's own conclusion
   * is that single-center cash ROI is negative in every defensible scenario, so the assumption
   * would not even flatter us. Left off the screen entirely they read as an oversight, and the
   * first person to notice fills the gap with a guess of their own.
   *
   * So each row carries a label, the words "Not measured yet" where a figure would sit, and one
   * sentence naming what has to happen first: §17.4's four-week baseline. No digit appears in
   * any of these strings — "four" is a word here for exactly that reason, and
   * health-screen.test.ts holds it — because a numeral in this block is the one thing a
   * screenshot could crop into a claim.
   */
  baseline: {
    /**
     * Its own phrase, not the words inside the rows: "Not measured yet" is what stands where a
     * figure would, and a heading that repeats it exactly makes the rows harder to count and
     * harder to read aloud. It sits beside "Today, counted" and "What is actually running",
     * and says the same kind of thing about its panel.
     */
    heading: "What is not measured yet",
    /**
     * Said before the two rows. "Here" is doing the work: the point is not that these are
     * unknowable, it is that this centre has not been measured.
     */
    intro:
      "Two savings people ask about are missing a number on purpose. Nobody has measured them at this center yet, so putting a figure here would be a guess, and a guess is the one thing a page like this must not print.",
    /** What stands where a figure would, on every row. Words, never a dash or a blank cell. */
    noNumber: "Not measured yet",
    /** The column headings: the thing, and what would have to happen before it has a number. */
    columns: { row: "What people ask for", when: "What it would take" },
    rows: {
      HOURS_SAVED: {
        label: "Hours saved",
        detail:
          "Measured over the first four weeks of use: how long a change takes staff today, so the same change can be timed again afterwards.",
      },
      MONEY_SAVED: {
        label: "Money saved",
        detail:
          "Measured over the first four weeks of use: what the center is paying today in extra hours and trips that did not need to happen.",
      },
    },
  },
  /**
   * SURF-06, the adapter panel. One row per part of the system: the mode it is in, what it is
   * doing on today's data, and what a coordinator does when it stops working (PRD l.1200 puts
   * the runbook in the on-duty coordinator's hands).
   */
  adapterPanel: {
    heading: "What is actually running",
    /**
     * Said before the table, not after it. A reader who skims a table of rows with nothing red
     * in it concludes that everything is working, and on this deployment that is false of every
     * row — so the panel says it in words first.
     */
    allMockedIntro:
      "Nothing in this list is live. Every part of it is simulated for the demo, so nothing below should be read as proof that the real one works.",
    /** The same panel once something really is live: a reader has to go row by row. */
    someLiveIntro:
      "Some parts of this list are live and some are simulated. Each row says which it is.",
    columns: {
      adapter: "Part of the system",
      mode: "Mode",
      doing: "On today's data",
      degraded: "If it stops working",
    },
    /**
     * The mode chip's two words. A mocked row says **"Simulated"** — the same word the §7.1
     * source chip has been saying in the DEMO bar on every screen — rather than "Mocked",
     * which asked a reader to learn a second word for a fact they had already learnt. It was
     * the wrong word to learn, too: a mock is one part of the build standing in for another,
     * which is a sentence about the code, and what this row has to say is that the thing in
     * front of them is not the real one.
     */
    modes: { MOCK: "Simulated", LIVE: "Live" },
    names: {
      SMS: "Text messages to families",
      MAPS: "Maps, van locations and travel times",
      AGENT: "The assistant",
    },
    /** Why a row is mocked. One per reason, because the three reasons are not the same fact. */
    mocked: {
      NO_CARRIER_ADAPTER:
        "One provider is connected and it writes to the demo phones. The carrier adapter in this build refuses every send, so no message can leave the building.",
      REPLAYED_ROUTES:
        "The vans drive recorded routes and their travel times come with them, so no map service is asked anything.",
      NO_RUNNER:
        "The assistant cannot be given a run on this build, so it answers nothing about today.",
    },
    /**
     * What the row is doing on today's data, in numbers this screen computed. Two of the three
     * have a second form for the count that would otherwise read as a gap: "and 0 were worth a
     * text" is the sentence a reader checks twice, and "none was worth a text yet" is the same
     * fact said once.
     */
    doing: {
      SMS: "{considered} arrival changes were weighed up for a family so far today, and {sent} of them were worth a text.",
      SMS_NONE_SENT:
        "{considered} arrival changes were weighed up for a family so far today, and none was worth a text yet.",
      MAPS: "{locating} of {vans} vans carrying children are sending their position. Arrival updates are paused for {paused} of them.",
      MAPS_NONE_PAUSED:
        "{locating} of {vans} vans carrying children are sending their position, and no arrival update is paused.",
      AGENT_REFUSED:
        "A live model call would be refused here by this deployment's own data check, before any request is built.",
      AGENT_ALLOWED:
        "This deployment's data check would allow a live model call, and nothing on this build makes one.",
    },
    /** COPY-GUIDE §5: the degraded instruction, in plain words, one thing to do. */
    degraded: {
      SMS: "Call families from the Contacts sheet and log the call.",
      MAPS: "Arrival updates stop and staff set each ride's state by hand.",
      AGENT: "Staff read the inbox and answer the family themselves.",
    },
  },
} as const;

/** Sign-in. §9: visible labels, errors in text next to the field with aria-describedby. */
export const login = {
  heading: "Staff sign in",
  intro: "Demo accounts only.",
  emailLabel: "Email",
  passwordLabel: "Password",
  submit: "Sign in",
  error: "Email or password is incorrect.",
  errorSummary: "We could not sign you in.",
} as const;

/**
 * The live map — where the fleet is now, on its own route until the map lands inside SURF-01
 * (BUILD-PLAN-M2 P-03). Vera and Veri also walk the DESIGN-DIRECTION §10 map checklist here, so
 * the copy is precise about what is and is not simulated, and it lives in this file so the §1
 * voice rules apply to it too.
 *
 * On the name: "Live map" is what the screen is *for* — where every van is right now — and the
 * §7.1 source chip in the DEMO bar is what says where the positions come from, "Simulated", on
 * this route as on every other. That is the same division the whole app uses: the board is
 * called "Today" and the chip says the rides are simulated. The label used to be "Map preview",
 * which named the build rather than the screen, and Vera's review (2026-10-17) rules out
 * "preview" in any menu label or address. Nothing here claims the data is live: `signedInOnly`
 * says it is simulated in words, `mapLabel` says it again to a screen reader, and every row the
 * pane draws is a fixture replay (src/fixtures/replays.ts).
 */
export const liveMap = {
  heading: "Live map",
  /** <title> for the route, so the tab says which screen is open. */
  documentTitle: "Live map · PPEC transportation dashboard",
  /**
   * What the surface is, in one sentence a reviewer reads once. It used to carry the build's
   * own surface code and a paragraph of fixture provenance; neither means anything to the
   * people who stand in front of this screen, so both are gone (COPY-GUIDE §1–§2). It also used
   * to end "Nothing here is live", which was the honest half of a screen called "Map preview";
   * the sentence below says where the vans are from, and `signedInOnly` says the data is
   * simulated, so the screen never claims a live feed it does not have.
   */
  intro: "Where every van is, on the demo's own routes and clock.",
  /** Said on the page itself: this surface is still behind staff sign-in, and still simulated. */
  signedInOnly: "Staff sign-in only. The data below is simulated, and the roles still apply.",
  clock: "Scenario clock {time} ET",
  pause: "Pause",
  play: "Play",
  restart: "Restart",
  /** Clock speed buttons (§6.2): ×1 / ×10 / ×60. */
  speed: "×{factor}",
  motionReduced: "Reduced motion: markers step, no tween",
  /**
   * What the markers are doing when motion is not reduced. It used to say "Tweened along route
   * geometry" — the implementation, in two words nobody outside this repo uses. The screen says
   * what a reviewer sees instead (COPY-GUIDE §1: plain words, no jargon).
   */
  motionTweened: "Vans follow their routes.",
  mapLabel: "Fleet map: simulated vehicles near the PPEC center",
  centerLabel: places.center,
  decisionsHeading: "Notification decisions",
  /**
   * Says plainly that this step only *decides*. `{suppressed}` is `suppression` /
   * `suppressionPlural`, so the sentence carries no bare count without its noun.
   */
  decisionsIntro:
    "Decisions only — this step computes what would be sent, and why. Nothing is queued, nothing is sent, nothing is written to a database. {suppressed} so far this run (below threshold, not persisted, cooldown, stale GPS, or a stop already passed).",
  suppression: "{count} suppression",
  suppressionPlural: "{count} suppressions",
  decisionsEmpty: "No notification decision yet.",
  decisionRow: "{time} ET · {vehicle} · {family} · {shift} · new pickup window {window}",
  faultsHeading: "Injected faults",
  /**
   * A fault row names the van, the run in words and what was injected. The run's fixture id
   * ("route1", "route1-unbound") and the ticket it was written for never reach the screen —
   * a reviewer standing at the board reads a place name, not a file name.
   */
  faultRow: "{vehicle} · {route} · {fault}",
  /** A demo run, named by where it starts: "Okeeheelee Park run". */
  routeName: "{stop} run",
  /**
   * Where a sibling screen is, said from the live map so it can be found at all — the ramp
   * iPad, and the planning surface for the roles whose own row in the table opens it.
   *
   * `{page}` is that screen's own heading, so a link cannot call a screen something the screen
   * does not call itself. It was two strings with the two names written out again, and when
   * SURF-04 took the PRD's name (`rampIpad.heading`) one of them was left pointing at
   * "the ramp check", a screen with that title no longer existing. src/ui/nav-items.ts reads
   * the same headings for the rail.
   */
  openScreen: "Open {page}",
  /** A device with no active binding has no position to show, so it is absent, not faint. */
  unbound:
    "{vehicle}'s device has no active binding: {unbound} points ingested and stored as unbound, {accepted} displayable. It has no marker, no row and no ETA.",
} as const;

/**
 * Demo accounts offered under the sign-in form (founder decision, ledger rows 57 and 59).
 * Shown only where the demo flags are on and the data is synthetic, which is why the words can
 * be this plain: there is no real account to confuse these with. Each line says what that
 * person sees, not what the role is called in the database.
 *
 * `use` is what the eye reads on every card; `useRole` is the same button's accessible name,
 * which keeps the visible words and adds the role, so three identical buttons are three
 * distinct things to a screen reader. `filled` is announced in a live region after a fill.
 *
 * All three accounts share one password (ledger row 59), so each card still carries its own
 * email and that password — a card is a complete set of credentials, readable on its own —
 * and `shared` says once, above them, that the three passwords are the same password. The
 * value itself is config, not copy: `DEMO_SHARED_PASSWORD` in src/auth/demo-accounts.ts.
 */
export const demoLogins = {
  divider: "Or use a demo account",
  shared: "All three accounts use the same password.",
  use: "Use this account",
  useRole: "Use this account, {role}",
  filled: "{role} account filled",
  /** The field names the form above already uses, so the card labels match it. */
  emailLabel: login.emailLabel,
  passwordLabel: login.passwordLabel,
  roles: {
    DIRECTOR: {
      title: "Director",
      description: "Sees the whole site, the demo controls, and the health and savings view.",
    },
    COORDINATOR: {
      title: "Coordinator",
      description: "Runs the day: the board, what needs action, and approvals.",
    },
    FRONT_DESK: {
      title: "Front desk",
      description: "Handles arrivals and handoffs at the door.",
    },
  },
} as const;

/**
 * The three staff roles in words a person would use out loud, singular and plural. Nothing on
 * a screen may print the database's own role name (COPY-GUIDE §2), and the no-access line below
 * is assembled from the plural forms, so they are written for the middle of a sentence:
 * "Directors and coordinators can open this."
 *
 * Keyed by the role as the database stores it, because the access table (src/auth/access.ts)
 * is keyed that way; the key never reaches a screen, only its words do.
 */
export const roleNames = {
  DIRECTOR: { one: "Director", many: "directors" },
  COORDINATOR: { one: "Coordinator", many: "coordinators" },
  FRONT_DESK: { one: "Front desk", many: "front desk staff" },
} as const;

/**
 * A page that exists, is open to staff, and is not open to *this* signed-in person.
 *
 * The heading says that in the person's own terms — it is their role that does not include
 * this page, not a failure of theirs and not a broken link — and then one line says who the
 * page is for, assembled from the access table so the words cannot drift from the guard that
 * enforced them. Nothing else: no status code, no role key, no route path, nothing a
 * coordinator could read as a bug to report (COPY-GUIDE §1–§2).
 *
 * `{who}` is the list of roles, already sentence-cased: "Directors and coordinators".
 */
export const noAccess = {
  heading: "This page isn't part of your role",
  whoCanOpen: "{who} can open this.",
  /** Said when the page is open to no role at all, so the line is never a bare full stop. */
  whoCanOpenNobody: "Nobody can open this page yet.",
  /** List joiners for `{who}`: "A, B and C". */
  listSeparator: ", ",
  listAnd: " and ",
  /**
   * The signed-in person who holds no role at any site at all (Vera's copy). "This page isn't
   * part of your role" is the wrong sentence for them — they have no role, so naming the roles
   * that could open the page tells them nothing they can act on. These two lines say what is
   * actually true of their account, and who can change it. Shown for that caller only; a staff
   * caller refused one page keeps the heading and the `{who}` line above.
   */
  noRoleHeading: "Your account isn't set up for a site yet",
  noRoleLine: "Ask a director to add you.",
  /** The way out, labelled with the words its destination already uses ("Go to Today"). */
  back: "Go to {page}",
} as const;

/**
 * A URL that matches no page. One line, no apology and no blame (§1), and exactly one way
 * back, so there is nothing to choose between. The two labels are the words their destinations
 * already use — the nav item and the sign-in button — so a wording change there carries here.
 */
export const notFound = {
  heading: "This page doesn't exist.",
  today: nav.today,
  signIn: login.submit,
} as const;

/** Developer surface: confirms the signed-in identity against the database. */
export const whoami = {
  heading: "Signed in",
  /** Internal role enum names are allowed on developer surfaces only (COPY-GUIDE §2). */
  membership: "{role} at site {siteId}",
} as const;

/**
 * SURF-04 Ramp iPad (COPY-GUIDE §5 "SURF-04", §3 formats, DESIGN-DIRECTION §4.4).
 *
 * Every word the ramp check renders, including the strings the pure helpers in
 * src/app/ramp-ipad/capability.ts build up — a verdict is computed there, but the sentence
 * that says it belongs here. Voice rules from §1 apply: plain, honest about certainty, a need
 * is never a diagnosis.
 */
export const rampIpad = {
  /**
   * The PRD's own name for this screen, now that the rail links to it: PRD §14 calls the
   * destination "Ramp iPad" in the navigation line (l.1055) and titles the surface "SURF-04
   * Ramp iPad" (l.1061), and DESIGN-DIRECTION §2 repeats it ("Ramp iPad is its own full-screen
   * route"). It was "Ramp check", which said the job rather than the surface; one name, in the
   * rail and at the top of the page, is worth more than two good ones (src/ui/nav-items.ts
   * reads this string for the rail label, so they cannot drift).
   */
  heading: "Ramp iPad",
  /** `{date}` is the site-timezone service date, "Tue, Oct 14" (§3). */
  subtitle: "{date} · afternoon rides",
  /**
   * What leaves this iPad and what does not, in one line, so nobody waits for a send that never
   * happens — and nobody believes a check nobody else can see.
   *
   * It used to read "Nothing here is sent. Answers stay on this iPad.", which was true of a
   * surface that recorded onto itself and is not true of this one: what the ramp finds about the
   * van now reaches the plan and the board, where a coordinator decides about it. The boarding
   * records really do stay here, so that half of the sentence stays.
   */
  localOnly:
    "Nothing here is sent to a family. What the ramp finds goes to the plan; boarding records stay on this iPad.",

  arrivalsHeading: "Which vehicle is at the ramp?",
  /**
   * §5: the tile reads "The convertible van · Palm Lift Transport", then "leaves at 3:16 PM ·
   * 3 riders", over two lines.
   *
   * Both names are display names. It read "V1 · SYN Palm Lift Transport" — a fixture key and the
   * fixture's own synthetic marker, on the most-rendered tile of the surface a ramp attendant
   * actually holds (Vera's prod walk, 2026-10-17 2:48 PM ET). `{vehicle}` is `vanTitle`, because
   * a tile's title is a name standing on its own.
   *
   * The second line no longer repeats the van: it carried `{description}` while the first line
   * carried the key, which is one tile saying "V1" and then "convertible van" — two names for
   * one van. Now the title says the name and the line under it says the two facts a ramp check
   * is against. `{time}` is the moment the plan has this run leaving the centre, never a
   * hand-written fixture string.
   */
  vehicleTile: "{vehicle} · {provider}",
  vehicleTileDetail: "leaves at {time} · {riders} riders",

  /**
   * "What can the convertible van carry today?" — `{vehicle}` is `vanName`, the mid-sentence
   * form, because this heading sits inside a question.
   */
  checklistHeading: "What can {vehicle} carry today?",
  checklistIntro:
    "Unknown until arrival is normal. Anything left on “Not sure” keeps the run unchecked.",
  layoutLegend: "How is the vehicle set up?",
  /**
   * A seat layout in words. The fixtures carry the trade's shorthand ("1WC/3A"), which is
   * fine on a manifest and wrong on a 56 px button a ramp attendant taps in the rain, so the
   * button says what the shorthand means. `layoutName` in src/app/ramp-ipad/capability.ts
   * reads the two counts out of the code; these are the words it puts round them.
   */
  layout: {
    /** "No wheelchairs · 6 seats" — zero is said, never printed as "0 wheelchairs". */
    noWheelchairs: "No wheelchairs",
    separator: " · ",
  },
  /** Announced on any button that is the current choice, after its own label (§9). */
  selected: "selected",
  liftRow: "Lift works?",
  latchRow: "Car-seat anchors (LATCH)",
  /** §5: every checklist row answers Yes / No / Not sure. "Not sure" is never read as a yes. */
  answer: { YES: "Yes", NO: "No", UNSURE: "Not sure" },
  positionAnswer: { FREE: "Free", OUT: "Out of service", UNSURE: "Not sure" },
  wcFree: "Wheelchair places free: {available} of {needed} needed",
  ambFree: "Walking seats free: {available} of {needed} needed",
  tetherFree: "Anchored seats free: {available} of {needed} needed",
  loseWifi: "Simulate losing Wi-Fi",
  wifiBack: "Wi-Fi is back",
  /** §5 offline pill, verbatim: "Offline · 3 saved on this iPad. They'll send when Wi-Fi is back." */
  offlinePill: "Offline · {count} saved on this iPad. They'll send when Wi-Fi is back.",

  slotsHeading: "Who sits where",
  wcPosition: "Wheelchair position {n}",
  ambPosition: "Walking seat {n}",
  wcPositionDetail: "{securement} · fits {length} × {width} cm",
  ambPositionDetail: "has an anchor",
  free: "Free",
  assign: "Assign",
  change: "Change",
  close: "Close",
  clearSeat: "Clear seat",
  noEligibleRider: "No rider on this run fits this place.",

  ridersHeading: "Riders",
  boardedReported: "Boarded (reported)",
  boardedVerified: "Boarded, verified · {time}",
  notOnVehicleChip: "Not on vehicle · {time}",
  leftEarlyChip: "Left early · {by} · {time}",
  /** §4.4: queued while offline, then stamped once it syncs. */
  recordedLate: "Recorded late",
  /** §5 SURF-02, reused here: a transport need is never a diagnosis. */
  needsCaption: "Derived from intake, not a diagnosis.",
  /**
   * The chair, measured at the ramp rather than taken from the file.
   *
   * The one thing on this screen that is about a child's equipment and not the van's, and the
   * lever the whole of "equipment found unknown at arrival" turns on: a chair that arrives with
   * a new headrest and a tray is a chair the approved profile does not describe, and the plan
   * has to be asked again about the chair that is here. The button is only offered for a child
   * whose chair the day has a measurement for, and the line after it compares the two rather
   * than asserting a difference.
   */
  measureChair: "Measure the chair",
  measuredChip: "Measured {length} × {width} cm",
  measuredDiffers: "Bigger than the {length} × {width} cm on file.",
  measuredMatches: "The same size the file says.",
  confirmBoarding: "Confirm boarding & securement",
  confirmAgain: "Tap again to confirm",
  notOnVehicle: "Not on vehicle",
  leftEarly: "Left early",
  whoPickedUp: "Who picked up?",
  whoPickedUpFor: "Who picked up {child}?",
  /** Roles only — no free-text names in the demo (§5 SURF-04). */
  pickupRoles: ["Parent or guardian", "Approved adult on the pickup list", "PPEC staff"],
  blockedPending: "Finish the vehicle check first. Every row needs Yes or No.",
  blockedInfeasible: "The run doesn’t fit yet. A coordinator decides before anyone boards.",

  queueHeading: "Saved on this iPad",
  queueRow: "{label} · {time}",
  queueLabel: "{action} · {child}",
  queueWaiting: "Waiting for Wi-Fi",
  queueSaved: "Saved here only",
  boardingConfirmed: "Boarding confirmed",
  /** §5: "Boarding confirmed for Leo B." with a 3 s Undo. */
  undo: "Undo",
  /** Closed with `sentence()`, since "{child}" already ends in the last initial's period. */
  snackBoarded: "Boarding confirmed for {child}",
  snackNotOnVehicle: "{child} marked not on vehicle",
  snackLeftEarly: "{child} marked left early",

  optionsHeading: "What a coordinator can choose",
  optionRow: "{label} — {detail}",
  needsApproval: "Needs a coordinator’s approval",
  optionsNote:
    "Reported by provider, not checked at the ramp, unless that vehicle was checked here too. Ramp staff don’t choose; the coordinator does.",

  /* ── the feasibility banner (§5 SURF-04) ── */
  /**
   * The banner is pinned to the bottom of the iPad, so it is over the checklist for as long as
   * the page is scrolled. Collapsed it is one line — the verdict, which is the part that has to
   * be true at a glance — and the reason and the coordinator's options are one tap away.
   */
  showDetails: "Show details",
  hideDetails: "Hide details",
  /** §5: "Fits: 1 wheelchair, 1 walking seat." */
  fits: "Fits: {parts}.",
  fitsNobody: "Fits: nobody is riding this run.",
  checkedAs: "Checked as {layout}.",
  notChecked: "Not checked yet.",
  notCheckedDetail: "Answer every row to see whether the run fits.",
  vehicleOut: "This vehicle is out of service today.",
  /** §5: "Doesn't fit: needs 2 wheelchair positions, has 1. Coordinator alerted." */
  doesntFit: "Doesn't fit: {phrase}. Coordinator alerted.",
  foundAtStop: "Found at stop {k}.",
  withAnchors: "{parts} ({count} with an anchor)",
  deficitCount: "needs {needed}, has {available}",
  deficitFallback: "the run does not fit this vehicle",
  deficitSecurement: "the securement in this vehicle does not match a rider's chair",
  deficitFootprint: "a rider's chair is larger than the position allows",
  deficitLift: "the lift is not working and a rider boards by lift",

  /* ── rider need chips (§1: needs, never a diagnosis) ── */
  usesWheelchair: "Uses a wheelchair · {securement}",
  chairSize: "Chair {length} × {width} cm",
  needsAnchoredSeat: "Needs an anchored seat",
  escortRides: "Attendant rides along",

  /** Who the observation is attributed to when ramp staff answer the checklist themselves. */
  observedBy: "Ramp staff",
} as const;

/**
 * What one ramp check does to the afternoon, in the words the three screens that show it read:
 * the ramp iPad that took the check, the plan a coordinator decides from (SURF-05) and the
 * Today board (SURF-01).
 *
 * One block rather than three, because the screens are three views of one fact and a move that
 * read "moves to the center van" on the iPad and "reassigned to V2" on the board would be two
 * different events to the person holding both. The sentences name a child and a van and nothing
 * else: no place ids, no configuration shorthand, no verdict word the solver uses to talk to
 * itself (the chip beside a hold carries the state, through src/ui/states.ts).
 *
 * Every line here is about a *proposal*. PRD §9 l.865 gives the afternoon's ramp check to
 * centre staff and the decision that follows to a coordinator, so nothing on these screens
 * locks a manifest or tells a family, and `decides` says so wherever the outcome is shown.
 */
export const rampReplan = {
  /* ── on the ramp iPad, under the checklist ── */
  heading: "What this does to the afternoon",
  /** The check agreed with the plan: the only new fact is that somebody has seen the van. */
  nothingChanged: "Every child on this van keeps their seat.",
  nothingChangedDetail: "Nobody has to move. The afternoon now has a checked van behind it.",
  /** The run as it was planned does not fit the van that arrived, before anybody boards. */
  changedDetail: "The van that arrived doesn’t fit the run it was planned for.",
  staysHeading: "Still on this van",
  movedHeading: "Moving to another van",
  heldHeading: "No van this afternoon",
  /** "Owen C. moves to the center van." */
  moved: "{child} moves to {vehicle}.",
  stays: "{child} keeps their seat.",
  /** §9: ramp staff propose, a coordinator decides, and no family hears anything before that. */
  decides: "A coordinator decides. No family has been told.",
  /** The two screens this result can be opened on, as links that carry it. */
  openPlan: "Open this on Plan routes",
  openBoard: "Open this on the Today board",

  /* ── on Plan routes and the Today board ── */
  /** The banner that says why this screen is not showing the plan it opened on. */
  bannerHeading: "A ramp check changed this afternoon",
  /** "The convertible van was checked at the ramp, and the afternoon is re-planned around it." */
  banner: "{vehicle} was checked at the ramp, and the afternoon is re-planned around it.",
  bannerNothing: "{vehicle} was checked at the ramp and arrived as planned.",
  /**
   * How many children the check is about, as one sentence.
   *
   * It used to be one template over two numbers — "{moved} moving to another van, {held} with
   * no van" — and on the ordinary case that printed "0 with no van", which is the sentence a
   * reader stops on. A zero is also the good news here, and good news stated as a nought reads
   * like a fault. So each half appears only when it counted somebody, written out at one and
   * at more than one, exactly as the Health & ROI numbers are.
   *
   * `alsoHeld` is the held clause when a moved clause already said "child", so the sentence
   * does not say the noun twice. `changed` is false when neither counted anybody, so there is
   * no empty case to write.
   */
  count: {
    moved: {
      one: "One child is moving to another van",
      many: "{moved} children are moving to another van",
    },
    held: {
      one: "One child has no van this afternoon",
      many: "{held} children have no van this afternoon",
    },
    alsoHeld: { one: "one has no van this afternoon", many: "{held} have no van this afternoon" },
    /** One clause, closed. */
    sentence: "{clause}.",
    /** Both, in the order a coordinator acts on them: who moved, then who is still stuck. */
    twoClauses: "{moved}, and {held}.",
  },
  backToRamp: "Back to the ramp check",
  clear: "Show the plan without it",

  /* ── the note on one board row ── */
  rowLabel: "Ramp check",
  rowMoved: "Moving to {vehicle} after the ramp check.",
  rowHeld: "No van after the ramp check.",
  rowChecked: "Ramp staff have checked this van.",
} as const;

/** Securement hardware in plain words, keyed by the ops.securement enum. */
export const securement = {
  L_TRACK: "L-track",
  SLIDE_N_CLICK: "slide-and-click",
  FOUR_POINT_STRAP: "four-point straps",
  OTHER: "other securement",
} as const;

/**
 * Singular / plural nouns the ramp banner counts. Kept as pairs rather than an "+s" rule so a
 * translator, or a noun that does not pluralise with an s, has somewhere to put the right word.
 */
export const countable = {
  wheelchair: { one: "wheelchair", many: "wheelchairs" },
  walkingSeat: { one: "walking seat", many: "walking seats" },
  wcPosition: { one: "wheelchair position", many: "wheelchair positions" },
  anchoredSeat: { one: "anchored seat", many: "anchored seats" },
  /** The plain seat count on a layout button: "6 seats", "1 seat". */
  seat: { one: "seat", many: "seats" },
  /**
   * A place for a chair, as a lane counts them. "Wheelchair position" is the words the ramp
   * check uses about a *deficit*; a lane says "place", which is the word the equipment chip
   * beside it already uses ("Wheelchair place · L-track").
   */
  wcPlace: { one: "wheelchair place", many: "wheelchair places" },
  /** A child's one ride, which is what the board and the Health & ROI numbers both count. */
  ride: { one: "ride", many: "rides" },
  child: { one: "child", many: "children" },
  /** A delay, in whole minutes: "about 1 minute later than planned", never "1 minutes". */
  minute: { one: "minute", many: "minutes" },
  /** The kerbs on one van's run, as the route map's list beside it counts them. */
  stop: { one: "stop", many: "stops" },
} as const;

/** "1 wheelchair" / "2 wheelchairs" — a count never reaches the screen without its noun. */
export function pluralize(count: number, noun: { one: string; many: string }): string {
  return `${count} ${count === 1 ? noun.one : noun.many}`;
}

/**
 * A seat layout in words: "1 wheelchair · 3 seats" for the fixtures' `1WC/3A`.
 *
 * The shorthand is how a provider writes a configuration down. It is fine on a manifest and
 * wrong on a 56 px button a ramp attendant taps in the rain, so every screen that shows a
 * layout — the ramp buttons, the "Checked as …" banner, the coordinator's alternate-vehicle
 * option — says what the shorthand means instead. Zero wheelchairs is *said* rather than
 * counted, because "0 wheelchairs" reads like a fault. A code this does not recognise comes
 * back unchanged, so a new fixture shows its own shorthand rather than an empty button.
 */
export function layoutName(code: string): string {
  const match = /^(\d+)WC\/(\d+)A$/.exec(code.trim());
  if (!match) return code;
  const chairs =
    Number(match[1]) === 0
      ? rampIpad.layout.noWheelchairs
      : pluralize(Number(match[1]), countable.wheelchair);
  return `${chairs}${rampIpad.layout.separator}${pluralize(Number(match[2]), countable.seat)}`;
}

/**
 * The fleet map pane (DESIGN-DIRECTION §5 / §5.1, PRD SURF-01). Words only: the layer
 * paints and the camera rules live in src/components/map/style.ts.
 *
 * §9 is the reason this list is longer than the map looks: the pane is never the only way
 * to read the fleet, so every marker has a row in the list beside it, and every row says
 * its freshness in words next to the tone colour.
 */
export const fleetMap = {
  /** Accessible name for the map region when the caller supplies none. */
  label: "Fleet map",
  fitAll: "Fit all vehicles",
  retry: "Retry",
  vehiclesHeading: "Vehicles",
  /** "V1 · Convertible van" — the id, then the vehicle in plain words. */
  vehicleRow: "{id} · {description}",
  /** "Provider P1 · In transit" */
  vehicleMeta: "{owner} · {state}",
  gps: "GPS: {age}",
  source: "Source: {label}",
  /** §5.1: a stall is words and a clock, never a colour. */
  stopped: "Stopped {minutes} min",
  /** LOC-03: the 600 s band, said out loud rather than shown only in red. */
  locationLost: "Location lost · dispatcher pinged",
  /** A stop the vehicle reached. Never "Handed off": a geofence cannot complete a handoff. */
  arrived: "Arrived (vehicle)",
  passed: "Passed",
  /** The board and the map pane say these the same way, so they are written once (`etaText`). */
  windowPending: etaText.pending,
  windowPaused: etaText.paused,
  /** The style request was abandoned (navigation, unmount): nothing more to say. */
  tilesFailed: "Map tiles did not load.",
  /** The style request failed: say what still works, so nobody assumes the board is down. */
  tilesFailedDetail: "Map tiles did not load. The board below is unaffected.",
  /**
   * "Okeeheelee Park · F4" — the stop, then the family it belongs to. The `title` tooltip on a
   * vehicle card's stop row, and nothing else: a family code is a build-internal label, so the
   * card's visible words are the place name alone (COPY-GUIDE §1–§2, src/ui/no-codes.test.ts).
   */
  stopFamily: "{stop} · {family}",
} as const;

/**
 * Why a geofence arrival is not a handoff (PRD SURF-01 l.1058). Surfaced next to an
 * arrival so the demo cannot be misread: the vehicle got there, a person still has to receive
 * the child. src/domain/location/geofence.ts re-exports this as `ARRIVAL_IS_NOT_HANDOFF`.
 */
export const arrival = {
  notHandoff: "Arrived (vehicle). Handoff needs a custody event naming the receiving adult.",
} as const;

/**
 * SURF-02, the child's drawer (COPY-GUIDE §5 "SURF-02", DESIGN-DIRECTION §4.2, PRD l.1059).
 *
 * The drawer is where a coordinator reads one child's whole day, so the rules about certainty
 * are at their sharpest here: a need is never a diagnosis, an unapproved need is greyed and
 * says why, a provider's report is not a ramp check, and the handoff button says in text — not
 * in a tooltip — what is stopping it.
 *
 * Everything in here names people and never their roles (COPY-GUIDE §1 "name the person"): the
 * child the panel is about, the adult the family has on file to receive them, the dispatcher a
 * van's capability has to be asked of. "An adult on file may receive this child" is true of
 * every family in the building and tells a coordinator nothing they can act on; "Alma R.,
 * Mia R.'s parent, may receive them." is the sentence they are actually checking.
 */
export const drawer = {
  /** Announced as the dialog's name: "Mia R." plus what this panel is. */
  label: "{child}, ride details",
  close: "Close",
  /**
   * §4.2 section order. The drawer has room for words the board's "AM"/"PM" tag does not, and
   * needs them: a card headed "AM 6:50 AM" reads as a stutter.
   */
  amRide: "Morning ride",
  pmRide: "Afternoon ride",
  /**
   * §4.2's first section heading, and it may only say "Today" on the day that is true of — the
   * same rule the board's own heading keeps (`board.headingOtherDay`). A panel of a child's
   * finished rides headed "Today's rides" is a false sentence a reader meets *inside* the day
   * they asked for, with the date they asked for on the header behind it (Veri #49).
   */
  ridesHeading: "Today's rides",
  ridesHeadingOtherDay: "Rides on {date}",
  /**
   * "Okeeheelee Park → PPEC center" — a ride read as the two ends it has, in travel order. The
   * morning collects a child at their own stop and sets them down at the centre; the afternoon
   * is the reverse, which is also what the scenario's runs do (standard.ts `RUNS`). An arrow
   * rather than "to", because the two rides of a day are read one under the other and the eye
   * should be able to see the direction flip without reading a word.
   */
  rideFromTo: "{from} → {to}",
  needsHeading: "Approved needs",
  capabilityHeading: "Vehicle check",
  receiverHeading: "Who receives the child",
  approvalsHeading: "Waiting for a decision",
  agentHeading: "Changes the assistant made",
  historyHeading: "History",

  /** §5: "Derived from intake, not a diagnosis." Shared with the ramp check, written once. */
  needsCaption: rampIpad.needsCaption,
  /** PRD VEH-01: an unapproved item is greyed and never drives seat allocation. */
  needNotApproved: "Not approved yet. Ask the director to review.",
  needNotUsed: "Not used for allocation",
  noNeeds: "No transport needs are recorded for {child} yet. Ask the director to review their intake.",
  /** §4.2: the profile's version, so a reader knows which approval they are looking at. */
  profileVersion: "Approved v{n}",

  /** §5: "Verified 17 min ago by J.T." / "Reported by provider, not checked at the ramp." */
  capabilityVerified: "Checked at the ramp before this run.",
  /** Named, not "the provider": a report is somebody's answer, and that somebody is on file. */
  capabilityReported: "Reported by {dispatcher} at {provider}. Not checked at the ramp.",
  capabilityUnknown: "Unknown until arrival. Nothing about this van is assumed yet.",
  /** The solver's verdict, in a sentence a coordinator can act on. */
  fits: "Everyone on this run has a place.",
  doesNotFit: "The van does not fit everyone on this run. A coordinator decides before anyone boards.",

  /**
   * "Alma R., Mia R.'s parent, may receive them." Both people named, and in that order —
   * written this way round rather than ending on the child's name, because a child's label
   * already ends in the last initial's full stop and a sentence closing on it reads "Mia R..".
   */
  receiverOnFile: "{adult}, {child}'s {relationship}, may receive them.",
  receiverMissing:
    "Nobody on file may receive {child} yet. Agree who will, and record it, before the afternoon van leaves.",
  /**
   * PRD §6.6: a child is held, never driven back on their own. Three short clauses rather than
   * two long ones — where the child is, that people are being called, and the rule — because
   * the rule is the part that must survive being read quickly, and it now ends the line.
   */
  heldNoReturn: "If nobody is there, {child} waits with the van while staff call. No automatic return.",

  noApprovals: "Nothing is waiting for a decision about {child} today.",
  noAgentChanges: "The assistant has not changed anything for {child} today.",
  /** §5: "Dana changed AM ride to Center van · ramp check didn't fit · 9:41 AM". */
  historyEmpty: "Nothing has changed for {child} today.",
  showHistory: "Show history",
  hideHistory: "Hide history",

  /**
   * §4.2: one primary action, in a sticky footer — and it says whose handoff it is. A drawer
   * opens over a 56-row board, so the one control that commits a custody event names the child
   * it would commit it for.
   */
  confirmHandoff: "Confirm handoff for {child}",
  /** §5: the disabled reason, in text beside the button and never in a tooltip alone. */
  handoffBlockedRamp: "Check {child}'s van at the ramp first.",
  handoffBlockedNotArrived: "Wait for {child}'s van to arrive.",
  handoffBlockedNoReceiver: "Record who receives {child} first.",
  /**
   * The fourth reason, and the only one that is about this build rather than about the day: the
   * van is there, an adult is on file, and the write path is not connected yet (the caption below
   * says so too). It is said on the button because that is where somebody about to click reads —
   * a control that looked available and then did nothing would be the one dishonest thing on
   * this panel.
   */
  handoffBlockedNotConnected: "Handoff isn't connected yet.",
  overrideWithReason: "Override for {child}, with reason",
  /**
   * Why the *override* is unavailable, under the override's own button.
   *
   * The line above that button is the handoff's reason and belongs to the handoff — and it stood
   * next to the override as well, so a reader had one sentence doing two jobs: on the day where
   * everything the handoff asks for is satisfied it reads as a note about this build, and on
   * every other day it reads as the child's missing receiver being what stops an override too.
   * Neither is what is true of it. What is true is the plain thing, and it is the same for both
   * controls: this slice reads the day and writes nothing.
   */
  overrideDisabled: "Overrides aren't connected yet.",
  /** §5 override dialog. */
  overrideHeading: "Override ramp check",
  overrideReasonLabel: "Reason (required)",
  overrideCancel: "Cancel",
  /** This slice reads; it does not write. Said out loud rather than left to be discovered. */
  readOnly: "This panel shows the day. Confirming and overriding are not connected yet.",
} as const;

/**
 * The PRD §9 (l.880) approved-need categories, in words a coordinator would say out loud.
 *
 * A need is a thing the ride has to provide, never a thing the child has (COPY-GUIDE §1–§2):
 * "Boards by lift or ramp", not a condition; "Chair size", not a measurement of a person. The
 * enum key is how the fixture and the database write it and never reaches a screen.
 */
export const needCategories = {
  WHEELCHAIR_SECUREMENT: "Wheelchair securement",
  LIFT_OR_RAMP: "Boards by lift or ramp",
  CAR_SEAT_OR_BOOSTER: "Car seat or booster",
  HARNESS_OR_VEST: "Harness or vest",
  ATTENDANT_ESCORT: "Attendant rides along",
  SEATING_SEPARATION: "Seated away from another rider",
  MAX_RIDE_TIME: "Longest time on the van",
  EQUIPMENT_DIMENSIONS: "Chair size",
  MEDICAL_DEVICE_POWER: "Device that needs power",
} as const;

/**
 * The capacity solver's words (PRD §7 l.784-800, §9 l.880). A verdict is computed in
 * src/domain/solver/feasible.ts; the sentence that says it belongs here, so the §1 voice
 * rules (plain, honest about certainty, a need is never a diagnosis) apply to it.
 */
export const solver = {
  /** Why the answer is unknown rather than infeasible. Never read as a yes. */
  pending: {
    unobserved: "What this vehicle can carry today is unknown until arrival.",
    substituted:
      "A different vehicle is coming. What it can carry is unknown until the provider reports.",
    latchUnknown: "Car-seat anchors (LATCH) not reported yet.",
    liftUnknown: "Lift not reported yet, and a wheelchair rider needs it.",
    unsurePositions: "Some positions were answered “Not sure”.",
    unsureCapability: "Part of this vehicle's capability was answered “Not sure”.",
  },
  /** Capability states that put the vehicle out of today's reach entirely. */
  unusable: {
    REJECTED: "Staff rejected this vehicle's report for today.",
    UNAVAILABLE: rampIpad.vehicleOut,
    /** Already checked and already found not to fit: re-solving it would say the same thing. */
    VERIFIED_INFEASIBLE: "Staff checked this vehicle and the run does not fit it.",
  },
  /** Stands in for the rider names when the solver cannot name anyone (§3: no bare counts). */
  unnamedRiders: "the riders who have not boarded",
  /**
   * The PRD §7 l.799 option set. Button-length labels, no ticket codes (§2), and one
   * sentence of detail a coordinator can act on. Every one of them needs a human.
   */
  options: {
    SPLIT_RUN: {
      label: "Split the run",
      detail:
        "Run {who} separately on {vehicle}. Everyone already on the vehicle stays where they are.",
    },
    /**
     * `{vehicle}` is `vanName` and `{description}` is `vanTitle` — the same van, mid-sentence in
     * the label and standing at the head of its own sentence in the detail. Neither is the half
     * of the fixture's label that is a key, and `{provider}` arrives with the synthetic marker
     * already off it: this detail read "center van (SYN Greenacres center fleet) fits …" behind
     * the ramp iPad's "Show details" on prod (Vera, 2026-10-17 2:48 PM ET).
     */
    ALTERNATE_VEHICLE: {
      label: "Move to {vehicle}",
      detail: "{description} ({provider}) fits {who} as {layout}.",
    },
    /** The same sentence, for a van from another operator. The same two display names. */
    ALTERNATE_PROVIDER: {
      label: "Move to {vehicle}",
      detail: "{description} ({provider}) fits {who} as {layout}.",
    },
    FAMILY_TRANSPORT: {
      label: "Ask the family to drive",
      detail:
        "Ask the family of {who} to drive today. The family is told only after staff choose.",
    },
    DELAY: {
      label: "Delay the run",
      detail: "Hold the run until a vehicle that fits is free. {who} waits at the center.",
    },
    CANCEL: {
      label: "Cancel the ride",
      /**
       * One sentence, with the name inside it rather than at the end of a clause: `{who}` is a
       * first name and a last initial, so "for Leo B." already ends in a full stop and the old
       * two-sentence form printed "for Leo B.. Attendance…" wherever an option was listed.
       */
      detail: "Cancel today's ride for {who}, and update attendance and therapy sessions.",
    },
  },
  /** The delay sentence with nobody to name, so it never reads "{who} waits at the center". */
  delayAnyone: "Hold the run until a vehicle that fits is free. Riders wait at the center.",
} as const;

/**
 * Plan routes (VEH-01…05; DESIGN-DIRECTION §4.1 density rules, COPY-GUIDE §1–§5).
 *
 * The coordinator's planning surface: a lane per van, the children in it as stops in pickup
 * order, and the children in no van at the top with the reason. The verdicts are the capacity
 * solver's (src/domain/solver); these are the words that say them, and they follow the same
 * three rules the rest of this file does — name the person, say what to do, never print the
 * machine's vocabulary. A deficit type, a layout code, a capability state and a vehicle's own
 * code are all internal: what reaches the screen is "no four-point straps", "Zoe B." and "the
 * convertible van".
 */
export const planRoutes = {
  heading: "Plan routes",
  /** <title> for the route, so the tab says which screen is open. */
  documentTitle: "Plan routes · PPEC transportation dashboard",
  /** "Tue, Oct 14 · morning pickups" (§3 date format). */
  subtitle: "{date} · {direction}",
  directionLegend: "Which run?",
  direction: { AM: "morning pickups", PM: "afternoon drop-offs" },
  directionButton: { AM: "Morning", PM: "Afternoon" },
  /**
   * The one primary action on the screen, and it says the same thing every time it is read.
   *
   * It used to become "Plan routes again" once anybody was in a van, which is a second label for
   * one button: a coordinator who has moved two children by hand and wants the rest filled in
   * reads "again" as "start over" (Vera's review, 2026-10-17). One label, and the button keeps
   * what was done by hand — `plannedKeptMoves` is what it says afterwards.
   */
  plan: "Plan routes",
  /**
   * Said after planning when a coordinator had already put somebody in a van by hand: those
   * placements are kept and the rest of the day is planned around them, so the line says so
   * rather than leaving a reader to compare two screens.
   */
  plannedKeptMoves: "Planned again, and kept every child you moved by hand.",
  /* ── which scenario the demo replays ── */
  /**
   * The click-through needs both halves of the §9 story on one screen: the ordinary run where
   * every child gets a van, and the run where one child's equipment has no van to hold it,
   * which is where the group at the top and the reasons in it are read.
   *
   * Named by what happens, not by a date (Vera's review, 2026-10-17). The screen replays one
   * service date and says so once, in the heading — the earlier labels ("A day everyone fits",
   * "A day one child has no van") read as a second and a third day a coordinator could pick
   * between, which is a calendar this screen does not have. These two say which scenario of the
   * one day is on screen, and the normal one is what it opens on.
   */
  demoScenarioLegend: "Demo scenario",
  demoScenario: {
    EVERY_RIDER_FITS: "Normal day",
    ONE_RIDER_HAS_NO_VAN: "A child can’t be placed",
  },
  /**
   * What each scenario is, in one short sentence. Both were a line longer until Vera's review on
   * 2026-10-17: a note on a demo control is read at a glance, so each one now says only the thing
   * that is different about the fleet, and the vans in it are named the way the lanes name them.
   */
  demoScenarioNote: {
    EVERY_RIDER_FITS: "Three vans today: the convertible van, the center van and the sedan.",
    ONE_RIDER_HAS_NO_VAN:
      "The convertible van is off the road and a smaller van replaced it. No van today has four-point straps.",
  },
  /**
   * The family hears nothing until staff have chosen, said out loud while anyone has no van.
   *
   * It is the only sentence on this screen about sending, since Vera's review: there used to be a
   * second one above it ("Nothing here is sent. A coordinator approves a plan before anyone is
   * told."), and two lines making the same promise in the same place read as boilerplate rather
   * than as the thing a coordinator is being told.
   */
  nothingSent: "No family has been told. Staff choose first.",
  summary: "{planned} of {total} riders are in a van.",

  /* ── a lane ── */
  lanesHeading: "Vans",
  /**
   * A van, everywhere this screen names one: "the convertible van".
   *
   * The fixtures write a van as a code and then what it is ("V1 convertible van"), and the code
   * is the machine's handle on it — nobody says "V1" out loud, and a coordinator who reads it has
   * to translate before they can act. So no code reaches this screen at all (Vera's review,
   * 2026-10-17): what is left is the van's own name, written as it is said in the middle of a
   * sentence, article and all, because that is where most of these land ("Can't put Zoe B. in the
   * center van"). A lane's heading is the same string with its first letter capitalised by the
   * stylesheet, so there is one name for a van and not two.
   */
  vanNamed: "the {description}",
  /**
   * A van the fixtures gave no plain-words name: "A van".
   *
   * `vanTitle("")` built "The " out of `vanNamed` and an empty description, which is a van with
   * a blank name on the screen — and the live map asks for a name by vehicle id, so a van
   * missing from the fixture map got exactly that (Vera, 2026-10-17). A van with no description
   * is still a van, and this is what it is called. Standalone and capitalised, like `vanTitle`
   * itself, because that is where a van's name stands alone.
   */
  vanUnnamed: "A van",
  vanMeta: "{provider} · {driver} driving",
  equipmentHeading: "What this van has",
  equipment: {
    lift: "Ramp and lift",
    noLift: "No ramp or lift",
    /** "Wheelchair place · L-track · fits 130 × 72 cm" */
    wcPlace: "Wheelchair place · {securement} · fits {length} × {width} cm",
  },
  /**
   * Used of available, in that order (Vera's review, 2026-10-17): "3 of 6 seats used" is the
   * sentence a coordinator says out loud about a van, and it answers "how full is it" in one
   * read. It replaced "Seats: 3 needed, 6 free", which asked the reader to subtract.
   *
   * A lane can still be asked for more than it has — that is what an infeasible run *is* — and
   * "4 of 3 seats used" would read as a typo, so `seatsOver` says the quiet part out loud rather
   * than leaving the two numbers to argue. `lanes.ts` chooses between them.
   *
   * One template for all three counts, with the places carrying their own noun through
   * `pluralize` (`countable.wcPlace`, `seat`, `anchoredSeat`): "1 of 1 wheelchair place used"
   * rather than a plural over a count of one.
   */
  seatsUsed: "{used} of {places} used",
  seatsOver: "{line} · more than this van has",
  setUpAs: "Set up as {layout}",
  /**
   * The same line for a van set up with no chairs in mind, written as a sentence of its own.
   *
   * `layoutName` is a *label*: it opens on a capital because it is read on a button ("No
   * wheelchairs · 6 seats"), and dropping that label into `setUpAs` made the lane say "Set up as
   * No wheelchairs · 6 seats" — a label wearing a sentence, with a capital in the middle of it
   * (Vera's review, 2026-10-17). Lowercasing the "no" only hid the seam. So the one setup that
   * has nothing to count says itself in plain words instead, and the seat count it drops is the
   * place line directly underneath ("0 of 6 seats used").
   */
  setUpNoWheelchairs: "Set up with no wheelchair places",
  /**
   * Why the line above is not the same line all day on a van that can be re-seated.
   *
   * A convertible van has several configurations (V1 is built as 6 seats, as 1 wheelchair place
   * and 3 seats, or as 2 wheelchair places and 1 seat), and planning *chooses* one — so the
   * setup line on an empty lane changes the moment Plan routes runs, which reads like the screen
   * contradicting itself unless it says why. Vans with one configuration say none of this.
   *
   * Each one is a clause rather than the two sentences they were until Vera's review on
   * 2026-10-17: the lane said "This van can be set up more than one way" three times over, once
   * per state, and the half that actually changes — which setup this is, and who chose it — was
   * at the end of a line nobody finishes. The word "Convertible" carries the rest now.
   */
  setUpChanges: {
    /** Nobody is in it yet, so the setup on screen is only the first one it is built with. */
    BEFORE: "Convertible: planning picks the setup that fits the riders.",
    /** The solver chose this configuration for these riders. */
    PLANNED: "Set up this way to fit these riders.",
    /** Pinned by somebody who saw the van, which outranks any configuration planning would pick. */
    SEEN: "Set up as it arrived, so planning keeps it.",
  },

  stopsHeading: "Stops, in order",
  /** "Okeeheelee Park · 6:50 AM" — the place, then the window it is planned for. */
  pickupRow: "{stop} · {time}",
  dropOff: "Drop-off",
  pickUp: "Pickup",
  /** The end of the run that is the centre rather than a child's own stop. */
  centerRow: "{what} · {stop}",
  laneFits: "Every rider in this van fits.",
  laneEmpty: "No riders in this van yet.",
  laneNeedsCheck: "Nobody boards until this van is checked.",
  laneBlocked: "Nobody boards until a coordinator approves.",
  /**
   * "At Palm Beach State College, this van has no four-point straps." — the stop first, because
   * a van that fits two children and fails on the third fails *somewhere*, and that is the part
   * a coordinator acts on. It opened on the verdict ("Doesn't fit at …") until Vera's review on
   * 2026-10-17; the chip beside it already says the verdict, so the line said it twice.
   */
  laneMissing: "At {stop}, this van has {missing}.",
  /** The same fact where the solver named no stop, so the line never reads "At the sedan, …". */
  laneMissingAnywhere: "This van has {missing}.",

  /* ── moving a child between vans ── */
  dragHint: "Drag a rider to another van, or use Move.",
  /** While a rider is held: said in the same line the answer lands in, so one place is read. */
  dragging: "Holding {child}. Let go over a van to put them in it.",
  /** Let go of a rider over nothing in particular. Nothing moved, and the line says so. */
  dragNowhere: "{child} wasn’t moved. Drop them on a van.",
  move: "Move {child}",
  moveHeading: "Which van for {child}?",
  moveTo: "Move to {vehicle}",
  moveOut: "Take out of the van",
  moveClose: "Keep where they are",
  moved: "{child} moved to {vehicle}.",
  movedOut: "{child} is not in a van now.",
  /**
   * The refusal: one line, the child by name, and the one thing that is missing.
   *
   * It opens on the child rather than on the van (Vera's review, 2026-10-17), because the child
   * is who the coordinator was moving and the van is what refused — "V3 can't take Zoe B." also
   * led with a code nobody says out loud, and `{vehicle}` is the van's own name now.
   */
  refused: "Can’t put {child} in {vehicle}: {missing}.",
  /**
   * The missing thing, as a refusal reads it. Keyed by the planner's cause so a new cause
   * cannot reach a screen without words (src/domain/solver/plan.ts `UnplacedCause`).
   */
  missing: {
    NO_WC_PLACE: "no wheelchair place",
    NO_SECUREMENT: "no {securement}",
    CHAIR_TOO_LARGE: "no wheelchair place large enough for that chair",
    NO_LIFT: "no ramp",
    NO_ANCHORED_SEAT: "no free anchored seat",
    NO_SEAT: "no free seat",
    VANS_FULL: "no free seat",
    UNKNOWN_UNTIL_ARRIVAL: "not checked yet",
    NO_VEHICLE: "no van to put them in",
    NOT_IN_A_VAN: "nobody in it yet",
  },

  /* ── the children in no van ── */
  /**
   * Two groups, because they are two different facts about a child (Vera's review, 2026-10-17).
   *
   * On first load nobody is in a van, which is not a failure — it is a screen waiting to be
   * asked. It was being drawn as the group below: a red-bordered panel headed "Not in a van yet
   * (9)", nine rows of equipment chips, and nine copies of a sentence explaining that nobody had
   * pressed the button yet. So the opening state has its own heading and its own plain list of
   * names, and the red group is kept for the children planning could not place — the case where
   * something really is wrong and the reason beside each name is worth reading.
   */
  waitingHeading: "Waiting to be planned",
  unplacedHeading: "Not in a van yet",
  /**
   * One plain sentence per child, naming them and the thing that is missing.
   *
   * The ones that end on the child carry no full stop of their own: a child is written as a
   * first name and a last initial, so "for Noah O." already ends in one and a template that
   * supplied a second would print "Noah O..". `sentence()` closes them once.
   */
  reason: {
    NO_WC_PLACE: "No van with a wheelchair place for {child}",
    NO_SECUREMENT: "No van with {securement} for {child}",
    CHAIR_TOO_LARGE: "No van with a wheelchair place large enough for {child}’s chair.",
    NO_LIFT: "No van with a ramp for {child}",
    NO_ANCHORED_SEAT: "No van with an anchored seat for {child}",
    NO_SEAT: "No van with a free seat for {child}",
    VANS_FULL: "Every van that fits {child} is full.",
    UNKNOWN_UNTIL_ARRIVAL:
      "Only {vehicle} fits {child}, and what it can carry is unknown until it arrives.",
    NO_VEHICLE: "No van is on the road today for {child}",
    NOT_IN_A_VAN: "{child} is not in a van yet. Press Plan routes, or move them into one.",
  },
  optionsHeading: "Options for {child}",
  /** The same list on a lane, where it is about the run rather than one child. */
  laneOptionsHeading: "Options",
  optionRow: "{label} — {detail}",
  /**
   * Said once under the list, and it is the only place approval is mentioned.
   *
   * Every option in it needs a coordinator — that is what the §9 option set *is* — so each row
   * used to carry a "Needs a coordinator's approval" chip, which put the same five words beside
   * five options and made the one thing that differs between them harder to find (Vera's review,
   * 2026-10-17). One note says it once, for all of them, and says the part that matters to a
   * family in the same breath.
   */
  optionsNote: "A coordinator picks one. The family hears nothing before that.",

  /* ── what arrived (VEH-02, VEH-04) ── */
  /**
   * The lane's own changes, folded away behind one control.
   *
   * What arrived and who is driving are both real questions and neither is the question a lane is
   * open for: three answer buttons, a substitution row, and sometimes a fourth button to ask the
   * provider again, all under every lane, buried the stops they sit beneath (Vera's review,
   * 2026-10-17). They are one disclosure now, closed until somebody wants them — and opened on
   * its own whenever the van has changed and the next step is inside it.
   */
  changeVan: "Change van or report",
  arrivalHeading: "What arrived",
  /** Who said what the van can carry. The provider is named, never called "the provider" (§1). */
  arrival: {
    NOT_CHECKED: "Not checked yet",
    REPORTED: "Reported by {provider}",
    RAMP_CHECKED: "Checked at the ramp",
  },
  /** When the chair that arrives is not the chair on file. */
  chairMeasure: "Measure {child}’s chair at the ramp",
  chairOnFile: "Chair on file · {length} × {width} cm",
  chairMeasured: "Chair measured at the ramp · {length} × {width} cm",

  /* ── substitution (VEH-05) ── */
  substituteHeading: "Substitution",
  substitute: "Different van today",
  substituteDriver: "Different driver today",
  /** "the substitute van · Omar T. driving" on the button that chooses one. */
  substituteOption: "{vehicle} · {driver} driving",
  /**
   * The two substitution notices. Neither opens on the van, because a van's name opens with
   * "the" and a sentence cannot: "Today the substitute van replaces the convertible van" reads
   * the way it is said, and the relief-driver line leads with the person (Vera's review,
   * 2026-10-17 — §1 "name the person", and no vehicle code either way).
   */
  substituted: "Today {vehicle} replaces {previous}, with {driver} driving.",
  substitutedDriver: "{driver} drives instead.",
  /** The provider is named on every one of these: they are somebody's answer to give. */
  askProvider: "Ask {provider} what this van can carry",
  asked: "Asked {provider} what {vehicle} can carry today.",
  recordAnswer: "Record {provider}’s answer",
  answered: "{provider} answered for {vehicle}.",

  /* ── a rider's needs ── */
  /**
   * Said once, under the Vans heading, about every rider card below it — not on each one.
   *
   * It is the same promise as the ramp check's `rampIpad.needsCaption` and it is not the same
   * string, because here it is a caption over a list rather than a line under one child's chips:
   * nine copies of "Derived from intake, not a diagnosis." was the single most repeated sentence
   * on the screen (Vera's review, 2026-10-17).
   */
  needsCaption: "From intake, not a diagnosis.",
  /** VEH-01: a need nobody has approved is on screen, and visibly not part of the plan. */
  unapprovedNeed: "{need} · not used for planning",

  /* ── the map, beside the lanes ── */
  mapHeading: "Map",
  /**
   * On a lane: bring that van's route forward on the map.
   *
   * On the lane rather than only under the map, because a coordinator reading a van is already
   * looking at the lane — and it is pressed, with a check mark, so "this is the van on the map"
   * is a word and a mark before it is a thicker line (§3).
   */
  showOnMap: "Show on the map",
  /** The §9 accessible name of the map region, which says what the map is of. */
  mapLabel: "The day’s routes",
  /**
   * What the lines are, said once over the map rather than on each one.
   *
   * The second sentence is the honest half: the demo's roads are the eight stretches its own
   * runs drive (ADR-007), and a coordinator who moves a child makes a pair of kerbs nobody
   * surveyed. Those stretches are drawn as the straight line between the two stops, and saying
   * so is cheaper than letting a reviewer believe a road was measured.
   *
   * It says it the way a coordinator reads it (Vera's review, 2026-10-17): what a straight line
   * means for the van is that nobody drew its route, and "no surveyed road" was our word for
   * our own data rather than theirs.
   */
  mapNote:
    "Each van’s stops, in the order it drives them. A straight line is direct, not the road the van will take.",
  /** The group of buttons that pick one van's route out of the three. */
  mapVansHeading: "Show one van’s route",
  /** "the center van · 3 stops" on the button that brings that van's line forward. */
  mapVanRow: "{vehicle} · {stops}",
  /**
   * Back to all three lines at full strength.
   *
   * "Show every van" read like a thing that had not happened yet beside a map already showing
   * one of them; the word that was missing is that this undoes a pick (Vera's review,
   * 2026-10-17).
   */
  mapShowAll: "Show all vans again",
  /**
   * The camera control: back out until every van's line is in the pane.
   *
   * It moves the camera and nothing else, so it says so with the verb a map is read with. "Fit
   * every van" is the cartographer's word for it (Vera's review, 2026-10-17).
   */
  mapFitAll: "Zoom to show every route",
  /** Nobody is in a van, so there is no route to draw and the map says what to press. */
  mapEmpty: "No routes yet. Press Plan routes.",

  /* ── saving the plan ── */
  /**
   * Saving is its own step, and it is not sending.
   *
   * The screen plans in the browser; this is the one thing on it that asks the server, and the
   * server re-asks the solver about every child in the plan before it keeps it, so a move the
   * screen refused cannot be saved by a request that skips the screen. So the saved
   * line says what was kept and repeats the promise the rest of the screen makes — a plan is
   * not a message, and no family has heard anything.
   */
  save: "Save plan",
  saving: "Saving…",
  /**
   * What was kept, and when — the minute the server wrote it down, in the site's own timezone
   * (`siteTimeLabel`). "Plan saved." alone left a coordinator who saved twice with no way to
   * tell which of the two the line was about (Vera's review, 2026-10-17); a real time is the
   * shortest honest answer, and the promise it carries is the one the rest of the screen makes.
   */
  saved: "Plan saved at {time}. No family has been told.",
  /**
   * Beside Save plan, whenever what is on screen is not what was last saved.
   *
   * Said in the row with the button rather than in the one line that answers a drag, because it
   * is not an answer to anything a coordinator just did — it is the state of the plan in front
   * of them, and it stays until they save it.
   */
  unsaved: "Changes not saved yet.",
  /**
   * The save did not reach the server, or the server answered something this screen cannot
   * read. It says what to do and claims nothing about what was kept.
   */
  saveFailed: "The plan wasn’t saved. Try again.",
  /**
   * A plan naming a child or a van that is not on this run. One answer for all of them — a
   * child at another site, a van on no lane today, an id that matches nothing — so the response
   * cannot be used to find out which of the three it was.
   */
  saveNotThisRun: "That plan names a child or a van that isn’t on this run.",
  /**
   * What the screen found when it opened a run: the plan last saved for it, and the minute it
   * was kept (Veri's S1, 2026-10-17 — a saved plan used to be gone on reload).
   *
   * Said as what is in front of them rather than as what just happened, because nothing just
   * happened: a coordinator who reloads the page is reading a plan, not making one. It claims
   * nothing about where the plan was kept, and nothing about anyone having been told.
   */
  showingSaved: "Showing the plan saved at {time}.",
  /**
   * Saving an empty screen over a plan that is already saved, refused.
   *
   * There is one way to reach it and it is not the button — the button cannot be pressed with
   * nobody in a van — so this is a request that skipped the screen, or a second tab a
   * coordinator never planned in. Either way, emptying a run is not a plan of it, and a plan
   * somebody made is not something to lose to one. It says what to do instead.
   */
  saveNothingPlaced:
    "There is already a saved plan. Put at least one child in a van before saving over it.",
} as const;

/**
 * The fixture's key, where a van's description still carries it: "V1 convertible van".
 *
 * The scenario writes a vehicle as its key and then what it is, and the board's projection
 * splits the two (src/domain/board/scenario.ts) — but not every caller comes through that
 * projection, and a `description` is a plain string that any fixture, replay or URL can hand
 * over. One screen printing "the V1 convertible van" is exactly the thing Vera's review is
 * about (2026-10-17), so the guard is here, on the one path every name goes down, rather than
 * repeated at the dozen call sites that ask for a van's name.
 */
const VAN_KEY = /^\s*V\d+\b[\s·-]*/;

function vanWords(description: string): string {
  return description.replace(VAN_KEY, "").trim();
}

/**
 * A van as the Plan routes screen names it: "the convertible van".
 *
 * Here rather than in the screen's own helpers because three layers need it and none of them may
 * invent it — the screen's lanes and notices, the planner's option labels (src/domain/solver),
 * and the browser check that reads a lane's name off the page. `description` is the solver's
 * plain-words field for a vehicle ("convertible van"), which is the half of the fixture's label
 * that is not the code.
 */
export function vanName(description: string): string {
  const words = vanWords(description);
  if (words === "") return planRoutes.vanUnnamed.toLowerCase();
  // Lower-cased, because this lands in the middle of a sentence and the fixtures disagree about
  // the case they write a vehicle in: the scenario says "V1 convertible van" and the interim
  // fleet fixture says "Convertible van", which gave "the Convertible van" on whichever screen
  // read the second one. A van's kind is a common noun, so there is nothing here to capitalise.
  return fill(planRoutes.vanNamed, { description: words.toLowerCase() });
}

/**
 * The same van where its name stands alone rather than sitting in a sentence: "The center van".
 *
 * Plan routes gets this for free — a lane's heading is `vanName` with its first letter raised by
 * the stylesheet (plan.module.css) — and the places that cannot do it in CSS need it as a
 * string: a MapLibre `text-field` on a map marker, the live map's own sentences about a van that
 * has no marker, the board's van column and the drawer's van line. So the words are the Plan
 * routes words, capitalised here once, and a van is called the same thing on every screen
 * (Vera, 2026-10-17: the screens say the vans' names, never "V1").
 */
export function vanTitle(description: string): string {
  // A van the fixtures named nothing is handled one layer down, in `vanName`, so the standalone
  // form of "a van" is the capitalised `planRoutes.vanUnnamed` and not a second answer written
  // here (Vera, 2026-10-17).
  const named = vanName(description);
  return named.charAt(0).toUpperCase() + named.slice(1);
}

/**
 * The JSON refusals an endpoint hands back when the caller may not run it (src/auth/api-guard.ts).
 *
 * An operator or a developer reads these in a response body, so they say which of the two
 * things happened — there is no session, or this role is not one the endpoint serves — and
 * nothing else: no role name, no route, no flag, no secret.
 */
export const apiAccess = {
  signIn: "Sign in to continue.",
  notYourRole: "This isn't part of your role.",
  /** A body or a query this endpoint cannot read at all. Says nothing about what it wanted. */
  badRequest: "That request couldn't be read.",
} as const;

/**
 * The demo-reset endpoint's answers (ADR-014, DECISION-LEDGER row 17). An operator reads
 * these, so they say what refused and why in plain words, and never name a flag, a ticket or
 * a connection detail. src/modules/demo/reset.ts chooses between them.
 */
export const demoReset = {
  previewRefusal:
    "Refusing: preview deployments share the one production database, so the demo reset is disabled here.",
  notEnabled: "Demo controls are not enabled here.",
  notSynthetic: "Refusing: this deployment is not marked as synthetic data.",
  enabled: "Demo controls are enabled.",
  signIn: "Sign in to continue.",
  directorOnly: "Only a director can reset the demo.",
  nameTheSite: "Name the site to reset.",
  /**
   * A site the caller holds no membership at — another site's id, a random id, or an id that
   * matches nothing. One answer for all three, so the response cannot be used to find out
   * which sites exist (the ID-swap rule: a uniform not-found, never "forbidden" for one and
   * "not found" for the other).
   */
  noSuchSite: "No such site.",
} as const;

/**
 * Outbound family SMS (COPY-GUIDE §1 voice, §5 "Outbound family SMS", §6 "[DEMO]" suffix;
 * 10DLC HELP/STOP reply requirement, PRD §17 D-04). A family reads these, so they live here
 * with the rest of the copy; `src/modules/messaging/templates.ts` owns the rendering — which
 * var fills which placeholder, and which of these sentences a reason code becomes.
 *
 * `reasonCode` is why the code tables are here at all. Since Veri #12 an outbound reason is a
 * fixed code rather than staff free text (`outbox.LEG_CANCEL_REASON_CODES`,
 * `CLOSURE_REASON_CODES`), and COPY-GUIDE §2 keeps enum names off family surfaces, so the
 * code has to become words somewhere — and this is where words are kept. WEATHER is in both
 * tables; the sentences are per template, so each one can read naturally in its own body.
 *
 * No body names a child. The Veri #12 rule (outbox.ts) is that an outbound var carries only a
 * fixed code or a constrained format, and a child's given name is neither: it identifies the
 * child to anyone holding the phone, and no body needs it — a guardian reads "your child", a
 * therapist reads "a child" and knows the session. So there is no `childFirstName` placeholder
 * in this table, the outbox allows no such var, and the tests check both.
 *
 * The vehicle is a "van", the word a family uses for what pulls up (COPY-GUIDE §1 plain voice),
 * not the service word "ride".
 */
export const outboundSms = {
  /** COPY-GUIDE §6: a simulated message says so, in every body, with no exception. */
  demoTag: "[DEMO]",
  optOut: "Reply HELP for help, STOP to opt out.",
  /** The center's number as the copy guide writes it (COPY-GUIDE §5 dispatcher link). */
  centerPhone: "(561) 555-0100",
  /** The fixed answer to an inbound HELP: same words every time, no child name and no van detail. */
  helpReply:
    "PPEC: This number sends van updates for your child. Call us at {centerPhone} if you need help. Reply STOP to opt out. {demoTag}",
  /**
   * The pickup places a family knows by name (MOCKS §1: public landmarks, never a home), keyed by the
   * short stop token the outbox carries. The token is a developer-facing shape and a family must never
   * read one, so this fixed table is the only way a stop becomes words: messaging/templates.ts resolves
   * `stopLabel` through it, and a token with no entry falls back to `unknownStop`. The table is code-owned
   * — nothing a coordinator types reaches it, which is what keeps the outbox's no-free-text rule intact.
   */
  stops: {
    "GA-LIBRARY": "Greenacres Branch Library",
    "OKEE-PARK": "Okeeheelee Park",
    "GA-CITYHALL": "Greenacres City Hall",
    "PRINCE-PARK": "John Prince Park",
    "PBSC-LW": "Palm Beach State College, Lake Worth",
    "LANTANA-LIB": "Lantana Public Library",
    "BOYNTON-MALL": "Boynton Beach Mall",
    "WELLINGTON": "Mall at Wellington Green",
    "PB-ZOO": "Palm Beach Zoo",
    /** The center names itself, never its street address (§5 "never … addresses"). */
    "CENTER": "the PPEC center",
  },
  /** A stop token with no copy. Vague on purpose: better than a code, and it names no wrong place. */
  unknownStop: "your usual stop",
  /** A window, §3 "windows \"8:12–8:22 AM\"". The en dash is the guide's, not a hyphen. */
  etaWindow: "{start}–{end}",
  /** One time with no window end: still an estimate, so it does not promise the minute. */
  etaApprox: "around {time}",
  bodies: {
    "pickup.eta":
      "PPEC: Your child's van is on the way to {stopLabel}. Pickup {eta}. {optOut} {demoTag}",
    "dropoff.eta":
      "PPEC: Your child's van home is on the way to {stopLabel}. Arrival {eta}. {optOut} {demoTag}",
    "leg.canceled":
      "PPEC: Got it. Your child's van on {legDate} is canceled. {reasonCode} {optOut} {demoTag}",
    "leg.changed":
      "PPEC: Your child's van on {legDate} changed. New pickup {eta} at {stopLabel}. {optOut} {demoTag}",
    "therapist.absence_alert":
      "PPEC: A child is not coming in today. The {sessionStart} session is affected. {optOut} {demoTag}",
    "therapist.late_alert":
      "PPEC: A child is running late for the {sessionStart} session. Now expected {eta}. {optOut} {demoTag}",
    "child.not_received":
      "PPEC: We could not hand off your child at {stopLabel} at {eta}. Please call us at {centerPhone}. {demoTag}",
    "center.closure": "PPEC: The center is closed on {date}. {reasonCode} {optOut} {demoTag}",
    /**
     * Fixed copy, no vars (Veri #12): a staff-typed notice could carry a child's name, so the
     * only generic message we can send is the one that asks the family to call.
     */
    "generic.notice":
      "PPEC: There is an update about your child's transportation. Please call us at {centerPhone}. {optOut} {demoTag}",
  },
  /** What a `reasonCode` says to a family, per template. */
  reasons: {
    "leg.canceled": {
      VEHICLE_UNAVAILABLE: "The vehicle is not available.",
      WEATHER: "This is because of the weather.",
      CENTER_CLOSED: "The center is closed.",
      FAMILY_REQUEST: "This is at your request.",
      SCHEDULE_CHANGE: "The schedule changed.",
    },
    "center.closure": {
      WEATHER: "This is because of the weather.",
      FACILITY: "This is a building issue.",
      HOLIDAY: "This is for a holiday.",
      EMERGENCY: "This is an emergency closure.",
    },
  },
} as const;

/**
 * The staff task a revoked consent opens (MSG-04, PRD §10). A coordinator reads these on the
 * Exceptions board, so the summary is a label and the next step is one thing to do; the
 * predicate is the condition that closes the task, which staff also read.
 * `src/modules/messaging/consent.ts` chooses between them.
 */
export const consentFollowUp = {
  STOP: {
    summary: "Family opted out of text messages",
    nextStep:
      "Record another authorized contact for van updates, or agree a phone call with the family.",
    predicate: "another authorized contact recorded for this family, or a call logged",
  },
  NL_OPT_OUT: {
    summary: "Family asked us in their own words to stop texting",
    nextStep: "Call the family to confirm what they want and record it.",
    predicate: "call logged confirming the family's choice",
  },
} as const;

/**
 * The staff-facing words of the tasks the **agent** raises (the agent runtime's §11.2 "Failure"
 * column). A coordinator reads these on the Exceptions board next to the consent ones above, so
 * they are written the same way: the summary is a label, the next step is one thing to do.
 *
 * The agent never writes any of it. A model-supplied summary reaches a task only through
 * `escalate_exception`, where it is redacted first (policy.ts `sanitizeStaffText`); everything a
 * tool raises on its own account is one of these entries, chosen by a code.
 *
 * `predicate` is the condition that closes the task and staff read it too. These are **prose**
 * predicates, which is what makes them staff-closable only: `close_task` closes a task only when
 * its predicate is one of the coded ones the agent itself writes (`run/exec/predicate.ts`).
 */
export const agentTasks = {
  /** §11.2 resolve_sender: "unknown → unknown_sender task". */
  unknownSender: {
    summary: "Text from a number we do not recognize",
    nextStep: "Identify the sender and add them as an authorized contact, or close this as a wrong number.",
    predicate: "sender identified, or the message confirmed as a wrong number",
  },
  /** §11.2 request_clarification: "≤2/thread/hour". The third question in an hour is a human's. */
  clarificationLimit: {
    summary: "The agent has asked this family twice in an hour and is still unsure",
    nextStep: "Call the family, or answer the question in the thread yourself.",
    predicate: "staff answered the question or recorded what the family wants",
  },
  /** §11.2 request_clarification: "send fail → exception". */
  clarificationSendFailure: {
    summary: "A clarification could not be queued to the family",
    nextStep: "Ask the family directly, then record their answer.",
    predicate: "family reached by another means and the answer recorded",
  },
  /** §11.2 record_acknowledgment: "DECLINED → AMBER". */
  acknowledgmentDeclined: {
    summary: "Someone declined a request we sent them",
    nextStep: "Call them to agree what happens instead.",
    predicate: "another arrangement agreed and recorded",
  },
  /**
   * §11.2 escalate_exception ("always allowed"). The *summary* on one of these comes from the
   * model, redacted; what is ours is what closing it means. The next step is chosen by code from
   * `agentNextSteps` below.
   */
  escalation: {
    summary: "The agent escalated something it may not decide",
    nextStep: "Read the thread and decide what happens next.",
    predicate: "staff resolved what the agent escalated and recorded the outcome",
  },
  /** §11.2 request_provider_capability: a provider with no dispatcher contact point to ask. */
  noDispatcherContact: {
    summary: "A provider has no dispatcher contact point, so the vehicle cannot be asked about",
    nextStep: "Call the provider for the vehicle's equipment, then record what they said.",
    predicate: "the vehicle's equipment confirmed with the provider and recorded",
  },
  /** §11.2 record_capability_report: "low confidence → staff review". */
  capabilityLowConfidence: {
    summary: "A provider's answer about a vehicle was hard to read, so it is not trusted yet",
    nextStep: "Check the vehicle's equipment with the provider, then verify it on the vehicle's day.",
    predicate: "a coordinator has verified what the vehicle can carry today",
  },
  /** §11.2 propose_contact_or_profile_change: "change request + exception". */
  proposedContactChange: {
    summary: "A family asked for a change the agent may not make",
    nextStep: "Verify the request with the family, then approve or reject the change request.",
    predicate: "change request approved or rejected by staff",
  },
  /** §11.2 propose_manifest_reallocation: "RED exception + Teams card". */
  proposedReallocation: {
    summary: "A vehicle cannot take its runs and the agent has options to show you",
    nextStep: "Review the options and commit one, or arrange transport another way.",
    predicate: "an option approved, or transport arranged another way",
  },
} as const;

/**
 * The refusals a tool reports in words as well as in a code, because a person is the one who has to
 * act on them.
 *
 * `closeTaskOpen` is §11.2 `close_task` meeting a task that is still OPEN (founder decision,
 * 2026-10-15): §6.3's machine gains no new edge, so the tool refuses — by name, never silently —
 * and the task stays a human's to resolve. The code (`TASK_NOT_CLOSABLE_OPEN`) is for the run's
 * record; this sentence is what a coordinator reads next to the step, so it lives here with the
 * rest of the staff-facing copy rather than inline in an executor (PR #35 review F10).
 */
export const agentRefusals = {
  closeTaskOpen:
    "The assistant may only close a task staff have already resolved; this one is still open, so closing it is yours.",
} as const;

/**
 * The next step on a task the model escalated, chosen by `escalate_exception`'s `next_step_code`.
 * The model picks the code; these words are ours.
 */
export const agentNextSteps = {
  STAFF_CALL: "Call the family or the provider about this.",
  STAFF_REVIEW: "Read the thread and decide what happens next.",
  DISPATCHER_PING: "Contact the provider's dispatcher.",
  APPROVAL_NEEDED: "Approve or reject the proposal attached to this.",
  NONE: "No further step; this is here so it is on the record.",
} as const;

/**
 * How a task raised by one agent step says which step it came from. Shared by every agent task
 * that needs to: a coordinator has to be able to find the step behind the work, and nothing else
 * about the machinery is theirs to read, so the run id and the tool name are not in here.
 *
 * Used by `run/tasks.ts` (a refused step) and `run/timers.ts` (a step waiting for an answer).
 */
export const agentTaskLocator = "{summary} ({trigger}, step {step})";

/**
 * The task that stands in for a run waiting on an answer (§11.1: "delayed external responses are
 * tasks with timers, never waiting sessions"). The agent is not sitting in a function — it has
 * ended, and this task plus its timer are the whole of the wait, so these are the words a
 * coordinator reads while it is open. `run/timers.ts` writes them.
 */
export const agentWaits = {
  locator: agentTaskLocator,
  nextStep: "Wait for the reply, or answer it yourself; the agent carries on when the timer is up.",
  /** What is being waited for, per await reason. */
  clarification: "Waiting for the family to say which child or which ride they mean",
  /** §11.2 notify_affected_therapist: the ten-minute acknowledgment. */
  therapistAck: "Waiting for the therapist to acknowledge a change to a child's session",
  /** §11.2 request_provider_capability: the dispatcher's answer about a vehicle. */
  capabilityReport: "Waiting for the provider to confirm what a vehicle can carry today",
} as const;

/**
 * §11.2 `summarize_thread_for_staff` ("staff-only note"). The *note itself* is the model's
 * sentence, redacted — these are the words around it: how a coordinator finds the step it came
 * from, what to do with it, and what closing it means.
 *
 * It lands as an `ops.task` row because that is the staff-visible queue this system has today; the
 * thread panel a note would otherwise sit in belongs to the staff-UI milestone. The predicate is
 * prose on purpose, so the agent can never close its own note (`exec/predicate.ts`: a predicate a
 * machine cannot read is a predicate the agent may not close).
 */
/**
 * §11.2's "no reply → escalate": the exception a deadline raises when nobody answered at all
 * (`run/exec/escalate.ts`). No model is in that path, so every word of the row is here — one entry
 * per kind of wait, chosen by the await's own reason code.
 */
export const agentNoReply = {
  locator: agentTaskLocator,
  CLARIFICATION: {
    summary: "The assistant asked a family a question and nobody answered",
    predicate: "staff reached the family and recorded what they want",
  },
  ACKNOWLEDGMENT: {
    summary: "A therapist was told about a change and has not acknowledged it",
    predicate: "the therapist reached and their acknowledgment recorded",
  },
  CAPABILITY: {
    summary: "A provider was asked what a vehicle can carry today and has not answered",
    predicate: "the vehicle's equipment confirmed with the provider and recorded",
  },
} as const;

/**
 * §11.2 `send_followup` with the `STAFF` audience. Staff are reached on Teams (§10.4) and that
 * adapter belongs to the staff-UI milestone, so what the agent can do today is put the follow-up on
 * their board: these are the words of that row, and the whole of it — unlike a note or an
 * exception, nothing here comes from the model, because a follow-up's copy is a template and there
 * is no card to render one on.
 */
export const agentStaffNotice = {
  locator: agentTaskLocator,
  summary: "The assistant has an update about a child's transport for you",
  nextStep: "Read the update beside this task, then close it.",
  predicate: "a coordinator has read the update and recorded anything that follows from it",
} as const;

export const agentNotes = {
  locator: agentTaskLocator,
  nextStep: "Read the thread, then close this once you have what you need from it.",
  predicate: "a coordinator has read the note and recorded anything that follows from it",
} as const;

/**
 * The RED task a background timer opens when it has run out of attempts: a timer that cannot
 * complete becomes work for a person rather than a silent gap. `modules/jobs/runner.ts` writes it,
 * and it is on the Exceptions board next to the agent's own tasks, so it is written the same way —
 * summary, one next step, and the condition that closes it.
 *
 * The timer's kind and key ride in the summary because they are the only way to find the thing that
 * failed; they are the one code on this board that is addressed to whoever is on call.
 */
export const timerDeadTask = {
  summary: "A background timer failed {attempts} times and has stopped retrying ({kind}, {key})",
  nextStep: "Check the timer, then run it or cancel it by hand.",
  predicate: "the timer has been run or canceled",
} as const;

/**
 * The staff tasks a refused agent step opens (PRD §11.2 exceptions). The agent stops when a step
 * is out of policy, and these are what a coordinator reads on the Exceptions board afterwards:
 * one task per thing a human now has to decide, in the same summary / next step / predicate shape
 * as `consentFollowUp`. `src/modules/agent/run/tasks.ts` chooses between them and fills `locator`,
 * which is the only place the run and the step number appear — a coordinator needs to be able to
 * find the step the task came from, and nothing else about the machinery is theirs to read.
 */
export const agentPolicyTask = {
  locator: agentTaskLocator,
  staffReview: {
    summary: "The assistant tried something it is not allowed to do",
    nextStep: "Read the refused step, then do the work by hand if it still needs doing.",
    predicate: "a coordinator has read the refused step and recorded what happens next",
  },
  identityChangeRequest: {
    summary: "A family message asks us to use a new contact or number",
    nextStep: "Call a contact already on file to confirm before anything is changed.",
    predicate: "the change confirmed with a contact already on file, or the request declined and recorded",
  },
  unknownSender: {
    summary: "A text arrived from a number we do not recognize",
    nextStep: "Identify who is texting before replying, and share nothing about a child until you have.",
    predicate: "the sender identified and recorded, or the thread closed as unknown",
  },
} as const;
