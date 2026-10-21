/**
 * Every user-facing string the app renders. Source of truth: COPY-GUIDE.md
 * (§5 microcopy per surface, §6 banner text, §6.1 source-mode labels) and
 * DESIGN-DIRECTION.md §2 (nav), §3 (state labels, which live in states.ts).
 *
 * Components must not contain user-facing string literals; a copy change is a change here.
 * Voice: calm, plain, child-first, honest about certainty (COPY-GUIDE §1).
 */
import { NEED_CATEGORY } from "@/config/equipment";

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
 * A synthetic record's name, as a person reads it: without the `SYN ` marker in front of it.
 *
 * ADR-015 stamps every synthetic row with that prefix, and it has to stay in the data — it is how
 * a query, an export or a support ticket tells a fiction from a real record, and removing it there
 * would remove the one marker that is checkable. But a *screen* has better ways of saying the same
 * thing: the DEMO bar and the §7.1 Simulated chip the root layout renders on every route, which
 * say it once, loudly, where a person is already looking. Printing it a second time inside a
 * provider's name turns a company into a code (Vera's review, 2026-10-17: "SYN Greenacres center
 * fleet" is not a thing a coordinator calls anybody), and COPY-GUIDE §2 bars internal markers from
 * user-facing text for exactly that reason.
 *
 * So this is the one seam between the two, applied where a name crosses from data into a
 * projection a screen reads — the board's rides, the solver's lanes, the phone panel's ride line,
 * the signed-in person in the header. `no-codes.test.ts` holds that none of those carries it and
 * that the fixtures still do.
 *
 * Case-sensitive and anchored: only the `SYN ` marker at the front goes. A name that merely
 * contains the letters ("Synergy Transport") is untouched, and so is one already clean.
 */
export function withoutSynPrefix(name: string): string {
  return name.startsWith(SYN_PREFIX) ? name.slice(SYN_PREFIX.length) : name;
}

/**
 * A provider's name as a screen says it — the one call every provider-display site makes.
 *
 * `withoutSynPrefix` is the general rule, and a provider is the case it kept being forgotten for:
 * the fixtures module stripped at the vehicle (src/fixtures/fleet.ts) and the demo scenario's
 * `solverVehicle` did not, so the drawer's "{van} · {provider}" line and Plan routes' "Ask …"
 * buttons printed "SYN Palm Lift Transport" at a founder (Vera's review, 2026-10-17 14:40 ET)
 * while the test that was meant to catch it read the *other* fixture list and passed.
 *
 * One named seam, so "is this name display-ready?" is a grep rather than a reading of each
 * projection: every provider name a screen reads goes through here, and `no-codes.test.ts` walks
 * the demo path as well as the fixture one.
 */
export function providerDisplayName(name: string): string {
  return withoutSynPrefix(name);
}

/** The ADR-015 marker every synthetic row's name carries. Data only; never rendered. */
export const SYN_PREFIX = "SYN ";

/**
 * Closes a sentence with exactly one full stop. Needed because §3 writes a child as first name
 * plus last initial ("Leo B."), so a template that supplied its own period would print "Leo B..".
 */
export function sentence(text: string): string {
  return /[.?\u2026]$/.test(text) ? text : `${text}.`;
}

/*
 * `siteName` ("PPEC transportation") is gone with the header that held it (audit §2 item 1, and
 * Firia 8:36 PM ET): there is no full-width band across the top of a screen at any width now, so
 * the product is named once — the brand block at the head of the rail, below.
 */
/** The centre's name and what the app is for: the one place both are written. */
const BRAND_NAME = "PPEC of Palm Beach";
const BRAND_LINE = "Transport";

export const app = {
  /**
   * THE BRAND BLOCK at the top of the labelled rail (REDESIGN-SPEC §9.2, and the founder's
   * mockups: png/shell-flow-1440.png, mockups/shell-flow.html). The centre's own name over what
   * this app is for, under a square mark carrying the name's first letter — so the 64 px icon
   * rail, which has room for the mark and nothing else, still says whose app this is.
   */
  brandName: BRAND_NAME,
  brandLine: BRAND_LINE,
  /** <title> */
  documentTitle: `${BRAND_NAME} · ${BRAND_LINE}`,
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
  /**
   * The bar reads `DEMO · Synthetic data · [Simulated] ……… [Restart demo day]` (REDESIGN-SPEC
   * §0). "Synthetic data" is what the demo *is*; the chip beside it is where this screen's data
   * came from; the button at the end is the only control in the bar. Below 768 the words are
   * dropped and the chip and the button stay — a phone has room for the two things that do
   * something and not for the sentence about them.
   */
  syntheticData: "Synthetic data",
} as const;

/**
 * THE ONE CONTROL IN THE DEMO BAR — "Restart demo day" (REDESIGN-SPEC §0, and the founder's
 * mockups, which put it at the right-hand end of the violet bar).
 *
 * It used to be "Start demo day" in the white app header, beside a readout saying "Demo day ·
 * Not started", and it did nothing: the demo-controls dock was never built, so the button was
 * rendered inert with a note saying why. A button that cannot be pressed, next to a readout of
 * a state nothing sets, is two pieces of chrome explaining each other. Both are gone; this is
 * the reset the app already has (the demo reset endpoint), wearing the bar it belongs to.
 *
 * One label, not two: whether the day has been started is a fact about the day's readiness, and
 * TODO(data-model) — docs/DATA-MODEL.md has not signed the section that says how it is read —
 * so the button says the thing that is true either way. Re-running the reset on a day that has
 * not started gives exactly the day a start would have.
 */
/**
 * The body of "Restart today?", one shape per van count (`demoDay.confirm.body` picks).
 *
 * Above the block that uses it because `bodyLines` hands these same strings on: the dialog reads
 * the sentence through `body`, and the copy suites read the words through `bodyLines`.
 */
const CONFIRM_BODY = {
  /** No vans on this day at all — the plan still goes, and the line does not count to zero. */
  none: "This clears the saved plan.",
  one: "This clears the saved plan for the van.",
  both: "This clears the saved plan for both vans.",
  /** Three and up, which is the demo centre's three: "This clears the saved plan for all 3 vans." */
  many: "This clears the saved plan for all {n} vans.",
} as const;

/** The DEMO bar's Feedback button and its one-field dialog (ledger #82). Short, like the bar. */
export const feedbackCopy = {
  button: "Feedback",
  title: "Feedback",
  label: "What should change?",
  send: "Send",
  sending: "Sending…",
  cancel: "Cancel",
  saved: "Thanks — saved.",
  failed: "Didn't save. Try again.",
  previewRefusal: "Feedback isn't saved on a preview.",
} as const;

export const demoDay = {
  restart: "Restart demo day",
  /** While the reset is running. The button keeps its place and says what it is doing (§4.2). */
  restarting: "Restarting…",
  /** The reset refused or the network did. One line, no status code, and the way on is to retry. */
  failed: "The demo day didn't restart. Try again.",
  /**
   * THE QUESTION BEFORE A RESET THROWS A PLAN AWAY (Vera's copy, 2026-10-18, verbatim).
   *
   * A reset is the one irreversible thing in the demo: it clears the saved plan for every van
   * the day runs, and a coordinator who has spent the morning building one has no undo for it.
   * So both controls that call it — "Restart demo day" in the DEMO bar and "Start demo day" on the
   * board's own strip — ask first, and only when there is a plan to lose: with nothing saved
   * there is nothing to warn about and the press goes straight through.
   *
   * "Keep plan" is the primary and holds the focus, because the safe answer is the default one
   * and Escape has to mean something: Escape is Keep plan. "Restart" is the coral one, which is
   * the only thing coral is for (src/ui/tokens.ts `alert`).
   */
  confirm: {
    title: "Restart today?",
    /**
     * The sentence, for the number of vans the day actually has.
     *
     * "all 3 vans" was typed into this file (Veri's S2 on #79), which made the one irreversible
     * question in the app the only place that still knew how big the fleet was. The count comes
     * from the van data now — `day.vans` on the board, the day's own vans in the bar — so a
     * fourth van, or a day running two, cannot leave this line claiming three.
     *
     * Four shapes rather than one template, because "all 1 vans" and "all 2 vans" are not
     * English: one van is "the van", two are "both vans", and a day with no vans at all still
     * loses its saved plan and says so without counting anything.
     */
    body: (vans: number): string =>
      vans <= 0
        ? CONFIRM_BODY.none
        : vans === 1
          ? CONFIRM_BODY.one
          : vans === 2
            ? CONFIRM_BODY.both
            : fill(CONFIRM_BODY.many, { n: vans }),
    /** The four shapes `body` picks between, as words — so the copy scans read them too. */
    bodyLines: CONFIRM_BODY,
    keep: "Keep plan",
    restart: "Restart",
  },
} as const;

/**
 * DESIGN-DIRECTION §2 nav labels. Exceptions carries a count badge once the live board lands.
 *
 * Two landmark names, because there are two menus and never both at once: `landmarkLabel` is the
 * left rail at 768 and up, `menuLabel` the bottom tab bar below it (Firia's final ruling,
 * 2026-10-17 3:08 PM ET). "Open menu" and "Close menu" went with the hamburger: a tab bar is
 * always on screen, so there is nothing to open.
 */
export const nav = {
  today: "Today",
  exceptions: "Exceptions & Approvals",
  setup: "Setup",
  health: "Health & ROI",
  /** REDESIGN-SPEC §0, menu item 5: the family thread, and the approvals waiting inside it. */
  familyTexts: "Family texts",
  /** Not a menu item (§9.2): the "For you" half of Family texts, reachable from it. */
  approvals: "Approvals",
  landmarkLabel: "Main",
  menuLabel: "Menu",
} as const;
/*
 * "More", "More destinations" and the sheet's "Close" are gone (Firia, 2026-10-17 8:36 PM ET).
 * The menu is five items at every width, so the phone's bar is five tabs and there is nothing
 * to overflow: the tab and the sheet it opened are deleted (src/ui/TabBar.tsx), and so are
 * their words. They went the way the hamburger went at 3:08 PM — a menu you have to open.
 */

/**
 * The step strip under Today's header (REDESIGN-SPEC §9.2, §9.5). The three steps of the day, in
 * order, each a link to the screen that does it. States (Done / Needed / Locked) are not shown yet:
 * TODO(data-model): they are read from docs/DATA-MODEL.md once its van / day-counts / plan
 * section is signed, and no screen decides them on its own before then.
 */
export const flow = {
  stepsAria: "Today's steps",
  steps: {
    setup: "Van setup",
    plan: "Plan routes",
    live: "Live map",
  },
  /**
   * The three words a step's chip can say (REDESIGN-SPEC §9.2's table, and §9.5's `state.*`).
   *
   * §9.2 draws a fourth, `Running`, for a live map with vans moving on it. There is no word for
   * it here because there is no fact behind it: nothing in this build records that a van has
   * left the depot, and a chip is a claim about the day. `deriveReadiness` cannot return it
   * either (src/domain/day/readiness.ts), so the vocabulary and the derivation agree.
   */
  state: {
    done: "Done",
    needed: "Needed",
    locked: "Locked",
    /**
     * §9.2's fourth chip, for a live map with vans moving on it.
     *
     * It was left out of this table while nothing in the build recorded that a van had left the
     * depot — a chip is a claim about the day, and there was no fact behind this one. The board
     * work (`plan/sql.ts dayContext.vansOut`, over `ops.telemetry_point`) is that fact, so
     * `deriveReadiness` can return `RUNNING` and the word it needs is here.
     */
    running: "Running",
  },
  /** The one line under a step's name: what that step's own data says right now (§9.5). */
  detail: {
    setup: "{checked}/{total} checked",
    planSaved: "Saved {time}",
    planNone: "Not saved",
    liveLocked: "Plan first",
    liveNeeded: "Not started",
  },
  /**
   * What a card is announced as: the step, its state and its detail, because the eye reads
   * those three as one card and the ear would otherwise hear them as three (§9).
   */
  stepAria: "{step}: {state}, {detail}",
  /**
   * A locked card opens the step that is missing rather than the step it names (§9.2: "a locked
   * card is still a link"), so its accessible name says where it actually goes.
   */
  stepAriaLocked: "{step}: {state}, {detail}. Opens {target}",
  /**
   * The menu, where it carries a count: Family texts, and the number of things waiting for a
   * person in its "For you" tab (REDESIGN-SPEC §9.2, audit §2 item 2).
   *
   * The count is said in words, because the disc that draws it is `aria-hidden` — a badge
   * reading "2" beside a thread icon is a shape, and the thing a screen reader should hear is
   * what the tab *is*: "Family texts, 2 waiting". Both rails use this one string, the 232 px
   * row and the phone's tab, so the ear gets the same sentence at either width.
   */
  tabbar: {
    waiting: "{label}, {count} waiting",
  },

  /**
   * What a screen says when the step before it is missing, and the one link that fixes it
   * (redesign spec §9.5). The board and the ramp read these; the step strip above reads the
   * two keys before them. One block, because the strip and the screens must say the same thing
   * about the same day.
   */
  banner: {
    /** An unconfirmed van is planned on its shared-config defaults (Firia/Veri, 6:00 PM ET). */
    usingDefault: "Using default setup",
    notStarted: "Day not started",
  },
  action: {
    planRoutes: "Plan routes",
    checkVans: "Check vans",
    startDemo: "Start demo day",
    /**
     * For a coordinator, who may not start the day: the day is started from the DEMO bar by a
     * director, and Today is the screen that carries the order of the day beside it (§9.2's
     * step strip). The label says where to look, because a button that answers 403 to the
     * person reading it is worse than no button (Firia's final scope, 2026-10-18 1:50 AM ET).
     */
    whereDayStarts: "Where the day is started",
  },
  empty: {
    noRoutes: "No routes yet",
    /** "9 riders · Morning" */
    ridersLeg: "{n} riders · {leg}",
    noRiders: "No riders today",
    noRidersPlanned: "No riders planned",
    noVans: "No vans yet",
    allChecked: "All vans checked",
  },
  /** The one question a board with an unsaved change asks before it is left (§9.2). */
  leave: { title: "Leave without saving?", stay: "Stay", leave: "Leave" },
  error: { load: "Couldn’t load · Retry" },
} as const;

/**
 * THE HEALTH TAB ON TODAY — four "Right now" tiles and nothing else
 * (png/health-demo-1440.png, png/health-demo-390.png; Firia, 2026-10-17: Health is these four
 * tiles on Today, not a page of its own).
 *
 * The tab says "Health", which is the word on the mockup. `nav.health` stays "Health & ROI"
 * because that is still the access-table label of the old address; this tab is not that page.
 */
export const healthNow = {
  /** The tab list, named as the screen it sits on. */
  tabsLabel: "Today",
  board: "Board",
  health: "Health",
  /** The one section heading over the four tiles. */
  rightNow: "Right now",
  kidsPlaced: "Kids placed",
  vansChecked: "Vans checked",
  runningLate: "Running late",
  needsYou: "Needs you",
  /** Every child who rides with us is in a van, or every van is checked. */
  all: "All",
  /** A tile whose count is 0 (png/health-demo-1440.png, png/health-demo-390.png). Grey, never a bare number. */
  none: "None",
  /**
   * A stored van label that starts with an internal code ("V3 sedan") is said as "Van 3".
   * The code itself is never the word on the pill.
   */
  van: "Van {n}",
  /**
   * Two or more vans still to check: how many, and not one of their names (Firia, 2026-10-18).
   * Naming the first of three reads as though it were the only one left. The last one left is
   * named instead, with `van` above — that is a van somebody can go and check.
   */
  toCheck: "{n} to check",
} as const;

/** COPY-GUIDE §5: visible label "Search", placeholder "Child, route or vehicle". */
export const search = {
  label: "Search",
  placeholder: "Child, route or vehicle",
  submit: "Search",
} as const;

/*
 * "Account" (the avatar menu's own name) and "Signed in as {name}" (the line inside the panel it
 * opened) went with that menu: the account is a *link* now — the block at the foot of the rail,
 * the 36 px disc in the page header below 768 — and it opens /whoami, which says who is signed
 * in as its own screen and carries Sign out. One identity location per width, and no panel.
 */
export const identity = {
  signOut: "Sign out",
  /** The rail's account block and the phone's avatar: one link, named as a person and a role. */
  account: "{name}, {role}",
  /** The same block for a session with no person behind it: the role, and nothing invented. */
  accountRoleOnly: "{role}",
} as const;

/**
 * A one-line notice about something the app just did for you (§9.3, §9.5 `toast.notOnMenu`).
 *
 * `notOnMenu` is the answer to a typed URL for a page this person's menu does not carry: the
 * page guard sends them to their own home and this says why, in place of the 403 card that used
 * to be the end of the road (src/auth/page-guard.ts, src/ui/NoticeToast.tsx). It is a sentence
 * for a person and not a change to what the server allows — the API still answers 403.
 *
 * No role name, no path and no status code: which page it was is not the point, and "your menu"
 * is the thing a founder can act on.
 */
export const toast = {
  notOnMenu: "Not on your menu",
  dismiss: "Dismiss",
} as const;

/*
 * The four per-adapter freshness pills ("SMS · Simulated", "Teams · Simulated", …), their group
 * label and the "Times are simulated until the live board is connected." line under them are
 * gone from the header — Vera's review, 2026-10-17 2:44 PM ET: **one** Simulated chip, the §7.1
 * one in the DEMO bar (src/ui/ScreenSource.tsx), and no second or sixth thing saying it. The
 * pill component went with them. When the live stream can carry real ages (§10) what lands is
 * an age, which is a different claim and gets its own words then.
 */

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
    /** A family texted about this ride and the drafted reply waits for a person. */
    REPLY_WAITING: "{child}'s family texted. A reply is waiting for you.",
    DOES_NOT_FIT: "{van} does not fit everyone on this run.",
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
    ANSWER_FAMILY: "Answer {child}'s family.",
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
  /** "Open Mia R., morning ride" — one opener per row, so two rows are two distinct buttons. */
  openRow: "Open {child}, {ride} ride",
} as const;

/*
 * THE SERVICE DATE USED TO HAVE WORDS OF ITS OWN, and has none now (Firia's final call,
 * 2026-10-17 7:55 PM ET).
 *
 * The board's header read `Today · Service date Sat, Oct 17 · [Demo day]`: a heading, a field
 * label for the date beside it, the date, and a tag repeating what the DEMO bar above already
 * says in violet on every screen. The founder's mockups draw one of those four — the date
 * (png/shell-flow-1440.png, png/shell-flow-390.png: `Today    [ Sat, Oct 17 ]`). So
 * `serviceDate.groupLabel` and `serviceDate.phases` are gone rather than hidden: a label on a
 * date nobody could mistake for anything else, and a tag that was the bar's sentence said twice.
 *
 * Nothing is lost from a day that is *not* the demo day either: the heading already names it
 * ("Rides for Tue, Oct 13", `board.headingOtherDay` through `onDay` below), which is the one
 * sentence that ever had to distinguish them.
 */

/** The day a heading is about: its phase, and the date it is labelled by (src/domain/board/day.ts). */
export type LabelledDay = { phase: "ENDED" | "LIVE" | "PLANNED"; label: string };

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
 * Surfaces that exist in the nav but whose data and interactions are not built yet. Each one
 * says so in its heading and then says, in one plain sentence, what it will do. No ticket
 * codes: a build-step name means nothing to a coordinator (COPY-GUIDE §1).
 *
 * Today is not in here any more: the board is built, so a sentence promising it would be the
 * one thing this table exists to prevent — a screen saying something that is not true of it.
 */
export const unbuilt = {
  /** `{page}` is the nav label, so the heading reads "Health & ROI isn't built yet". */
  heading: "{page} isn't built yet",
  exceptions:
    "This page will list what needs action, who is handling it, and when it is due.",
  setup: "This page will hold the vans, their seat layouts, and the people allowed to receive a child.",
  health:
    "This page will show whether each part of the system is working, next to the time the demo says it saves.",
} as const;

/**
 * A SCREEN THAT IS A TITLE AND ONE LINE.
 *
 * The difference between this and `unbuilt` above is what the screen is *for*. `unbuilt` is an
 * apology — "Health & ROI isn't built yet" — which was right while those three were off the
 * menu and reachable only by typing a URL. They are on the menu now (REDESIGN-SPEC §0 asks for
 * nothing to 404 from it), and a founder clicking a menu item should land on a screen, not on a
 * notice about the build. So each of these is the page's own name as its heading and one line
 * saying what it will hold — the §0 copy rule, which allows a label and at most one short line.
 *
 * No ticket codes, no dates, no promises about when (COPY-GUIDE §1): what the page is for is
 * true today; when it lands is not something this screen knows.
 */
/*
 * The four helper lines that used to sit under these four titles are gone (Firia, 2026-10-17
 * 8:36 PM ET; audit §4 item 9: "each screen keeps one title and at most one helper line", and
 * for a screen with no data a sentence about itself is not that line). Two of the four pages are
 * permanent redirects now besides — /exceptions to Today, /approvals to the tab it is — so the
 * only words left here are the link that reaches that tab from Family texts.
 */
export const stub = {
  /** The one link out of Family texts, to the half of it that is the approvals queue (§9.2). */
  approvalsLink: "For you",
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
  /** The one state chip per van (mockups/live-map.html). No ETAs on this screen. */
  chips: { onRoute: "On route", atStop: "At stop", late: "Late", noGps: "No GPS" },
  /** <title> for the route, so the tab says which screen is open. */
  documentTitle: `Live map · ${BRAND_NAME}`,
  /*
   * `intro` and `signedInOnly` are deleted (Firia, 2026-10-17 8:36 PM ET; audit §3 and §4 item
   * 9). They were the two sentences under this screen's heading — what the map is for, and that
   * its data is simulated — and a screen keeps its title and no paragraph about itself. Neither
   * fact is lost: the title is the frame's page header bar, and the one Simulated chip in the
   * DEMO bar says where the positions come from, on this screen as on every other.
   */
  /*
   * The clock, which is the DEMO bar's now rather than this screen's (Firia, 8:36 PM ET;
   * src/ui/DemoClock.tsx). The words stay under `liveMap` because the live map is the screen the
   * clock moves and the only one it is drawn on.
   */
  /**
   * THE READOUT IN THE DEMO BAR, and it is the time and nothing else.
   *
   * png/live-map-390.png and png/live-map.png both draw it as "3:24 PM" — four or five
   * characters between the Simulated chip and "Restart demo day" — and the test contract says
   * the same in words: "The clock sits inside the DEMO bar and reads as a 12-hour time (for
   * example '2:47 PM')". It used to read "Scenario clock 7:31 AM ET", which is three words and
   * a zone more than the mockup has room for: at 390 the bar overran the viewport by 36 px and
   * the readout painted over the button beside it (Vera's walk, 2026-10-18 12:30 AM ET).
   *
   * What the extra words were doing is not lost, it moved to where width is free: `clockLabel`
   * is the readout's accessible name, so a screen reader still hears what the number is while
   * the eye reads the mockup's four characters.
   */
  clock: "{time}",
  /** The accessible name of the readout above — said to the ear, never drawn. */
  clockLabel: "Scenario clock",
  pause: "Pause",
  play: "Play",
  restart: "Restart",
  /** Clock speed buttons (§6.2): ×1 / ×10 / ×60. */
  speed: "×{factor}",
  /*
   * The two motion lines went with the clock row (audit §3: "delete the helper lines, links and
   * clock row"). What they said is visible in the thing itself — the vans either slide along
   * their routes or step along them, and §9's reduced-motion rule is honoured either way
   * (src/components/map/LiveFleetMap.tsx).
   */
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

  /* ───────────────── the screen the founder's mockup draws (goal 5) ─────────────────
   *
   * mockups/live-map.html, png/live-map.png (1440), png/live-map-390.png. About 25 words
   * visible, which is REDESIGN-SPEC §3's own budget for this screen, and **no ETA among them**:
   * the words above this block are the M5 debug screen's and are being taken off the page.
   */

  /**
   * THE VAN, as a person says it: "Van 1 · Marco D.".
   *
   * Never "V1". A V-code is the database's name for a van and the test contract lints the DOM
   * for it (`/\bV\d\b/`); the number a driver and a coordinator both use is the one painted on
   * the door. The driver is first name + family initial, through the one name helper
   * (src/ui/display-name.ts `shortName`), so this screen cannot write a person's name a second
   * way.
   *
   * The two halves are also drawn apart — the number in ink, the driver muted beside it, as the
   * mockup draws them — so this string is the row's *accessible name*, which is the one place
   * the two are one phrase.
   */
  vanName: "Van {number} · {driver}",
  /** Just the number, which is what the eye reads first in the list and on the map pin. */
  vanNumber: "Van {number}",

  /**
   * The line under a van's name: where it is going and who is still aboard. The mockup's
   * "John Prince Park · 2 kids" — no ETA, no "+12 min", no clock.
   */
  vanNext: "{stop} · {kids}",
  /**
   * A van with nothing left to arrive at: every stop driven, on its way back to the centre.
   * The row still says something true rather than printing " · 0 kids" after an empty space,
   * which is what an unguarded "{stop} · {kids}" renders at the end of a run.
   */
  vanNextDone: "All stops done",
  kids: "{count} kids",
  kidsOne: "1 kid",

  /**
   * How far along the run is, for the stop-progress bar. The bar is a picture of the same fact
   * the chip and the next stop already carry in words (§9: never a graphic alone), so this is
   * its accessible name rather than a visible string.
   */
  progress: "Stop {done} of {total}",

  /**
   * The counts at the top, which are also the filters. "1 on route · 1 late · 1 no GPS" in the
   * mockup, and each is a filter in the list's own row ("All 3 / Late / No GPS").
   *
   * There is no "At stop" count and no "At stop" filter, which is the mockup: a van at a stop is
   * a van that is fine, so the header counts the two things a coordinator acts on and the one
   * that is simply running.
   */
  countOnRoute: "{count} on route",
  countLate: "{count} late",
  countNoGps: "{count} no GPS",
  filterAll: "All {count}",
  filterLate: "Late",
  filterNoGps: "No GPS",
  /** The filter row is a group of toggles, so it needs a name of its own (§9). */
  filterLabel: "Show vans",
  /** When a filter leaves the list empty, the list says so rather than being blank. */
  filterEmpty: "No vans in this filter.",

  /** The list of vans, as a region a screen reader can jump to. */
  vansHeading: "Vans",

  /** The feed under the list: what went out to families, time first. Never an ETA. */
  feedHeading: "Auto texts",
  /** The row's middle column: who it went to, and which van it was about. */
  feedWho: "{family} · {van}",
  feedEmpty: "No family text yet today.",
  /** The leg switch in the header bar needs a name of its own, being a group of two (§9). */
  legLabel: "Which leg",

  /**
   * The map's legend, which is the four chips again as four marker shapes — so the colour of a
   * marker is never the only thing that says what it means (§3, §9).
   */
  legendHeading: "What the markers mean",

  /**
   * MAP CREDITS, collapsed behind an (i) that opens them.
   *
   * ADR-008 and §5.1 require the basemap's attribution to be present and never removed; the
   * founder's mockup has no licence text across the bottom of the map. Both hold at once the way
   * MapLibre itself does it: the credits are always in the page, behind a labelled button, and
   * one click opens them. The label is the button's accessible name — the button's face is the
   * letter i — so this is the one place the words exist.
   */
  credits: "Map credits",

  /**
   * LOCKED UNTIL A PLAN IS SAVED (REDESIGN-SPEC §9.1: "Plan saved -> Live map" is a *hard*
   * gate). No saved plan for this leg means no routes to draw, so the map shows the centre and
   * this card over it — never a blank map, and never an invented route.
   */
  lockedHeading: "No routes yet",
  lockedBody: "Save a plan for this leg and the vans show up here.",
  lockedAction: "Plan routes",
  /** The same fact for a role whose menu does not carry Plan routes (front desk). */
  lockedBodyNoPlanAccess: "A coordinator saves the plan, and the vans show up here.",
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

/**
 * The account page: who you are signed in as, in one line.
 *
 * It used to carry `membership: "{role} at site {siteId}"` — a role *key* and a site UUID, on
 * the grounds that a developer surface may show internals (COPY-GUIDE §2). It is not a
 * developer surface: it is in the frame, on the menu's own account route, and a founder opens
 * it in front of a customer. So the enum and the id are gone and what is left is the person and
 * their role in the words the rest of the app already uses (`roleNames`).
 */
export const whoami = {
  heading: "Signed in",
  /** "Dana M. · Director" — the §3 middle dot the board and the drawer already join with. */
  separator: " · ",
} as const;

/**
 * Family texts (DESIGN-DIRECTION §6.3 "Persona phones", COPY-GUIDE §5): the texts the demo sends
 * to a family, read as a family reads them.
 *
 * Named `familyTexts`, after the screen and its address — `/family-texts`, Vera's review
 * (2026-10-17): "preview" is out of every label and address, and one name in the rail, at the top
 * of the page and in this file cannot drift (src/ui/nav-items.ts reads `heading` for the rail).
 *
 * Two kinds of sentence live here, and the difference matters:
 *  - the **thread's own chrome** — who the phone belongs to, which child the texts are about,
 *    which van the ride is on. Staff-facing, so people are named (COPY-GUIDE §1): "Dara O. is
 *    Noah's parent" is a thing a coordinator can check, "an adult on file" is not.
 *  - the **source line**, which says where the bubbles came from. The panel can read the real
 *    message log or project the demo day's own replay, and a thread that did not say which it was
 *    showing would be the one screen in this app that could be mistaken for a real send.
 *
 * The *messages* themselves are not here: a body belongs to `outboundSms` above, because it is
 * the outbox that owns the words that leave the building (Veri #12). Nothing in this block ever
 * appears inside a bubble. And no outgoing body names a child — Vera's privacy rule, 2026-10-17:
 * the panel's own UI labels a thread by child, because staff are reading it, but a text to a
 * phone says "your child". `templates.test.ts` holds that against the fixture first names.
 */
export const familyTexts = {
  /** Under a family's text the fast model read as nothing to change (ledger #85, SURF-03). */
  triage: { FYI: "FYI · nothing to change", NOISE: "No action needed" },
  heading: "Family texts",
  documentTitle: "Family texts · PPEC transportation",
  intro:
    "What the demo sends to a family's phone, on the day it sends it. Nothing here leaves the building.",
  /** §6.3: the phone carries its own banner, under the one in the header. */
  simulatedPhone: "Simulated phone",
  /** The tab list: one phone per family the day has a text for. */
  pickPhone: "Whose phone",
  /** A tab, "Dara O. · Noah". */
  tab: "{adult} · {child}",
  /** The phone's own heading: who holds it, and the number it is reachable on. */
  threadHeading: "{adult} · {phone}",
  /**
   * A number as a person reads it, in the form the rest of the copy already uses for the
   * center's own line ("(561) 555-0100"). The fixtures store a dialling form; no screen prints
   * one.
   */
  phoneFormat: "({area}) {prefix}-{line}",
  /** One line under it, naming the relationship rather than describing it. */
  threadWho: "{adult} is {child}'s {relationship}.",
  /** The ride these texts are about: the van by name, and who runs it. */
  rideLine: "{child} rides home in the {van}, run by {provider}, to {place}.",
  /** The day the thread is from — the same date the board names (PRD §6.1). */
  dayLine: "Texts from {date}",
  /** Read before the time under a bubble, for a screen reader (§9). */
  timeLabel: "Sent {time}",
  /** The two sources, each said plainly. */
  fromLog: "These are the messages the center sent, with what happened to each one under it.",
  /**
   * Vera's wording, verbatim (2026-10-17): short sentences, no "delivery status is not shown
   * because" clause-stacking. Says the same two facts — these are unsent drafts, and that is why
   * there is nothing under them.
   */
  fromScenario:
    "The demo day hasn't run yet, so these are the texts it will send. There's no delivery status because nothing has been sent.",
  /**
   * The message log could not be read at all (`thread.ts` → `logUnreadable`). Distinct from
   * `fromScenario` on purpose, and that distinction is the whole of Veri's S3 note: "the demo day
   * hasn't run yet" is a claim about the *day*, and saying it when the truth is "we could not read
   * your message log" tells a coordinator something false about their own data. So this says which
   * of the two it is, says what is on screen instead, and asks for nothing a person cannot do.
   */
  logUnreadable:
    "We couldn't read the message log just now, so these are the texts the demo day sends rather than what was actually sent. Try again in a moment.",
  empty: "No texts to this family on this day.",
  /**
   * A day the demo sends no family text at all. Vera's wording (2026-10-17) replaces "Today isn't
   * built yet", which told a founder about the build rather than about the day.
   */
  emptyDay: "No family texts today.",
  /**
   * The live pair at the bottom of the thread: what a coordinator just typed as the family, and
   * what the assistant answered once a person approved it (`LiveBubbles.tsx`).
   *
   * `liveNote` is the one thing that keeps the thread honest. The bubbles above it are rows from
   * the message log with real times and §3 delivery ticks; these two have neither, and a reader who
   * was not told why would reasonably assume the screen had simply lost them.
   */
  liveHeading: "This session",
  liveNote: "From this session, on the simulated phone. Nothing was sent, so there is no time or delivery under them.",

  /* ── the assistant half (PRD §18.2 steps 9–10): a parent's text, and what came back ── */

  /**
   * The composer. It is staff typing *as the family*, on a simulated phone, so the label says so
   * — a coordinator must never be in doubt about which side of the thread they are writing on.
   */
  composerHeading: "Send a text as {adult}",
  composerLabel: "Message",
  composerHint: "This is the simulated family phone. Nothing is sent to anybody.",
  composerExample: "Can {child} be dropped at grandma's at 5?",
  composerSend: "Send as {adult}",
  composerSending: "Sending…",

  /** The card that appears under the thread: what the assistant did with the text. */
  turnHeading: "What the assistant did",
  /**
   * Who answered. Vera's wording (2026-10-17 14:40 ET): a staff screen says "the assistant",
   * because that is who a coordinator thinks they are reading. It used to name the model by its
   * id — "claude-…" — which is a deployment setting, not a fact about this reply: it tells a
   * coordinator nothing they can act on and reads as a leaked config value on a screen a founder
   * demos. The id stays where a reviewer actually checks it, in the run's server-side record.
   */
  answeredByModel: "Answered by the assistant.",
  /** §11.2: a human-tier call is a proposal. It changed nothing and sent nothing. */
  proposalLead: "The assistant proposes this. It has changed nothing and sent nothing.",
  /** The change itself, in one line a coordinator can check against the board. */
  proposalChange: "Move {child}'s afternoon drop-off from {before} to around {after}, at the same stop.",
  proposalNoChange: "The assistant has raised this for a person to read.",
  declined: "Declined. Nothing changed, and the family was not texted.",
  /** After approval: what changed, and why the reply needed no second decision. */
  approvedLead: "Approved. {child}'s afternoon drop-off now reads {after}.",
  approvedBoardLine: "{child} · afternoon · {van} · {after} at {place}",
  approvedReplyNote:
    "The confirmation below went out on the assistant's own authority: it is one of the messages we allow, filled in with a time and a place. Free text to a family still needs a person.",
  /** A turn the gateway or the policy engine refused. */
  blockedLead: "The assistant's answer was refused before anything happened.",
  /**
   * No model answered. One sentence for every way that happens — rate-limited, slow, no key, a
   * base URL off the allow-list — because from a coordinator's chair they are one situation with
   * one next move, and there is no longer a second reader that could have answered instead (the
   * founder's rule of 2026-10-17 deleted the §18.1 keyword parser). So this says what did not
   * happen and what to do, and the screen shows it in place of any proposal card: nothing was
   * read, so there is nothing to approve.
   */
  assistantUnavailable:
    "The assistant could not be reached, so nothing happened: no ride changed and no message was sent. Try again in a moment, or answer this text yourself.",
  /** Said under a refusal and under a blocked turn alike: the rule, in plain words. */
  nothingHappened: "No ride changed and no message was sent.",

  /* ── the rebuilt screen (REDESIGN-SPEC §4; mockups/family-texts.html, mockups/approvals.html) ── */

  /**
   * The three tabs over the conversation list. "For you" is the approvals queue — REDESIGN-SPEC
   * §9.2 keeps it a tab of this screen rather than a menu item of its own, so the words are the
   * tab's and there is no second page title anywhere.
   */
  tabForYou: "For you",
  tabSent: "Sent",
  tabAll: "All",
  /** The chip in the header: the assistant is reading replies on this day. */
  /** The list, for a screen reader that is picking one. */
  conversationsLabel: "Conversations",
  /** A row that has something on it nobody has read yet (§9: never the teal dot alone). */
  unread: "Unread",
  /** The thread's own header: the adult, then who they are and which child. */
  threadSubtitle: "{relationship} · {child}",
  /** A list row names the child beside the adult: "Lee W. · Jonah" (approvals.html `.th .nm`). */
  rowChild: " · {child}",
  /** The identity check that passed on this number, as a chip on the thread header. */
  verified: "Verified",
  /** The call control on the thread header, which places no call in the demo. */
  callLabel: "Call {adult}",
  /** 390: the thread is a view of its own, and this goes back to the list. */
  backToList: "Back to the conversations",
  /**
   * The centred stamp above a run of bubbles (the mockup's `.ts`). "Today" on the demo day and
   * the date on any other, which is the §5 rule every other heading on this day follows
   * (`onDay`): a thread from last Tuesday that said "Today" would be the screen lying about when
   * a family was texted.
   */
  stampToday: "Today",
  stampOtherDay: "{date}",
  /** Under a run of outgoing bubbles the day sent by itself, from a template. */
  autoDelivered: "Auto · Delivered",
  /** Under a run of outgoing bubbles a person wrote and sent. */
  staffSent: "Sent by {name}",
  /** The compose bar at the bottom of a thread. */
  composePlaceholder: "Text {adult}",
  composeAction: "Send",
  /**
   * Pressing Send approves the proposal that is open, because a person pressing Send *is* the
   * approval (Firia's gate 3). With nothing open there is nothing for it to send: free text to a
   * family is not wired, and the control says so rather than looking live.
   */
  /** The state pill on a conversation row. Five, and every one of them is a fact about the row. */
  rowState: {
    changeReady: "Change ready",
    needsYou: "Needs you",
    autoLate: "Auto · Late",
    autoDropped: "Auto · Dropped",
    done: "Done",
  },
  /**
   * A PARENT WHO CAN'T BE HOME AT THE ETA (ledger #78) — what the demo's "Simulate parent text"
   * sends, through the same inbound path a real text takes. Filled from the day: the child's
   * estimated drop-off, and a later time. The scenario's input, never read back by the app.
   */
  parentCantReceive: "Hi, I won't be home at {eta} for {child}. Can you bring them at {later} instead?",
  simulate: {
    button: "Simulate parent text",
    nextDropoff: "Next drop-off",
    pick: "Which family",
    sending: "Sending…",
    noPlan: "Save the afternoon plan first.",
    noRider: "Nobody's on a van this afternoon.",
    notSent: "Couldn't send it. Try again.",
  },
  /**
   * THE REPLY WHEN NO MODEL ANSWERED — the demo day's card, drafted from copy instead of by the
   * assistant (Firia, 2026-10-18 11:04 AM ET).
   *
   * The card the walked demo opens on is written by the real model turn
   * (`demo/draft-proposal.ts`). A model that errors or takes longer than the drafting timeout
   * leaves the demo needing a card anyway — Restart must always finish — so this is the sentence
   * that goes in it: the same answer in the same voice, naming the parent, the child and the time
   * they actually asked for, rather than the fixed template's "gets off at {stopLabel} today",
   * which is the sentence the founder's complaint was about.
   *
   * Filled here, by `fill`, from the day's own fixtures — never by a caller and never by a model.
   * It is code-owned copy on the staff-approval path, so it reaches a family only if a
   * coordinator approves those exact words, and `messaging/reply-text.ts` holds it to the same
   * shape it holds the model's own reply to (no codes, no tokens, no `PPEC:` prefix).
   */
  dropoffReplyFallback:
    "Hi {parentName}, yes, we'll drop {childName} off at {eta} today. Thanks for letting us know!",
  /** A tab with nothing in it. One line, and it is about the day rather than the build. */
  noneForYou: "Nothing is waiting for you.",
  noneSent: "No texts have gone out today.",

  /* ── the third pane: the van and the pick-up, beside the thread (approvals.html `aside.ctx`) ── */

  /** "Van 1 after change" — the counts a coordinator is approving the ride into. */
  afterChange: "after change",
  /** The pane's last heading: who the family's file lets collect this child. */
  allowedPickup: "Allowed pick-up",
  /** The pane's own label, for the landmark a screen reader lands on. */
  rideContext: "This ride",
} as const;

/**
 * The approval screen (PRD §18.2 steps 9–10, §11.2 human tier): a coordinator reads the exact
 * text a parent would get, and decides.
 *
 * Every string is Vera's, verbatim (2026-10-17 12:59 PM ET). Three things she settled, and each
 * one is a rule rather than a preference:
 *  - the buttons say what happens, not what the system calls it: "Approve and send" (not
 *    "Approve", which leaves "and then what?" open), "Don't send" (not "Decline" or "Reject",
 *    which name a verdict on the assistant rather than an outcome for the family).
 *  - `nothingUntilApproved` is on the screen *before* either button, because the fear a
 *    coordinator brings to this screen is that reading it already sent something.
 *  - on model failure the screen still works: a person writes the reply. `draftFailed` says that
 *    in two short sentences and offers both ways out.
 */
export const approval = {
  /**
   * THE CARD'S ACCESSIBLE NAME, and the only sentence on it that says what it is.
   *
   * Vera's card (Firia, 2026-10-18 7:51 AM ET) is three things and no more: the parent's name,
   * the message as a bubble, and the three buttons. There is no heading over the message any
   * more — "The text the family will get" was a label on a bubble that already looks like a
   * text — so a screen reader would otherwise reach a region named only "Dara O.", which is also
   * what the thread around it is called. This is the name the region carries instead.
   */
  cardLabel: "Proposed reply to {adult}",
  /*
   * There is NO key here for the STOP/HELP footer, and that absence is the ruling (Firia, 10:51
   * PM ET): the 10DLC sentence is appended by the send step alone (`SEND_FOOTER`,
   * src/modules/messaging/templates.ts) and is never shown to staff — not in a bubble, not on the
   * card. A copy key for it would be the first half of putting it back.
   */
  nothingUntilApproved: "The family hears nothing until you approve",
  /**
   * The three controls, worded exactly as mockups/approvals.html `.acts` words them (Firia
   * relaying Vera, 2026-10-18 7:51 AM ET). The ampersand is the mockup's, and it is the house
   * style for a two-verb control: `nav.exceptions` is "Exceptions & Approvals" for the same
   * reason. Every screen that renders one of these reads the constant, so the mockup and the
   * build cannot drift apart a word at a time.
   */
  approveAndSend: "Approve & send",
  edit: "Edit",
  dontSend: "Don't send",
  draftFailed: "Couldn't draft a reply. Write one yourself or try again.",

  /* ── the screen around the card (SURF-05, PRD §14 "Exceptions & Approvals") ── */

  /**
   * The screen's `<title>`. Its **heading** is `nav.exceptions`, not a string of its own: the rail
   * already names this destination, and a page whose h1 said "Exceptions & approvals" under a rail
   * that said "Exceptions & Approvals" is one screen with two names (nav-items.ts keeps every other
   * destination's label and heading as one string for exactly this reason).
   */
  documentTitle: "Exceptions & Approvals · PPEC transportation",
  intro: "What the assistant has asked a person to decide. Nothing here has been sent.",
  /** A day with nothing waiting. Said as a fact about the day, not about the build. */
  none: "Nothing is waiting for a decision.",
  /** The card's own heading: whose ride, and which half of the day. */
  cardHeading: "{child} · {ride} drop-off",
  /** The reason the family gave, as a coordinator reads it — never the enum code (§2). */
  reasons: {
    PARENT_REQUEST: "A parent asked for this.",
    ALTERNATE_RECEIVER: "A different adult is collecting the child.",
    APPOINTMENT: "The family has an appointment.",
    SCHEDULE_CONFLICT: "The family has a conflict at the usual time.",
    OTHER: "The family asked for a change.",
  },
  /** The Edit state's text box: the reply's own words, which Approve & send sends as typed. */
  editLabel: "Your reply",
  /** Under the box: the reply rule (`messaging/reply-text.ts`), in the words a person needs. */
  editHint: "One short line. No links, phone numbers or addresses.",
  /** Leaves the Edit state with nothing changed: the drafted reply is back on the card. */
  editCancel: "Cancel",

  /* ── what came back ── */

  sent: "Approved. The family is being texted now.",
  /** Approved with nobody to text: every contact is opted out or unauthorized (§6.4, outbox policy). */
  sentToNobody: "Approved, and the ride is changed. Nobody on this family's file may be texted, so no message went out.",
  declined: "Not sent. Nothing changed, and the family was not texted.",

  /* ── the refusals, each one a sentence rather than a status code ── */

  signInAgain: "Your sign-in has expired. Sign in again and the decision is still here.",
  notYourRole: "Your role cannot decide this one. Ask a coordinator or the director.",
  /** Another site's id and an id that exists nowhere read the same, on purpose. */
  noSuchApproval: "That decision is not here any more.",
  alreadyDecided: "Somebody decided this one already. Reload to see what they chose.",
  /** Edit on a card whose words are fixed copy (`decide.ts` NOT_EDITABLE). */
  notEditable: "This message can't be edited. Approve it as it is, or don't send it.",
  /** The edited words break the reply rule (`decide.ts` EDIT_NOT_SENDABLE). Nothing was sent. */
  editNotSendable: "That reply can't be sent: keep it to one short line with no links, phone numbers or addresses. Nothing was sent.",
  /**
   * The words changed under the person deciding them (S1-7). Said as what happened and what to do,
   * like every other refusal here — and it says plainly that nothing went out, because the first
   * thing a coordinator wants to know is whether the family got the old text.
   */
  messageChanged: "This message changed while you were reading it. Nothing was sent — read it again and decide.",
  // A change the plan would not take is said in the board's own words, with the place to fix it:
  // `refusal` below and `modules/changes/refusal.ts` (ledger #80).

  /* ── the card itself (mockups/approvals.html) ── */

  /*
   * There is NO title key for the card. Vera's card is named by the family it answers — the
   * parent's name is its heading and `cardLabel` above is its accessible name — so "Change
   * drop-off" was a kind-of-thing label over a message that already says what it is. The kind
   * still exists where it belongs, as `DROPOFF_CHANGE_KIND` on the row.
   */
  /**
   * WHO THE PROPOSAL IS FROM — one word, and it is this one.
   *
   * Vera's S1-2 checklist item a (2026-10-18): "Each proposal has ONE approve row, labelled
   * 'Agent' (from copy.ts), with no internal codes and no vendor or provider names." So the card's
   * author is "Agent", which is also the name the mockup gives this actor where it names it at all
   * (mockups/approvals.html: `<h3>Agent</h3>` over the same feed) — the card line there still read
   * "Assistant", and the checklist is the later word on which of the two the product says.
   *
   * What it must never be is the thing underneath. A coordinator deciding whether to text a family
   * is not helped by the name of a model or a router, and a card that said one would be leaking a
   * deployment detail onto a staff screen — and dating itself the next time the deployment
   * changes. The provider is configuration (`agent/config.ts`), it stays in the server log, and
   * the assertion that keeps it off the card is in real-card-only.test.ts.
   */
  agentLabel: "Agent",
  /**
   * Who drafted it and when.
   *
   * NOT on the card: Vera's card carries no clock time at all (the "NO Time row" half of the
   * 7:51 AM ruling), and a "Agent · 3:58 PM" line is a clock time wherever it sits. The queue
   * still builds it (`family-texts/queue.ts`) because the author and the minute are facts about
   * the row, and `real-card-only.test.ts` reads them to prove the card came from a real approval
   * rather than a fixture.
   */
  draftedBy: "{agent} · {time}",
  /*
   * There are NO keys here for a Stop / Time / Pick-up before→after table. Vera's card does not
   * draw one (7:51 AM ET): the message says what changes, in the words the family will read, and
   * a table above it was the same change said twice — the second time in a shape only somebody
   * who already knew the plan could check. The facts themselves are still computed and still
   * asserted (`queue.ts`, `real-card-only.test.ts`); what is gone is the row.
   */
  /**
   * THE CARD'S HEADING — "Reply to Dara", and no robot (Firia, 11:11 AM ET 2026-10-18).
   *
   * What it replaces: a `Bot` icon beside the parent's bare name. Two things were wrong with that
   * row. The icon said *who wrote the draft*, which is a fact about the build and not about the
   * decision, and the name alone said nothing at all about what the card is for — a coordinator
   * reading "Dara O." over a bubble has to infer that pressing the button texts her. The heading
   * now says the act: this is a reply, and it goes to this parent. First name only, because the
   * thread it sits in is already that family's.
   */
  replyTo: "Reply to {parent}",
  /**
   * ONE LINE OF WHAT CHANGES, under the draft (same ruling).
   *
   * The card used to say what would change only inside the words the family gets, which is the
   * right place for a family and not enough for the person approving it: Approve now moves the
   * plan — the leg's drop-off time, the van it stays on, the receiver on the file — and a
   * coordinator signs for that, not just for the sentence. So this is the plan's own words for the
   * same change, from the proposal and the placement the plan actually holds (`queue.ts`), and it
   * is one line because the Stop / Time / Pick-up table it is the descendant of was three too
   * many (Vera, 7:51 AM ET).
   */
  changeLine: "{child}: drop-off moves to {time} on {van}.",
  /** The pick-up row when the adult collecting the child does not change. */
  pickupSame: "{adult} · same",
  /** The checks that passed, as chips. Each is a fact the plan can answer. */
  checkSameVan: "Same van",
  checkFits: "Fits",
  checkOnFile: "{adult} on file",
  /**
   * ONE LINE OF WHAT CHANGES IN THE PLAN (Firia, 2026-10-18 11:15 AM ET), on the card as it is
   * drawn **in the agent bubble**.
   *
   * It is not the before→after table the note above deleted, and the difference is the whole of
   * why this key exists. The table said the same change twice in a shape only somebody holding
   * the plan could check; this is one sentence of what the plan would do, under the words the
   * family would read. In Family texts the card sits inside the thread, where the parent's own
   * message is two inches above it and the context pane is beside it — so the card there passes
   * no line and draws none (`ProposalCard`'s `changeLine` is optional). In the bubble there is no
   * thread and no pane: a coordinator is looking at one alert on top of whatever screen they were
   * on, and "what does this do to the ride" is the one fact they would otherwise have to leave
   * the panel to get.
   *
   * Both halves are the proposal row's own fields through the queue's own view — the time it
   * asked for and the stop it names — and never a sentence read out of anybody's words.
   */
  planChange: "In the plan: drop-off moves to {time}, at {stop}.",
  /** The same line for a proposal that moves only the place, which has no time to name. */
  planChangeStop: "In the plan: drop-off moves to {stop}.",
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
  /** Says plainly that this surface records nothing, so nobody waits for a send that never happens. */
  /*
   * "Nothing here is sent. Answers stay on this iPad." is deleted (Firia, 2026-10-17 8:36 PM
   * ET; audit §4 item 9): it was the explanatory sentence under the screen's heading, and a
   * screen keeps its title and no paragraph about itself. What it was honest about is still
   * said — the one Simulated chip in the DEMO bar says where this data comes from, on this
   * screen as on every other.
   */

  arrivalsHeading: "Which vehicle is at the ramp?",
  /** §5: the vehicle tile reads "V1 · Provider P1 · arriving 8:52 · 3 riders", over two lines. */
  vehicleTile: "{vehicle} · {provider}",
  vehicleTileDetail: "arriving {time} · {riders} riders",

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
  retry: "Retry",
  /*
   * THE VEHICLE CARD'S WORDS ARE DELETED — `vehicleRow` ("{id} · {description}"),
   * `vehicleMeta` ("{owner} · {state}"), `gps`, `source`, `stopped`, `fitAll`,
   * `vehiclesHeading`, `locationLost` and `stopFamily`.
   *
   * They were #53's debug screen's, and they rendered the three things Vera's walk of
   * 2026-10-18 12:30 AM ET ruled off the screen: "V1 · Convertible van" (a V-code and a vehicle
   * description), "Provider P1 · In transit" (a vendor) and "V2 · Live 2 s". The components that
   * printed them — src/components/map/{FleetMap,LiveFleetMap}.tsx — are deleted with this slice,
   * and a template whose first placeholder is an internal id is not a string to keep lying
   * around for somebody to reach for.
   *
   * A van is written one way now, and it is the founder's: "Van 1 · Marco D." (`liveMap.vanName`,
   * over the frame's one name helper). No id, no description, no provider — the demo shows no
   * vendor name at all (REDESIGN-SPEC §6 item 5).
   */
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
  /**
   * The thread, from the child it is about (DESIGN-DIRECTION §4.2 is a list of sections and this
   * is the one the §6.3 panel answers): a coordinator reading a late ride wants to know what the
   * family was actually told, and the words are one click away rather than paraphrased here.
   */
  textsHeading: "Texts to the family",
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
  /**
   * The link to the phone panel, named for whose text it opens. Vera's wording, verbatim
   * (2026-10-17): "See the text {child}'s family got" described the destination, while this one
   * says what the link does and names the screen it opens by the name the rail and the page both
   * use ("Family texts"), so a coordinator who clicks it recognizes where they have arrived.
   */
  openTexts: "Open {child}'s family texts",
  noTexts: "Nothing has been texted to {child}'s family today.",
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
  // The five the product reads and writes are keyed from the one shared list
  // (src/config/equipment.ts), so a category cannot be spelled two ways (Veri's gate, 7:27 PM ET).
  [NEED_CATEGORY.wheelchair]: "Wheelchair securement",
  LIFT_OR_RAMP: "Boards by lift or ramp",
  [NEED_CATEGORY.carSeat]: "Car seat or booster",
  [NEED_CATEGORY.harness]: "Harness or vest",
  [NEED_CATEGORY.nurse]: "Attendant rides along",
  SEATING_SEPARATION: "Seated away from another rider",
  MAX_RIDE_TIME: "Longest time on the van",
  EQUIPMENT_DIMENSIONS: "Chair size",
  MEDICAL_DEVICE_POWER: "Device that needs power",
  [NEED_CATEGORY.oxygen]: "Oxygen",
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
    /*
     * These three named a van with `vanName(vehicle.description)` ("the convertible van"), the
     * copy helper the rebuild removed: a van has one name and it comes from its slot
     * (src/config/vans.ts `vanNameOf`). The solver's own vehicles are not always one of the
     * centre's numbered vans, so the options say "another van" rather than guessing a number.
     * Nothing renders these today — the two screens that did were rebuilt (§1, §2).
     */
    SPLIT_RUN: {
      label: "Split the run",
      detail:
        "Run {who} separately on another van. Everyone already on the vehicle stays where they are.",
    },
    ALTERNATE_VEHICLE: {
      label: "Move to another van",
      detail: "{description} ({provider}) fits {who} as {layout}.",
    },
    ALTERNATE_PROVIDER: {
      label: "Move to another van",
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
  documentTitle: `Plan routes · ${BRAND_NAME}`,
  /*
   * The old screen's subtitle and its "Which run?" radio — "{date} · morning pickups" and
   * "afternoon drop-offs" — are gone with the screen that printed them (Firia, 2026-10-18
   * 1:28 AM ET). The two words of the leg toggle stay: the Live map's own Morning | Afternoon
   * control reads them (#77, src/modules/live-map/LiveMapScreen.tsx), and the board's toggle
   * reads `planBoard.morning` / `planBoard.afternoon`. Either way the pair switches between the
   * two saved plans a day has (DATA-MODEL §1, `plan_run` per direction).
   */
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
  /** The same fact where the solver named no stop, so the line never reads "At the sedan, …". */
  laneMissingAnywhere: "This van has {missing}.",

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
  optionsHeading: "Options for {child}",
  /** The same list on a lane, where it is about the run rather than one child. */
  laneOptionsHeading: "Options",
  optionRow: "{label} — {detail}",

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
  /**
   * The map with nothing to draw. Four words, and the §9.5 string every other screen uses for the
   * same state — it used to end "Press Plan routes", which named a button the redesigned board no
   * longer has (its first step is Auto-plan, §1.2) and told a coordinator to press the screen they
   * were already on.
   */
  mapEmpty: "No routes yet",

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
} as const;

/**
 * The equipment every screen counts in, in one place: the plan board's meters and steppers, and
 * the ramp iPad's steppers (redesign spec §0's vocabulary table).
 *
 * One word per thing, shared, because the front desk and the coordinator are counting the same
 * four things and a van that reads "Car seats" on one screen and "Car seats on board" on the
 * other is two vocabularies for one van. The list and the order live in src/config/equipment.ts;
 * these are the words for it.
 */
export const equipment = {
  seats: "Seats",
  wheelchair: "Wheelchair",
  carSeats: "Car seats",
  oxygen: "Oxygen",
  lift: "Lift",
  /**
   * The same four things as one *child's* need rather than a van's counter: a card's icons are
   * announced with these, so a chair icon is never the only way to know a child rides in one
   * (§0's copy rule 2, WCAG AA).
   */
  need: {
    wheelchair: "Wheelchair",
    carSeat: "Car seat",
    oxygen: "Oxygen",
    nurse: "Nurse",
  },
} as const;

/**
 * The plan board (redesign spec §1.5), which replaces the visible parts of `planRoutes` above.
 *
 * The rules this block is written to, from §0: labels are one to three words, a state is an icon
 * plus a word so it never relies on colour, numbers are big and words are small ("4/6", not
 * "4 of 6 seats used"), nothing explains a control that can explain itself, and every person and
 * van is named ("Marco D." drives "Van 1"). The whole `#drag` state comes to about 95 visible
 * words, most of them names and places — #58's screen had 607.
 */
export const planBoard = {
  /**
   * When a van leaves the centre on this leg (ledger #76): the schedule's default, or the time a
   * planner set for today. Every child's time on the van follows from it.
   */
  leaves: "Leaves",
  /** The time control's name for a screen reader: "Van 2 leaves at". */
  leavesLabel: "{van} leaves at",
  /** A child's estimated pickup (morning) or drop-off (afternoon), and their stop. */
  etaLine: "≈ {time} · {stop}",
  /** …and when that is past the family's window by the notify threshold. */
  etaLateLine: "≈ {time} (+{late} min) · {stop}",
  heading: "Plan routes",
  /** <title> for the route, so the tab says which screen is open. */
  documentTitle: `Plan routes · ${BRAND_NAME}`,
  /** The two legs of the day, as the segmented control says them. */
  morning: "Morning",
  afternoon: "Afternoon",
  /** "10 of 12 placed" — the one count in the toolbar. */
  placed: "{n} of {total} placed",
  unassigned: "Unassigned",
  /** The whole Unassigned list once nobody is left in it (§1.3 "All placed"). */
  allPlaced: "All placed",
  /**
   * The lane for the children the centre does not drive, and — since Vera's 390 pass of
   * 2026-10-18 — the **card's own subline** for one of them, in their lane or in a van a
   * coordinator put them in. It replaced "No pickup stop", which named a thing that was missing
   * instead of the arrangement a coordinator already knows about, and it is one label rather
   * than two so the lane and the card under it cannot drift apart.
   */
  familyDrives: "Family drives",
  absent: "Absent",
  /**
   * The child panel (founder 2026-10-17 7:17 PM ET): three Yes/No answers about what a child
   * needs, anchored to their card, and a Save that re-plans the leg.
   *
   * The labels are the shared equipment words, so the panel, the van meters and the ramp's
   * steppers all call a car seat the same thing.
   */
  child: {
    /** "Van 3 · Afternoon" — where this child is now, under their name. */
    where: "{van} · {leg}",
    /** The same line for a child in no van yet. */
    whereUnassigned: "Unassigned · {leg}",
    yes: "Yes",
    no: "No",
    save: "Save",
    /** Why a Save on a child's needs is not just a record change. Four words. */
    note: "Saving updates the plan",
    close: "Close",
    /** The front desk reads the same three answers and cannot change them. */
    readOnly: "Read only",
    /** The toast a move leaves behind: "Noah O. moved to Van 1". */
    moved: "{child} moved to {van}",
  },
  /** Every van on the board is "Van {n}": one generic van, numbered (conflict C1). */
  vanName: "Van {n}",
  /** The driver row's chip: the ramp confirmed this van today, or it did not. */
  checked: "Checked",
  notChecked: "Not checked",
  autoPlan: "Auto-plan",
  save: "Save",
  saving: "Saving…",
  /** "Saved 2:41 PM" — the server's own instant, in centre time. */
  saved: "Saved {time}",
  notSaved: "Not saved",
  saveFailed: "Couldn’t save · Retry",
  /** Somebody else saved while this board was open (§1.3, a version mismatch). */
  changedBy: "Changed by {name} · Reload",
  /**
   * The same chip when the server has no name to give — a plan saved by a session with no user
   * behind it, which is what the browser check signs in as. §1.5 only writes the named form, and
   * a board that filled the name in with a guess would be naming the wrong person.
   */
  changedAnon: "Someone else saved · Reload",
  /**
   * The line a Save gets when somebody else moved the plan on while this board was being built
   * (Firia, 2026-10-17 10:29 PM ET). The unsaved moves are **kept** — the board is still the
   * coordinator's draft — so the words ask for a reload rather than announcing a loss.
   */
  changedReload: "Plan changed, reload",
  overChip: "Full",
  undo: "Undo",
  /** The dashed target inside an empty van column. */
  dropHere: "Drop here",
  addVan: "Add van",
  stops: "{n} stops",
  minutes: "{n} min",
  /** The toast a drop leaves behind: "Mia R. → Van 2". */
  moved: "{child} → {van}",
  moveTo: "Move to…",
  /**
   * Why a van cannot take this child — one word on the column's chip, keyed by the fit rule's own
   * reason (src/config/equipment.ts), so a screen never has to translate a verdict.
   */
  reject: {
    SEAT: "Full",
    WHEELCHAIR: "Wheelchair",
    CAR_SEAT: "Car seat",
    OXYGEN: "Oxygen",
    LIFT: "Lift",
  },
  /**
   * THE ONE LINE A REFUSED DROP LEAVES ON THE CARD (Vera's taste spec, 2026-10-18).
   *
   * A refusal is not a toast: a toast is what a *move* leaves behind, it slides away after four
   * seconds, and the card a coordinator is looking at is where the answer belongs. So a drop that
   * a van refuses leaves the card exactly where it was with one coral line under it, naming the
   * van and the thing that is missing in four words at most — and the `rejectSr` sentence below
   * is still announced, so the ear gets the same refusal the eye does.
   *
   * One line per `RejectReason` (src/config/equipment.ts) and no other: no codes, no numbers, no
   * "see the chip". The van name is one word in the count, because "Van 1" is a name.
   *
   * There is no line for a nurse, because there is no nurse refusal to have: a nurse riding along
   * takes one of the van's seats (the `seats` counter's own `demandOf`), so a van that cannot
   * take the nurse is a van that is out of seats and says so.
   */
  rejectCard: {
    SEAT: "{van} seats full",
    WHEELCHAIR: "{van} wheelchair full",
    CAR_SEAT: "{van} car seats full",
    OXYGEN: "{van} oxygen full",
    LIFT: "No lift on {van}",
  },
  /** Announced when a drop is refused, so the refusal is not only a colour and a shape. */
  rejectSr: "{child} won’t fit {van}: no {thing}",
  /** The thing a refusal names, in the words a sentence needs rather than a chip. */
  rejectThing: {
    SEAT: "seat",
    WHEELCHAIR: "wheelchair spot",
    CAR_SEAT: "car seat",
    OXYGEN: "oxygen mount",
    LIFT: "lift",
  },
  /**
   * The one line about a van nobody has confirmed (Firia/Veri, 2026-10-17 6:00 PM ET): no
   * button, no "yesterday", no carry-over — the van is planned on the shared config's defaults
   * until the front desk confirms it at the ramp.
   *
   * It is said **once**, in the board's own banner beside "Check vans" (`flow.banner`, the same
   * sentence), and no longer on each van column — three columns said it three times for one
   * fact about the day (Vera on b3453cd, 2026-10-18). It stays here because this is the board's
   * copy block and the sentence is the board's; `src/app/plan-routes/board/lines.test.ts` holds
   * the two spellings of it to the one wording.
   */
  usingDefault: "Using default setup",
  /** "Seats 4/6" — a read-only count chip on a van column, one per counter (§1.2, 5:55 PM ET). */
  countChip: "{thing} {used}/{total}",
  /** Where a count chip goes when it is tapped: the ramp, on this van. */
  openRamp: "Count {van} at the ramp",
  seats: equipment.seats,
  wheelchair: equipment.wheelchair,
  carSeats: equipment.carSeats,
  oxygen: equipment.oxygen,
  lift: equipment.lift,
  fits: "{child} fits",
  wontFit: "{child} won’t fit",
  /**
   * The two stepper buttons are a − and a +, which explain themselves on the canvas (§0's rule 4)
   * and need a word for a screen reader: "Car seats fewer", "Car seats more".
   */
  fewer: "fewer",
  more: "more",
  /** A meter's own label for a screen reader: "4 of 6 seats". */
  meterSr: "{used} of {total} {thing}",
  mapLabel: "Route map",
  /** The one column a phone shows at a time is chosen here (§9.3 at 390 px). */
  columnSwitcher: "Which column?",
  /**
   * The Unassigned tab on that switcher, with how many are still waiting: "Unassigned · 2"
   * (png/plan-board-390.png). The word itself is `unassigned` above rather than written again
   * here, so the tab and the column it opens cannot come to say two different things.
   */
  switcherUnassigned: "{name} · {n}",
  /**
   * How a card is moved where there is no pointer (png/plan-board-390.png's own line). Holding
   * a card opens the `Move to…` control the card has had all along — the same one a right-click
   * opens on a wide screen — so this names the gesture rather than announcing a second control.
   */
  holdToMove: "Hold a card to move it",
} as const;

/**
 * The ramp iPad's van arrival (redesign spec §2): four steppers, a lift toggle, Confirm, and the
 * riders beside them.
 *
 * Every string is three or four words. What it replaces is the §4.4 checklist's own vocabulary —
 * the layout picker, the per-place Free / Out / Not sure answers, the LATCH row and the slot
 * matrix — all of which §2 removes in favour of counting what is on board.
 */
export const vanArrival = {
  /** The screen's own name, which the rail reads too — one string, so they cannot drift. */
  heading: rampIpad.heading,
  documentTitle: `Ramp iPad · ${BRAND_NAME}`,
  /** The card over the steppers: "What’s on Van 1?" */
  whatsOn: "What’s on {van}?",
  seats: equipment.seats,
  wheelchair: equipment.wheelchair,
  carSeats: equipment.carSeats,
  oxygen: equipment.oxygen,
  liftWorks: "Lift works",
  yes: "Yes",
  no: "No",
  /**
   * Under every counter: what the **saved plan** needs of this van for it, summed from the
   * planned riders' own needs (src/domain/plan/fit.ts `usedBy`).
   *
   * It supersedes `differsFrom` ("Default {n}"), which was written when nothing planned counts
   * (Firia's rule 1, 2026-10-17 5:48 PM ET) and so could only compare a count against the van's
   * config default. The ramp reads a saved plan now, so there is a planned number to name, and
   * naming it is what makes the amber value cell mean something a front desk can act on (Vera's
   * room list item 3, Firia's 7:59 AM ET plan).
   */
  planned: "Planned {n}",
  /** The van tabs: Van 1, Van 2, Van 3, with the time each leaves under its name. */
  leaves: "Leaves {time}",
  /** What the row of van tabs is, to a screen reader. */
  vansLabel: "Vans",
  ridersHeading: "Riders",
  fits: "Fits",
  /** The crit banner: "Mia R. won’t fit" over "1 car seat short". */
  wontFit: "{child} won’t fit",
  short: "{n} {thing} short",
  /** The lift is not a number, so its shortfall is said rather than counted. */
  noLift: "No lift",
  /**
   * What a van is short of, counted: "1 car seat short", "2 seats short". Pairs rather than an
   * "+s" rule, for the same reason `countable` above keeps them — a noun that does not pluralise
   * with an s has somewhere to go.
   */
  shortThing: {
    SEAT: { one: "seat", many: "seats" },
    WHEELCHAIR: { one: "wheelchair spot", many: "wheelchair spots" },
    CAR_SEAT: { one: "car seat", many: "car seats" },
    OXYGEN: { one: "oxygen mount", many: "oxygen mounts" },
    LIFT: { one: "lift", many: "lifts" },
  },
  /** Re-plan found no van that can carry them (ledger #76): nothing to approve, a family to call. */
  noVanCanTake: "No van fits {children} — call the family",
  replan: "Re-plan",
  confirm: "Confirm {van}",
  /** Said back once the write landed, so Confirm is not the only evidence of it. */
  confirmed: "Checked",
  /** Said once every van has been confirmed today (§9.3). */
  allChecked: "All vans checked",
  /**
   * The whole screen when this leg has no saved plan (Firia's ruling for S1): the ramp
   * never invents a plan by looking, so there is one line and one way out of it — `Plan routes`,
   * which is `flow.action.planRoutes` and not a second string for the same button.
   */
  noPlanSaved: "No plan saved",
  /** Who an observation is attributed to when the front desk counts a van themselves. */
  observedBy: "Ramp staff",
  /** A counter's own label for a screen reader, since the numbers are the big part. */
  counterSr: "{thing}: {n}",
} as const;


/*
 * `vanName(description)` — "the convertible van" — is gone with the screens that printed it.
 * A van has one name now and it comes from its slot: `vanNameOf` in src/config/vans.ts, which is
 * the single van-name helper the whole app uses (Firia's rule 6, 2026-10-17 5:48 PM ET).
 */

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
  /**
   * The database could not be reached, so there is no answer to give. Says that and nothing
   * about why: a connection error is not something a caller can act on, and the screen that
   * reads this shows its own "Couldn't load · Retry" inside the module (§9.3).
   */
  unavailable: "That couldn't be loaded. Try again.",
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
  /**
   * THE 10DLC FOOTER, AND WHERE IT IS NOT.
   *
   * It is not in a body. Firia, 2026-10-17 11:00 PM ET (S1-5): the STOP/HELP footer is appended
   * in the SEND STEP and nowhere else — `renderForSend` in src/modules/messaging/templates.ts,
   * which is what the provider calls. So the drafted text a coordinator approves, and the
   * bubbles in a thread, are the message itself; the proposal card shows this sentence as a
   * muted line underneath, which is what it is: the channel's furniture, not the words anybody
   * wrote (ProposalCard.tsx).
   *
   * The `[DEMO]` tag that used to end every body is gone outright (same ruling). The demo bar at
   * the top of every screen is where this deployment says it is a simulation; a tag inside a
   * family's text said it again, in the one place the words are supposed to read like a person
   * wrote them.
   */
  optOut: "Reply HELP for help, STOP to opt out.",
  /** The center's number as the copy guide writes it (COPY-GUIDE §5 dispatcher link). */
  centerPhone: "(561) 555-0100",
  /**
   * What `{childName}` reads as when the child's own row could not be named.
   *
   * The name is never a var and never anything anybody typed: it is read at render time from
   * `ops.child_profile.display_name`, the same way `{stopLabel}` is resolved through the fixed
   * table below (`src/modules/messaging/templates.ts`). With no row to read, the body says this
   * — the wording every body used before Firia's 10:51 PM ET ruling — rather than refusing to
   * send or leaving a hole in the sentence.
   */
  yourChild: "your child",
  /** The fixed answer to an inbound HELP: same words every time, no child name and no van detail. */
  helpReply:
    "PPEC: This number sends van updates for your child. Call us at {centerPhone} if you need help. Reply STOP to opt out.",
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
      "PPEC: Your child's van is on the way to {stopLabel}. Pickup {eta}.",
    "dropoff.eta":
      "PPEC: Your child's van home is on the way to {stopLabel}. Arrival {eta}.",
    /**
     * The one text PRD §18.2 step 7 sends: a van that has lost time, and the new 10-minute
     * window for the families still ahead of it.
     *
     * Why it is its own body rather than `dropoff.eta` with a later time in it: a family reading an
     * arrival window has no way to tell that it moved, and the whole point of the damped
     * notification is that something changed enough to be worth telling them about. So the news
     * is the news — minutes a person can act on ("about 15 minutes late") — and the lateness is
     * hedged with "about" because it is an estimate.
     *
     * **No time and no window** (Firia, 2026-10-17 10:51 PM ET: "The auto late text has no time
     * range and no ETA"). `dropoff.late` permits neither `eta` nor `etaEnd` any more, so there is
     * no way for a caller to put one back: a family is told the van is late and where the stop
     * still is, and the next thing they get is the arrival notice itself.
     */
    "dropoff.late":
      "PPEC: {childName}'s van home is running about {delayMinutes} minutes late. The drop-off is still at {stopLabel}.",
    /**
     * The late text a saved re-plan sends (ledger #73 reverses the no-ETA rule for this one body):
     * how late against the window the family was given, and the new drop-off time, both computed
     * from the saved plan. "about" because both are estimates.
     */
    "dropoff.late_eta":
      "PPEC: {childName}'s van home is running about {delayMinutes} minutes late. New drop-off about {eta} at {stopLabel}.",
    "leg.canceled":
      "PPEC: Got it. Your child's van on {legDate} is canceled. {reasonCode}",
    "leg.changed":
      "PPEC: Your child's van on {legDate} changed. New pickup {eta} at {stopLabel}.",
    /**
     * The afternoon's version of the line above. `leg.changed` says "New pickup", which is the
     * morning: a family whose *drop-off* moved and is told about a pickup has been told about the
     * wrong half of the day. Same vars, same rules, one word of difference — and the word is the
     * whole point (COPY-GUIDE §1: say the thing that happened).
     */
    /**
     * The answer to a parent who asked for a different drop-off, approved by a person.
     *
     * It opens with the answer and names the child (Firia, 2026-10-17 10:51 PM ET: "Model draft is
     * human and uses the child's name") — and it carries **no clock time**.
     *
     * The time came out on the COPY RULE (2026-10-18, p-rework-approvals5; Vera's S1-2 checklist
     * item b, "drafts contain no clock times"), which is the later word and wins over the 10:51 PM
     * example that still had one in it: *"drafted replies carry NO clock times (e.g. 'Yes, Jonah
     * gets off at Palm Beach State College today')"*. The mockup's own card already reads that way
     * (mockups/approvals.html `.prop .draft`: "Yes. Jonah gets off at Palm Beach State College
     * today.").
     *
     * The reason is not brevity. A minute in this sentence is a promise about traffic: the stop is
     * decided and the time is not, and a family told "at 5:00 PM" has been given an ETA by a
     * screen that carries no ETAs (Firia, 8:36 PM and 10:51 PM ET). What moved is *where*, so
     * that is what the text says; the day's own arrival notices are the things allowed a clock.
     *
     * `eta` stays in the outbox's var table for this template and is simply not placed — the same
     * shape `legDate` has had here all along. The vars are what the proposal *records*; the body
     * is what a family reads, and the two are allowed to differ in this direction (a placeholder
     * with no var is the error, and templates.test.ts is the door on that).
     */
    "dropoff.changed":
      "PPEC: Yes — {childName} gets off at {stopLabel} today.",
    /**
     * THE MODEL'S OWN REPLY to a parent who asked for a different drop-off — the body that is
     * nothing but the words somebody wrote (Firia, 2026-10-18 11:04 AM ET).
     *
     * The template above is a fixed sentence, and the founder's complaint is that it answers a
     * question the parent did not ask: Dara asked for five o'clock and the card confirmed a place.
     * So on this one path — a drop-off change a coordinator has to approve — the model that
     * proposes the change also writes the reply, and this body is how those words reach the same
     * renderer as every other text: one var, placed whole.
     *
     * It does not weaken "no free text to a family". §11.2's rule is free text *without human
     * approval*, and `replyText` is permitted on this template and on no other
     * (`outbox.TEMPLATE_VARS`), the template is sendable only by `approvals/decide.ts` after a
     * director or coordinator has pressed Approve on those exact words, and the shape of the var
     * itself is checked four times over (`messaging/reply-text.ts`). Every auto-send — the GPS
     * late notice, the HELP/STOP answers, the day's arrival notices — is still a fixed template
     * with code-shaped vars, and nothing the model writes can reach one.
     *
     * No `PPEC:` prefix, deliberately: the prefix is the machine's voice, and `reply-text.ts`
     * refuses a reply that carries one. The STOP/HELP footer is appended at send time as always
     * (`renderForSend`), so the words a coordinator approves are the words the family reads.
     */
    "dropoff.reply": "PPEC: {replyText}",
    /**
     * The afternoon's handoff, once the day has **recorded** one.
     *
     * Never on a geofence. PRD SURF-01 and COPY-GUIDE §2 are explicit that arriving is not being
     * received, and this body is sent from `receivedBy` — the custody event a person recorded
     * (`FINISHED_DAY_RIDES`) — and from nothing else. A van that has arrived and not handed over
     * says so on the board and sends a family nothing.
     *
     * No time in it: the handoff has happened, so there is nothing left to estimate, and this
     * screen carries no ETAs at all (Firia, 2026-10-17 8:36 PM and 10:51 PM ET).
     */
    "dropoff.received":
      "PPEC: {childName} is off the van at {stopLabel}.",
    "therapist.absence_alert":
      "PPEC: A child is not coming in today. The {sessionStart} session is affected.",
    "therapist.late_alert":
      "PPEC: A child is running late for the {sessionStart} session. Now expected {eta}.",
    "child.not_received":
      "PPEC: We could not hand off your child at {stopLabel} at {eta}. Please call us at {centerPhone}.",
    "center.closure": "PPEC: The center is closed on {date}. {reasonCode}",
    /**
     * Fixed copy, no vars (Veri #12): a staff-typed notice could carry a child's name, so the
     * only generic message we can send is the one that asks the family to call.
     */
    "generic.notice":
      "PPEC: There is an update about your child's transportation. Please call us at {centerPhone}.",
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
  /**
   * §11.2 human tier, `propose_dropoff_change`: a family asked for a different drop-off and the
   * assistant has drafted the text that would tell them it is done. AMBER rather than RED —
   * nothing is broken, a person simply has to say yes — and the next step names both answers,
   * because "don't send" is a real outcome and not a failure to act.
   */
  proposedDropoffChange: {
    summary: "A family asked for a different drop-off, and there is a text ready to send",
    nextStep: "Read the text the family would get, then approve and send it, or don't send it.",
    predicate: "the drop-off approved and the family told, or the request declined",
  },
  /**
   * §11.2 human tier as of Firia's S1-7 ruling (2026-10-18): `send_followup` and
   * `request_clarification`. A text to a family is drafted and waiting for a person.
   *
   * One sentence for both tools, because a coordinator is doing one thing either way — reading
   * the words and deciding whether they go — and two task summaries for one decision would be
   * the board telling them which tool the model picked, which is not a thing they call anything.
   */
  proposedFamilyMessage: {
    summary: "There is a text ready for a family, and nobody has sent it",
    nextStep: "Read the text the family would get, then approve and send it, or don't send it.",
    predicate: "the text approved and sent, or the request declined",
  },
  /** Ledger #74 (d): an action a person must confirm — the agent prepared it and changed nothing. */
  proposedStaffAction: {
    summary: "The agent prepared a change for you to confirm",
    nextStep: "Read what it would do, then confirm it or don't.",
    predicate: "the change confirmed or declined by a person",
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

/**
 * The "needs a person" alert — what staff see when the assistant could not reach a model at all.
 *
 * The founder's rule of 2026-10-17 5:28 PM ET, which overrides PRD §18.1 l.1200 ("LLM down →
 * keyword parser"): *"Never compensate with a deterministic text parser if the model isn't
 * available; the owner/staff need to be notified."* So there is no degraded reply to write copy
 * for. There is one card, and the card's whole job is to hand the text back to a human fast.
 *
 * Three rules shaped every string here:
 *
 *  - **Say what did not happen, not what went wrong.** "The assistant couldn't read it" is a fact
 *    a coordinator can act on. The failure class — a timeout, a 429 on both models, no key — is a
 *    deployment matter and goes in the server log (`agent/staff-alert.ts`), not on the card.
 *  - **Name the people** (COPY-GUIDE §1). "A parent texted about a child" is the sentence this
 *    card exists to avoid. The names are filled from the rows at render time through the shared
 *    display helpers (`identity/display-name.ts`), never written into a string here and never
 *    copied into the task row — the alert is a pointer to the message, not a second copy of it.
 *  - **End on the instruction.** "Reply yourself." is the whole of what is being asked, and it is
 *    last so a quick read still gets it.
 *
 * The parent's own words are *not* a template: they are rendered verbatim from `ops.message`
 * beside this copy, because a coordinator deciding whether this is urgent has to read what was
 * actually said. Nothing here paraphrases or summarizes them — summarizing is the thing the
 * assistant could not do.
 */
export const assistantUnavailable = {
  /** The card's own heading. Plural-safe because the badge can show more than one. */
  heading: "Needs you",
  /**
   * The sentence itself, filled from the rows: guardian first name + last initial, the child's
   * given name, and the leg word below. Three short sentences, in the order a coordinator needs
   * them: who and what, what happened, what to do.
   */
  card: "{adult} texted about {child}'s {leg}. The assistant couldn't read it. Reply yourself.",
  /**
   * The same card for a text we cannot tie to one child from the rows alone — a contact who is
   * authorized for two children, say. The child is left out rather than guessed at: choosing
   * between siblings would mean reading the message, which is the thing the rule forbids.
   */
  cardNoChild: "{adult} texted. The assistant couldn't read it. Reply yourself.",
  /** The plan would not take what a family asked for (ledger #80): what is in the way, then the fix link. */
  cardRefused: "{adult} texted about {child}'s {leg}. I couldn't plan it: {says}",
  cardRefusedNoChild: "{adult} texted. I couldn't plan it: {says}",
  /** A change a person approved that the plan then refused. */
  changeRefused: "An approved change didn't go through: {says} Nothing was sent.",
  /** A thread whose contact row has gone. Still true, still actionable, names nobody wrongly. */
  unknownAdult: "Someone",
  /**
   * Which ride the text is about, taken from the leg row's own direction — never from the
   * family's words, which is the parsing the founder's rule forbids. Singular, because the card
   * is about one leg; `planRoutes.direction` is the plural form the lane headings use.
   */
  legWord: { AM: "pick-up", PM: "drop-off" },
  /** No leg on the day the text arrived, so the sentence says the ride rather than invent a half. */
  legWordUnknown: "ride",
  /** Said above the family's own words, so nobody reads them as the assistant's. */
  theirWords: "What they wrote",
  /** Opens the thread this text arrived in. */
  openText: "Open text",
  /** Opens the reply box on that thread. A person writes it; nothing is drafted for them. */
  reply: "Reply",
  /**
   * The count beside "Exceptions & Approvals" in the rail. A number, with its own words for a
   * screen reader — §9, and Vera's rule that a badge may never be colour alone.
   */
  badgeLabel: "{count} waiting for a person",
  /** Shown once a staff member has opened the alert: it stays on the board, marked as taken. */
  openedBy: "Being handled",
  /**
   * The button that marks an alert taken — and the ONLY thing that marks it taken (Firia's S1-4,
   * 2026-10-18 12:13 AM ET).
   *
   * It used to happen on a GET: opening `/exceptions?alert=<id>` ran the UPDATE during the
   * render, so a link prefetch could claim an alert nobody had looked at, and a reload could
   * tell a second coordinator somebody was already on it. A state change needs a press.
   */
  take: "I'll handle this",
  /** The empty state, so a board with no alert does not read as a board that lost them. */
  none: "No texts are waiting for a person.",
  /**
   * The board could not be read at all. Distinct from `none` on purpose: "nothing is waiting" is
   * a claim about the families, and saying it when the truth is "we could not read the board"
   * tells a coordinator something false about their own day.
   */
  unreadable: "We couldn't read the board just now, so this list may be incomplete. Try again in a moment.",
  /** The thread panel "Open text" and "Reply" lead to. */
  threadHeading: "The text thread",
  /**
   * Said under the thread, because the reply box is not built yet and a button that looked like
   * one would be worse than saying so. The answer goes out the way it always has until then.
   */
  noReplyBox: "There's no reply box here yet. Answer this family from the center's phone.",
  /** One line under the card list, so the rule is on screen and not only in a commit message. */
  rule: "When the assistant can't reach its model, it does nothing and tells you. It never guesses.",
  /**
   * The `ops.task` row the alert *is*. Same summary / next step / predicate shape as every other
   * task on this board (`agentTasks` above), and like them it carries no family prose: the
   * summary says what kind of thing happened, and the words themselves stay in `ops.message`.
   */
  task: {
    summary: "A family text needs a person: the assistant could not reach its model",
    nextStep: "Read the text and answer the family yourself.",
    predicate: "a coordinator has read the text and answered the family",
  },
} as const;

/**
 * THE AGENT BUBBLE — the floating chat the founder asked for, on every screen inside the frame
 * (src/ui/AgentBubble.tsx, mounted once by src/ui/ConsoleShell.tsx).
 *
 * Vera's binding mockup is /workspace/ppec-redesign/mockups/agent-bubble.html and the four
 * png/agent-bubble-{closed,open}-{1440,390}.png shots. Everything a person reads in it is here,
 * and the rules the COPY-GUIDE puts on it are the ones the rest of this file follows: no vendor
 * and no model name, no "AI" label, no codes, and as few words as the screen can be read with.
 *
 * The closed button carries **no visible text** (the mockup draws a 56 px disc with an icon in
 * it), so `open` / `openWaiting` is its accessible name and the only way it is announced. The
 * count is in the name rather than left to the coral dot, for the same reason the tab bar's
 * badge is in its tab's name: a dot says nothing to a screen reader.
 */
/**
 * WHAT THE MODEL IS TOLD ABOUT ITS TOOLS — the function descriptions in every vendor request
 * (`agent/tools.ts` `description`, sent by `providers/remote.ts`).
 *
 * Not shown to anybody and never sent to a family: guidance about the job, in the prompt's own
 * vocabulary (tokens like F2 and C2, which the app turns back into first names). Here rather than
 * beside the tools because this file is the one owner of prose (`copy.test.ts`).
 */
export const agentGuidance = {
  /** The triage turn (ledger #85): one call, deciding whether the full agent needs to run. */
  classify:
    "Classify the family's newest text. PLAN_TODAY: it asks for or reports something that changes " +
    "today's rides (a time, a cancellation, an absence, someone not home). PLAN_LATER: the same for " +
    "another day. FYI: worth a coordinator seeing, but nothing to change (thanks, a note, a question " +
    "already answered). NOISE: nothing at all. Name the children it is about as the tokens above.",
  proposeDropoff:
    "Propose moving a child's drop-off time and/or stop because their family asked for it. Nothing " +
    "changes until a coordinator approves; then the plan moves and your reply is sent. Use this " +
    "when a family's message asks for a different drop-off time or place that you can name.",
  alertText:
    "One plain sentence for the coordinator saying what the family asked for. Write the guardian " +
    "as the family token and the child as the child token from the prompt; they are shown as first names.",
  reply:
    "The text message to the family, in your own words, sent only after a coordinator approves " +
    "it. Answer exactly what they asked; greet the guardian by the family token and name the child " +
    "by the child token from the prompt, which are replaced with first names before anyone reads " +
    "it. Warm, short, one or two sentences, no exclamation marks, codes or links.",
  getLegState: "Read one leg's current state, plan version, drop-off window and stop.",
  requestedStop:
    "Null when the family keeps their stop, which is the usual case. Only when they ask for a " +
    "different place: one of the listed stop tokens, exactly as written.",
  readGuardianThread: "Read the last messages on a family's thread, oldest first, to see exactly what they asked.",
  autoPlan:
    "Re-plan a leg: Auto-plan drafts a card listing who moves, their new times and whether every van fits; " +
    "the person approves it. Nothing is saved until they do. Put your one-sentence reason in note.",
  moveChild: "Move one child to a van, Unassigned, Absent or Family drives on a leg, and save it.",
  savePlan: "Apply several moves to a leg's plan and save them together.",
  confirmVan: "Record a van's counts and lift as the ramp found them today.",
  setNeeds: "Ask a person to confirm a change to a child's approved needs (a card; nothing changes until they press it).",
  restart: "Ask the director to confirm restarting the demo day (a card).",
  decideCard: "Ask a person to confirm approving or declining a waiting card (a card of its own).",
  takeAlert: "Take a needs-a-person alert so others know you're on it.",
  getPlan:
    "Read a leg's plan: when each van leaves, its counts, riders with their ≈ times, and who doesn't fit. " +
    "Pass preview to see what moves or new departure times would do — who fits, who gets home later — before you propose them.",
  getChild: "Read one child's day: their van, stop and ≈ time on each leg, their family's window, and their needs.",
  getWaiting: "Read what's waiting for a person: cards to approve and open alerts, with the labels to name them by.",
  readFamilyTexts: "Read a family's recent texts, oldest first, to see exactly what they said.",
  getActivity: "Read what happened today: plans saved, vans checked, alerts, cards approved or declined, texts sent.",
  proposePlanChange:
    "Change a leg's plan, as a card the person approves; nothing changes until they do. To plan the routes for a leg, " +
    "set auto_plan to whole_leg. To fix a van that no longer fits, set auto_plan to fix_fit: only the children who no " +
    "longer fit move. Or give moves and/or departures yourself. Every child's needs, stop and window are already on " +
    "file, so don't look children up first. The card shows who moves, the new times and whether every van fits.",
  autoPlanArg: "whole_leg: plan the leg from scratch (Auto-plan). fix_fit: the smallest change, only children who no longer fit (Re-plan).",
  proposeVanSetup: "Record a van's counts and lift as the ramp found them today, as a card the person approves.",
  cardNote: "One short sentence for the card: what changes and why, people as the prompt's tokens.",
  replyToStaff:
    "Answer like a coordinator would. Don't be robotic — be friendly and natural. " +
    "Write people as the prompt's tokens. This ends your turn: nothing runs after it, so do the work first " +
    "(draft the card) and say what you did or what's waiting for them — never that you'll do something next.",
  summarize:
    "Answer the coordinator, or leave them a note about a thread: one or two plain sentences, with " +
    "people written as the prompt's family and child tokens, which are shown as first names.",
} as const;

/**
 * WHAT EACH UI ACTION DOES, IN ONE LINE (modules/actions/registry.ts) — the words on a card that
 * asks a person to confirm an action the agent prepared, and the agent's own report of one it took.
 */
export const actionSummaries = {
  savePlan: "Save the {leg} plan ({count} moves).",
  autoPlan: "Re-plan the {leg} with Auto-plan and save it, so every van fits.",
  moveChild: "Move a child on the {leg} plan and save it.",
  /**
   * …and the same card once the board can say WHO and WHERE (Vera). A card that reads
   * "Move a child on the afternoon plan and save it." asks a coordinator to approve a change it
   * will not name: the card's own stored arguments hold the child and the van, so it says them.
   * The child is their first name, from the one name helper, as every other sentence about one
   * child is. The plain line above is still the fallback for a card whose child or van this
   * roster cannot name — a sentence with a hole in it is worse than a vague one.
   */
  moveChildTo: "Move {child} to {van}, {leg}.",
  confirmVan: "Confirm a van's setup as the ramp found it.",
  setNeeds: "Change a child's approved needs.",
  restart: "Restart the demo day.",
  approve: "Approve and send this reply.",
  decline: "Don't send this reply.",
  takeAlert: "Take this alert.",
  /** A confirm card for deciding another card: which one is on the card itself. */
  decideCard: "Decide a waiting card for you.",
  generic: "Make a change for you.",
} as const;

/** A confirm card in the bubble (ledger #74 d): a change the agent prepared, for a person to press. */
/**
 * A re-plan as a draft card (ledger #76, `actions/draft.ts`): what Auto-plan would change and what
 * that does to the day, generated from the plan. Approve saves it; nothing changes until then.
 */
/** Today's events as the agent reads them (`get_activity`, ledger #76). Plain facts, never sent anywhere. */
export const activityWords = {
  someone: "someone",
  agent: "the agent",
  planSaved: "{who} saved the {leg} plan",
  vanChecked: "{who} checked {van} at the ramp: {seats} seats, {wc} wheelchair, {cs} car seats, {ox} oxygen",
  alert: "alert: {what} ({state})",
  resolved: "resolved",
  open: "open",
  approved: "{who} approved \"{what}\"{impact}. {outcome}",
  declined: "{who} declined \"{what}\"",
  drafted: "{who} drafted \"{what}\"{impact}, waiting for approval",
  texted: "{count} families were texted a new drop-off time",
} as const;

export const replanDraft = {
  title: "Re-plan the {leg}",
  /** Auto-plan of a whole leg, from scratch (ledger #87): the board's Auto-plan button, as a card. */
  planTitle: "Plan the {leg}",
  moved: "{child}: {from} → {to} · ≈ {time}",
  movedLate: "{child}: {from} → {to} · ≈ {time} (+{late} min)",
  noVan: "no van",
  everyVanFits: "Every van fits",
  stillOver: "{vans} still doesn't fit",
  stillNeedsRide: "{children} still needs a ride — call the family",
  texted: "{families} would be texted the new time",
  family: { one: "family", many: "families" },
  /** A plan card that moves a van's departure (ledger #77). */
  changeTitle: "Change the {leg} plan",
  leaves: "{van} leaves {time} (was {was})",
  /** A time agreed with a family (ledger #79): the van waits at their stop, or their stop moves. */
  waits: "{van} waits for {child} until {time}",
  afterAgreed: "{child} ≈ {time}, {late} min after the agreed time",
  /** A child the change puts outside the range their family agreed (ledger #84). */
  outsideSlot: "{child} ≈ {time}, outside the family's {start}–{end}",
  noVanNamed: "There's no {van} on the {leg} today",
} as const;

export const confirmCopy = {
  heading: "Confirm a change",
  /** The note a stale agent plan card leaves on For you (Vera): its line is `refusal.says.STALE_CARD`. */
  staleNoteDismiss: "Dismiss",
  confirm: "Approve",
  /**
   * WHAT "DON'T" DECLINES (Vera). The button read "Don't", which beside Approve is a
   * word and not an answer: a person reading a card quickly has to look back up to find out what
   * they are refusing, and a one-word refusal next to a one-word approval is the shape of a
   * misclick. So the verb of the card's own action is on it — "Don't move", "Don't re-plan" —
   * picked by tool in `actions/summary.ts staffActionDecline`, the same switch that writes the
   * card's line, so the two cannot name different actions. A reply card says "Don't send"
   * (`approval.dontSend`), which is this rule and already was.
   */
  dont: {
    savePlan: "Don't save",
    autoPlan: "Don't re-plan",
    moveChild: "Don't move",
    confirmVan: "Don't confirm",
    setNeeds: "Don't change",
    restart: "Don't restart",
    decideCard: "Don't decide",
    takeAlert: "Don't take",
    /** A tool with no verb of its own: still says what it is refusing, which is the change. */
    generic: "Don't make the change",
  },
  pending: "Nothing happens until you approve.",
  done: "Done.",
  declined: "Not done. Nothing changed.",
  /**
   * The line a confirmed plan card leaves in the thread (ledger #75 c), from the board after the
   * save and the texts it queued (`actions/outcome.ts`): "Done. Every van fits, and 2 families
   * were texted a new time."
   */
  doneFit: "Done. {fit}.",
  doneTexted: "Done. {fit}, and {count} families were texted a new time.",
  everyVanFits: "Every van fits",
  stillOver: "{vans} still doesn't fit",
  /** A plan card the board was saved past before anyone pressed it: nothing to do here any more. */
  alreadyHandled: "Already handled on the board.",
  signIn: "Your sign-in has expired. Sign in again and the card is still here.",
  notYourRole: "Your role cannot do this one. Ask the director.",
  gone: "That card is not here any more.",
  alreadyDecided: "Somebody decided this one already.",
  refused: "That couldn't be done as it stands, so nothing changed. Ask the agent again.",
} as const;

/** A van confirmed at the ramp that no longer carries its riders (ledger #74 e, plan/van-short.ts). */
/**
 * WHY A CHANGE COULD NOT BE MADE (ledger #80), one plain sentence per reason the board's writer
 * gives (`modules/changes/refusal.ts`), and the one place to go and fix it. Filled with the van
 * and child the refusal names; a sentence that would need a name nobody has uses `OTHER`.
 */
export const refusal = {
  says: {
    NOT_STARTED: "The {leg} plan isn't started yet.",
    CHANGED: "Someone changed the {leg} plan a moment ago.",
    NOT_THIS_DAY: "{child} isn't on the {leg} plan today.",
    BUCKET_NOT_HERE: "{child} is marked away or driven by family on the {leg} plan.",
    ABOARD: "{child} is already on {van}.",
    SEAT: "{van} is out of seats.",
    WHEELCHAIR: "{van} has no wheelchair space left.",
    LIFT: "{van} has no lift.",
    OXYGEN: "{van} has no oxygen mount free.",
    CAR_SEAT: "{van} has no car seat free.",
    NO_CONTACT: "Nobody on {child}'s file can receive them.",
    /** A route that would get a child home outside the time their family agreed (ledger #84). */
    OUTSIDE_SLOT: "{child} would miss the time their family agreed.",
    OTHER: "The {leg} plan wouldn't take this change.",
    /** An agent plan card the board moved past, or one that never named its board (Vera, 2026-10-19). */
    STALE_CARD: "{child}'s plan changed after this card was written.",
    STALE_CARD_NO_CHILD: "The {leg} plan changed after this card was written.",
  },
  fix: { van: "Fix {van}", child: "Open {child}'s family", plan: "Open the {leg} plan", planRoutes: "Open Plan routes" },
  legWord: { AM: "morning", PM: "afternoon" },
  aVan: "a van",
  aChild: "a child",
} as const;

/** The agent hears a van running late (ledger #79): the live sweep has texted these families. */
export const runningLateAlert = {
  summary: "Running about {minutes} min late: {who} — families texted",
  nextStep: "See whether a wait, a swap or a text to another family would help.",
  predicate: "the late rides are home",
} as const;

export const vanShortAlert = {
  /** "Van 1 no longer fits Ava N. this morning": who, by the ramp's own fit rule (van-short.ts). */
  summary: "{van} no longer fits {who} this {leg}",
  /** `who` when the rule names nobody one by one (the van is over as a whole). */
  itsRiders: "its riders",
  nextStep: "Re-plan the leg so every van fits, or change who rides in it.",
  predicate: "every van on the leg fits its riders again",
} as const;

/**
 * One quiet line per step while the agent works (ledger #87), by tool. Fixed words: what a step
 * is doing, never what the model wrote. Anything not listed reads as `default`.
 */
export const agentSteps = {
  get_activity: "Checking today's activity…",
  get_plan: "Reading the {leg} plan…",
  get_child: "Looking at a child's day…",
  get_waiting: "Checking what's waiting…",
  read_family_texts: "Reading a family's texts…",
  propose_plan_change: "Drafting a plan card…",
  card: "Drafting a card…",
  default: "Thinking…",
} as const;

export const agentBubble = {
  /** The closed button's accessible name with nothing waiting (agent-bubble.html, `.fab`). */
  open: "Agent",
  /** …and with proposals waiting, which is what the coral dot means for the eye. */
  openWaiting: "Agent, {count} waiting",
  /** …and with something new in the thread since the panel was last open (ledger #75 b). */
  openNew: "Agent, something new",
  /** The panel's heading, and its dialog label. */
  title: "Transport Agent",
  /** The 44 px X at the top right of the panel and of the phone sheet. */
  close: "Close",
  /** The day separator above the thread. The thread is the same one "For you" shows. */
  today: "Today",
  /** Who said it, above a driver's grey bubble: "Marcus L. · Van 1". */
  speaker: "{name} · Van {van}",
  /** The compose bar, pinned to the foot of the panel, and its round teal button. */
  ask: "Ask the agent…",
  send: "Send",
  /**
   * The compact proposal card (mockups/family-texts.html, `.prop`) carries ONE amber chip, not
   * the mockup's Approve · Edit · Skip row (Firia and Vera, 2026-10-18 9:17 AM ET). Acting in
   * place is a write, the write path is #75's, and a button that cannot write is a worse answer
   * than a chip that says where the decision is made.
   *
   * And the chip is PLAIN TEXT — a `<span>`, no link (Firia, 2026-10-18 9:21 AM ET, overriding the
   * 9:17 reading). These two words are a statement of where the proposal stands, not an offer to
   * go anywhere: a link out of the panel still reads as the thing to press, and what it would
   * reach is the decide path #75 is rebuilding. The words become a control again, beside the three
   * that come back, when #75 merges.
   */
  needsApproval: "Needs approval",
  /**
   * THE NAMED LINE ON A WAITING DROP-OFF PROPOSAL — and, since Firia's 11:15 AM ET ruling of
   * 2026-10-18, **the fallback rather than the line**.
   *
   * What words a proposal now is the model's own sentence, written in the
   * `propose_dropoff_change` call that raised it (`alert_text`, agent/alert-text.ts) and stored on
   * the task and the proposal row. A coordinator reading an alert is reading what the thing that
   * read the family's text has to say about it, not a sentence this app assembled about the row.
   *
   * This line is what the row says when **no model wrote one**: the demo seed, and a deployment
   * whose model is down. It replaces the old general "A family asked for a different drop-off"
   * ({@link agentTasks.proposedDropoffChange}) everywhere, the board row included — the 11:13
   * reading, which kept the general sentence on the board, did not survive the 11:15 one, and
   * nothing words a drop-off proposal with that row any more.
   *
   * Every value is a *structured field of the proposal row*: the parent and the child are tokens
   * through the one name helper (`identity/names.firstNameOfToken`), the time is
   * `requested_dropoff_time` through `sayClock`. Nothing here is read out of anybody's words.
   */
  dropoffWaiting: "{parent} asked to move {child}'s drop-off to {time}. Your reply is ready.",
  /** The same sentence for a proposal that moves only the place: there is no time to say. */
  dropoffWaitingNoTime: "{parent} asked to move {child}'s drop-off. Your reply is ready.",
  /**
   * …and with nobody nameable. A proposal whose child this roster cannot name still has to say
   * what is waiting, and it says it without a token: a code on a screen is the one outcome §9
   * forbids outright, so the names come out of the sentence rather than the sentence showing "C2".
   *
   * It is deliberately NOT the old "A family asked for a different drop-off" row
   * ({@link agentTasks.proposedDropoffChange}), which no longer words any drop-off proposal
   * anywhere (Firia, 11:15 AM ET): that line said a family had asked and that somebody must go
   * and find the reply, which is both vaguer and less true than this one.
   */
  dropoffWaitingUnnamed: "A drop-off change is waiting, and your reply is ready.",
  /**
   * …and the card's one control, which is a **button again** as of the same ruling, replacing the
   * plain-text chip of 9:21 AM. What changed is that there is now somewhere honest for it to go:
   * it opens that parent's own Family texts thread, where the drafted reply and the decision both
   * live. It is still not an Approve — pressing it decides nothing — so the words say what it
   * does, which is show you the reply.
   */
  reviewReply: "Review reply",
  /**
   * The grey reply under an ask nobody could answer (Firia and Vera, 2026-10-18 9:17 AM ET). One
   * line, and it is the whole of the degraded mode in the panel: it says what is true — no answer
   * — and never why, because every why is a vendor, a key or an outage. There is no keyword
   * fallback behind it; a sentence assembled from the words of the question would be the panel
   * pretending to have understood it. The staff alert the server raises is unchanged and says the
   * rest ({@link agentAsk.unavailable}).
   */
  noAnswer: "I couldn't answer that just now, so it's on your list as an alert.",
  /** Under an ask whose run is still on the queue (ledger #74): replaced by the answer when it lands. */
  working: "Working on it…",
  /** A family's text the agent heard (ledger #79), in the family's own words. */
  familyTexted: "{children}'s family texted: “{text}”",
  familyTextedUnnamed: "A family texted: “{text}”",
  textNotRead: "I couldn't answer that one, so it's on Family texts for you.",
  /** A change the plan would not take (ledger #80): what is in the way, then the fix link. */
  blocked: "I couldn't make that change: {says} It's on Family texts for you.",
  /**
   * An alert the agent heard and could not answer (ledger #75): the situation, from the alert's own
   * row, and that no fix came — followed by the board's Re-plan link. Never the reason the model
   * was unreachable: that is for the log, and the person needs the day, not the vendor.
   */
  couldNotFix: "{situation}. I couldn't find a fix.",
  /** The link after it: the board, on that leg, with that van selected. */
  replanLink: "Re-plan",
  /** The model ran and proposed a change but wrote no answer line: the card below is the answer. */
  proposedBelow: "I've drafted a change for you to review.",
  /** Nothing has been said today. The thread shows what exists and never invents a message. */
  empty: "Nothing yet today.",
} as const;

/**
 * A STAFF ASK, as the rows it writes read on the board (src/modules/agent/ask/staff-ask.ts).
 *
 * An ask typed into the bubble is recorded before anything is driven, because it is the thing
 * that happened and the run's identity is that row's id. It lands as an `ops.task` — the one
 * staff-visible queue this app has — in the same summary / next step / predicate shape as every
 * other agent task above, so a coordinator reads it the same way.
 *
 * `unavailable` is the **staff alert** of docs/DATA-MODEL.md: kind NEEDS_PERSON, severity RED,
 * raised when no model can be reached. There is no keyword parser behind it and no proposal on
 * it — the whole of the degraded mode is that a person is asked to do the thing themselves.
 *
 * The two *notice* lines that used to live here are gone (Firia and Vera, 2026-10-18 9:17 AM ET):
 * what the panel says back is now said in the thread, where the question was asked — the teal
 * bubble for every ask, and {@link agentBubble.noAnswer} under the ones nobody could answer. A
 * status line above the field saying one thing while the thread said another was two answers to
 * one question.
 */
export const agentAsk = {
  /** The ask itself: open work until the agent or a person answers it. */
  asked: {
    summary: "Somebody asked the assistant to do something",
    nextStep: "Read the ask, and do it yourself if the assistant has not.",
    predicate: "the ask answered, by the assistant or by a coordinator, and the outcome recorded",
  },
  /**
   * The staff alert. The words say what is true — nobody could answer — and not why, because the
   * why is a vendor, a key or an outage and none of those is a coordinator's to read.
   */
  unavailable: {
    summary: "Nobody could answer an ask here, so it needs a person",
    nextStep: "Do the thing that was asked, or reply to the family yourself.",
    predicate: "a coordinator has done what was asked and recorded it",
  },
  /**
   * WHAT THE PANEL SAYS WHEN NO MODEL WILL ANSWER (Firia and Vera, 2026-10-18 11:13 AM ET,
   * replacing {@link agentBubble.noAnswer} on this path).
   *
   * "I can't answer right now." was true and useless: the app knew perfectly well what the open
   * alert was about — it had written the row — and said nothing. So the degraded answer is **what
   * the app knows from the task row itself**, and the whole of the rule is where those words come
   * from:
   *
   *  - the parent, the child and the fact that a drop-off move was asked for are *structured
   *    fields* of the proposal row (`child_token`, `requested_dropoff_time`, the family behind the
   *    child), read as columns and named through the one name helper;
   *  - **nothing is parsed out of anybody's text.** There is no keyword reader and no regex over a
   *    family's words on this path or any other (founder's rule, 2026-10-17;
   *    `agent/no-keyword-fallback.test.ts`). A sentence assembled from the words of the question
   *    would be the panel pretending to have understood it; a sentence assembled from its own
   *    columns is the panel telling you what it filed.
   *  - it does not say the time. The time is on the alert card right above it
   *    ({@link agentBubble.dropoffWaiting}); saying it twice in two voices is how a screen ends up
   *    disagreeing with itself.
   *
   * And it ends by naming where the answer is, because the one thing this deployment can still do
   * for a coordinator is take them to the thread. `openThread` is that action's label — a link to
   * the parent's own Family texts thread, the same destination the alert card's button has.
   *
   * The staff alert is raised exactly as before: this is what the panel says, not instead of what
   * the board records.
   */
  fromTheRow: "{parent} asked to move {child}'s drop-off. Open {parent}'s thread to see it.",
  /**
   * The same sentence with nothing open to name — an ask typed when the board is clear. It says
   * the one true thing (nobody answered, it is on your list) and invents no subject for it.
   *
   * It is deliberately not {@link agentBubble.noAnswer}: that line said only that there was no
   * answer, and this one says what happened to the question instead.
   */
  fromTheRowPlain: "Nobody could answer that here, so it is on your list.",
  /** The action beside both, and the alert card's destination: that parent's own thread. */
  openThread: "Open the thread",
} as const;
